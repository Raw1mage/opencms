/**
 * LanguageModelV2 adapter for copilot-cli (DD-9: minimal AI SDK surface).
 *
 * Only imports types from @ai-sdk/provider — no runtime dependency.
 * Bridges our raw HTTP client (client.ts) to the LanguageModelV2 interface
 * required by OpenCMS's runloop (session/llm.ts).
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2FinishReason,
  LanguageModelV2CallWarning,
} from "@ai-sdk/provider"
import {
  streamCompletions,
  callCompletions,
  type CompletionsChunk,
} from "./client"
import { shouldUseResponsesApi } from "./models"

let idCounter = 0
function nextId(): string {
  return `copilot-cli-${++idCounter}`
}

function mapFinishReason(reason: string | null): LanguageModelV2FinishReason {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "content_filter":
      return "content-filter"
    case "tool_calls":
      return "tool-calls"
    default:
      return "other"
  }
}

// ---------------------------------------------------------------------------
// Convert AI SDK prompt to OpenAI messages format
// ---------------------------------------------------------------------------

function promptToMessages(prompt: LanguageModelV2CallOptions["prompt"]): any[] {
  const messages: any[] = []
  for (const msg of prompt) {
    if (msg.role === "system") {
      const text = msg.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")
      messages.push({ role: "system", content: text })
    } else if (msg.role === "user") {
      const parts: any[] = []
      for (const p of msg.content) {
        if (p.type === "text") {
          parts.push({ type: "text", text: p.text })
        } else if (p.type === "file") {
          if ("data" in p && typeof p.data === "string" && p.mediaType?.startsWith("image/")) {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${p.mediaType};base64,${p.data}` },
            })
          }
        }
      }
      messages.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts })
    } else if (msg.role === "assistant") {
      const toolCalls: any[] = []
      let text = ""
      for (const p of msg.content) {
        if (p.type === "text") text += p.text
        else if (p.type === "tool-call") {
          toolCalls.push({
            id: p.toolCallId,
            type: "function",
            function: {
              name: p.toolName,
              arguments: typeof p.args === "string" ? p.args : JSON.stringify(p.args),
            },
          })
        }
      }
      const m: any = { role: "assistant" }
      if (text) m.content = text
      if (toolCalls.length > 0) m.tool_calls = toolCalls
      messages.push(m)
    } else if (msg.role === "tool") {
      for (const p of msg.content) {
        if (p.type === "tool-result") {
          messages.push({
            role: "tool",
            tool_call_id: p.toolCallId,
            content: typeof p.output === "string" ? p.output : JSON.stringify(p.output),
          })
        }
      }
    }
  }
  return messages
}

function toolsToOpenAI(tools: LanguageModelV2CallOptions["tools"]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter((t: any) => t.type === "function")
    .map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
}

// ---------------------------------------------------------------------------
// The Adapter
// ---------------------------------------------------------------------------

export function createCopilotCLIModel(modelId: string): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "copilot-cli",
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV2CallOptions) {
      const messages = promptToMessages(options.prompt)
      const tools = toolsToOpenAI(options.tools)
      const warnings: LanguageModelV2CallWarning[] = []

      const result = await callCompletions(
        {
          model: modelId,
          messages,
          tools,
          temperature: options.temperature ?? undefined,
          max_tokens: options.maxOutputTokens ?? undefined,
        },
        { model: modelId },
      )

      const content: any[] = []
      if (result.content) {
        content.push({ type: "text", text: result.content, id: nextId() })
      }
      for (const tc of result.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallType: "function",
          toolCallId: tc.id,
          toolName: tc.function?.name,
          args: tc.function?.arguments ?? "{}",
          id: nextId(),
        })
      }

      return {
        content,
        finishReason: mapFinishReason(result.finishReason),
        usage: {
          inputTokens: result.usage.promptTokens,
          outputTokens: result.usage.completionTokens,
        },
        warnings,
      }
    },

    async doStream(options: LanguageModelV2CallOptions) {
      const messages = promptToMessages(options.prompt)
      const tools = toolsToOpenAI(options.tools)
      const warnings: LanguageModelV2CallWarning[] = []

      const useResponses = shouldUseResponsesApi(modelId)

      // For now, stream via completions API (responses API adapter comes in a future phase)
      const chunks = streamCompletions(
        {
          model: modelId,
          messages,
          tools,
          temperature: options.temperature ?? undefined,
          max_tokens: options.maxOutputTokens ?? undefined,
        },
        { model: modelId },
      )

      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
          let textId: string | null = null
          const toolCallIds = new Map<number, string>() // index → id
          const toolCallNames = new Map<number, string>()
          let promptTokens = 0
          let completionTokens = 0
          let finishReason: LanguageModelV2FinishReason = "other"

          controller.enqueue({ type: "stream-start", warnings })

          try {
            for await (const chunk of chunks) {
              const choice = chunk.choices?.[0]
              if (!choice) continue

              const delta = choice.delta

              // Text content
              if (delta.content) {
                if (!textId) {
                  textId = nextId()
                  controller.enqueue({ type: "text-start", id: textId })
                }
                controller.enqueue({ type: "text-delta", id: textId, delta: delta.content })
              }

              // Tool calls
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index
                  if (tc.id && !toolCallIds.has(idx)) {
                    // Close text if open
                    if (textId) {
                      controller.enqueue({ type: "text-end", id: textId })
                      textId = null
                    }
                    const id = nextId()
                    toolCallIds.set(idx, id)
                    toolCallNames.set(idx, tc.function?.name ?? "")
                    controller.enqueue({
                      type: "tool-input-start",
                      id,
                      toolName: tc.function?.name ?? "",
                    })
                  }
                  if (tc.function?.arguments) {
                    const id = toolCallIds.get(idx)!
                    controller.enqueue({
                      type: "tool-input-delta",
                      id,
                      delta: tc.function.arguments,
                    })
                  }
                }
              }

              // Finish
              if (choice.finish_reason) {
                finishReason = mapFinishReason(choice.finish_reason)
              }

              // Usage (often in the last chunk)
              if (chunk.usage) {
                promptTokens = chunk.usage.prompt_tokens
                completionTokens = chunk.usage.completion_tokens
              }
            }

            // Close open text
            if (textId) {
              controller.enqueue({ type: "text-end", id: textId })
            }

            // Close open tool calls
            for (const [, id] of toolCallIds) {
              controller.enqueue({ type: "tool-input-end", id })
            }

            // Finish event
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: promptTokens,
                outputTokens: completionTokens,
              },
              finishReason,
              providerMetadata: undefined,
            })
          } catch (err) {
            controller.error(err)
            return
          }

          controller.close()
        },
      })

      return { stream }
    },
  }
}
