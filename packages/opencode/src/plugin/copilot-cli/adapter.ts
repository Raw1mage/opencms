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
  streamResponses,
  callCompletions,
  type CompletionsChunk,
  type ResponsesChunk,
} from "./client"
import { shouldUseResponsesApi } from "./models"
import { Log } from "../../util/log"

const log = Log.create({ service: "copilot-cli.adapter" })

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
// Helpers
// ---------------------------------------------------------------------------

/** Normalize tool result output to a plain string. AI SDK may pass string, array, object, or undefined. */
function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output || "{}"
  if (output == null) return "{}"
  // AI SDK streamText sends output as [{ type: "text", text: "..." }, ...] array
  if (Array.isArray(output)) {
    const texts = output
      .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
      .map((p: any) => p.text)
    if (texts.length > 0) return texts.join("\n")
    return JSON.stringify(output)
  }
  // Object with .text property
  if (typeof output === "object" && "text" in (output as any)) return String((output as any).text)
  return JSON.stringify(output)
}

// ---------------------------------------------------------------------------
// Convert AI SDK prompt to Responses API input format
// ---------------------------------------------------------------------------

function promptToResponsesInput(prompt: LanguageModelV2CallOptions["prompt"]): any[] {
  const input: any[] = []
  for (const msg of prompt) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
          : String(msg.content ?? "")
      input.push({ role: "system", content: text })
    } else if (msg.role === "user") {
      const parts: any[] = []
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }]
      for (const p of content) {
        if (p.type === "text") {
          parts.push({ type: "input_text", text: p.text })
        } else if (p.type === "file") {
          if ("data" in p && typeof p.data === "string" && p.mediaType?.startsWith("image/")) {
            parts.push({ type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}` })
          }
        }
      }
      input.push({ role: "user", content: parts })
    } else if (msg.role === "assistant") {
      // Responses API: text goes in { role: "assistant", content: [{type: "output_text"}] }
      // but function_call is a TOP-LEVEL input item, NOT nested in content
      const textParts: any[] = []
      const aContent = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : []
      for (const p of aContent) {
        if (p.type === "text") {
          textParts.push({ type: "output_text", text: p.text })
        } else if (p.type === "tool-call") {
          // Flush text first if any
          if (textParts.length > 0) {
            input.push({ role: "assistant", content: [...textParts] })
            textParts.length = 0
          }
          // function_call is top-level — arguments MUST be a non-empty string
          input.push({
            type: "function_call",
            call_id: p.toolCallId,
            name: p.toolName,
            arguments: typeof p.args === "string" ? (p.args || "{}") : JSON.stringify(p.args ?? {}),
          })
        }
      }
      if (textParts.length > 0) {
        input.push({ role: "assistant", content: textParts })
      }
    } else if (msg.role === "tool") {
      // function_call_output is also top-level
      const tContent = Array.isArray(msg.content) ? msg.content : []
      for (const p of tContent) {
        if (p.type === "tool-result") {
          input.push({
            type: "function_call_output",
            call_id: p.toolCallId,
            output: stringifyOutput(p.output),
          })
        }
      }
    }
  }
  return input
}

// ---------------------------------------------------------------------------
// Convert AI SDK prompt to Chat Completions messages format
// ---------------------------------------------------------------------------

function promptToMessages(prompt: LanguageModelV2CallOptions["prompt"]): any[] {
  const messages: any[] = []
  for (const msg of prompt) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
          : String(msg.content ?? "")
      messages.push({ role: "system", content: text })
    } else if (msg.role === "user") {
      const parts: any[] = []
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }]
      for (const p of content) {
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
      const aContent = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : []
      for (const p of aContent) {
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
      const tContent = Array.isArray(msg.content) ? msg.content : []
      for (const p of tContent) {
        if (p.type === "tool-result") {
          messages.push({
            role: "tool",
            tool_call_id: p.toolCallId,
            content: stringifyOutput(p.output),
          })
        }
      }
    }
  }
  return messages
}

/** Extract JSON Schema from AI SDK tool.
 *  AI SDK v5 passes inputSchema as a Schema wrapper object with a .jsonSchema getter.
 *  In compiled binaries, Symbol identity can break causing asSchema() to produce empty schemas.
 *  We unwrap defensively: try .jsonSchema getter first, then fall back to raw object.
 */
/** Lazily imported rawToolSchemas from resolve-tools.ts */
let _rawSchemas: Map<string, Record<string, unknown>> | null = null
async function getRawSchemas() {
  if (!_rawSchemas) {
    try {
      const mod = await import("../../session/resolve-tools")
      _rawSchemas = mod.rawToolSchemas
    } catch {
      _rawSchemas = new Map()
    }
  }
  return _rawSchemas
}

function getToolSchema(t: any): any {
  const raw = t.inputSchema ?? t.parameters
  if (raw == null) return { type: "object", properties: {} }

  // Try unwrap Schema wrapper .jsonSchema getter
  if (typeof raw === "object" && "jsonSchema" in raw) {
    const unwrapped = typeof raw.jsonSchema === "function" ? raw.jsonSchema() : raw.jsonSchema
    if (unwrapped && typeof unwrapped === "object" && Object.keys(unwrapped.properties ?? {}).length > 0) {
      return unwrapped
    }
  }

  // Raw object with properties
  if (raw.properties && Object.keys(raw.properties).length > 0) {
    if (!raw.type) raw.type = "object"
    return raw
  }

  return { type: "object", properties: {} }
}

/** Get tool schema with side-channel fallback for bun compiled binary Symbol breakage */
async function getToolSchemaWithFallback(t: any): Promise<any> {
  const schema = getToolSchema(t)
  if (Object.keys(schema.properties ?? {}).length > 0) return schema

  // Fallback: read from rawToolSchemas side-channel (populated by resolve-tools.ts)
  const registry = await getRawSchemas()
  const raw = registry.get(t.name)
  if (raw && typeof raw === "object" && Object.keys((raw as any).properties ?? {}).length > 0) {
    if (!(raw as any).type) (raw as any).type = "object"
    return raw
  }

  return schema
}

/** Chat Completions format: { type: "function", function: { name, description, parameters } } */
async function toolsToCompletions(tools: LanguageModelV2CallOptions["tools"]): Promise<any[] | undefined> {
  if (!tools || tools.length === 0) return undefined
  return Promise.all(
    tools
      .filter((t: any) => t.type === "function")
      .map(async (t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: await getToolSchemaWithFallback(t),
        },
      }))
  )
}

/** Responses API format: { type: "function", name, description, parameters } — flat, no nested function object */
async function toolsToResponses(tools: LanguageModelV2CallOptions["tools"]): Promise<any[] | undefined> {
  if (!tools || tools.length === 0) return undefined
  return Promise.all(
    tools
      .filter((t: any) => t.type === "function")
      .map(async (t: any) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: await getToolSchemaWithFallback(t),
      }))
  )
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
      const warnings: LanguageModelV2CallWarning[] = []
      const useResponses = shouldUseResponsesApi(modelId)

      if (useResponses) {
        const input = promptToResponsesInput(options.prompt)
        const tools = await toolsToResponses(options.tools)
        let text = ""
        let inputTokens = 0
        let outputTokens = 0
        let reason: LanguageModelV2FinishReason = "other"
        const toolCalls: any[] = []

        for await (const chunk of streamResponses(
          { model: modelId, input, tools, temperature: options.temperature ?? undefined, max_output_tokens: options.maxOutputTokens ?? undefined },
          { model: modelId },
        )) {
          if (chunk.type === "response.output_text.delta") text += chunk.delta ?? ""
          else if (chunk.type === "response.completed") {
            const resp = chunk.response
            inputTokens = resp?.usage?.input_tokens ?? 0
            outputTokens = resp?.usage?.output_tokens ?? 0
            reason = resp?.status === "completed" ? "stop" : "other"
            for (const item of resp?.output ?? []) {
              if (item.type === "function_call") {
                toolCalls.push({ id: item.call_id, function: { name: item.name, arguments: item.arguments } })
              }
            }
          }
        }

        const content: any[] = []
        if (text) content.push({ type: "text", text, id: nextId() })
        for (const tc of toolCalls) {
          content.push({ type: "tool-call", toolCallType: "function", toolCallId: tc.id, toolName: tc.function?.name, args: tc.function?.arguments ?? "{}", id: nextId() })
        }
        return { content, finishReason: reason, usage: { inputTokens, outputTokens }, warnings }
      }

      // Chat Completions path
      const messages = promptToMessages(options.prompt)
      const tools = await toolsToCompletions(options.tools)
      const result = await callCompletions(
        { model: modelId, messages, tools, temperature: options.temperature ?? undefined, max_tokens: options.maxOutputTokens ?? undefined },
        { model: modelId },
      )

      const content: any[] = []
      if (result.content) content.push({ type: "text", text: result.content, id: nextId() })
      for (const tc of result.toolCalls) {
        content.push({ type: "tool-call", toolCallType: "function", toolCallId: tc.id, toolName: tc.function?.name, args: tc.function?.arguments ?? "{}", id: nextId() })
      }

      return {
        content,
        finishReason: mapFinishReason(result.finishReason),
        usage: { inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens },
        warnings,
      }
    },

    async doStream(options: LanguageModelV2CallOptions) {
      const warnings: LanguageModelV2CallWarning[] = []
      const useResponses = shouldUseResponsesApi(modelId)

      // no-op (debug removed)

      if (useResponses) {
        // Responses API streaming
        const input = promptToResponsesInput(options.prompt)
        const tools = await toolsToResponses(options.tools)
        const chunks = streamResponses(
          { model: modelId, input, tools, temperature: options.temperature ?? undefined, max_output_tokens: options.maxOutputTokens ?? undefined },
          { model: modelId },
        )

        const stream = new ReadableStream<LanguageModelV2StreamPart>({
          async start(controller) {
            let textId: string | null = null
            const toolIds = new Map<string, string>() // output_index → call_id
            const toolNames = new Map<string, string>() // output_index → tool name
            const toolArgs = new Map<string, string>() // output_index → accumulated args JSON
            let inputTokens = 0
            let outputTokens = 0
            let finishReason: LanguageModelV2FinishReason = "other"

            controller.enqueue({ type: "stream-start", warnings })

            try {
              for await (const chunk of chunks) {
                if (chunk.type === "response.output_text.delta") {
                  if (!textId) {
                    textId = nextId()
                    controller.enqueue({ type: "text-start", id: textId })
                  }
                  controller.enqueue({ type: "text-delta", id: textId, delta: chunk.delta ?? "" })
                } else if (chunk.type === "response.output_text.done") {
                  if (textId) {
                    controller.enqueue({ type: "text-end", id: textId })
                    textId = null
                  }
                } else if (chunk.type === "response.output_item.added" && chunk.item?.type === "function_call") {
                  if (textId) { controller.enqueue({ type: "text-end", id: textId }); textId = null }
                  const callId = chunk.item.call_id ?? nextId()
                  const outputIdx = String(chunk.output_index ?? "")
                  toolIds.set(outputIdx, callId)
                  toolNames.set(outputIdx, chunk.item.name ?? "")
                  toolArgs.set(outputIdx, "")
                  controller.enqueue({ type: "tool-input-start", id: callId, toolName: chunk.item.name ?? "" })
                } else if (chunk.type === "response.function_call_arguments.delta") {
                  const outputIdx = String(chunk.output_index ?? "")
                  const callId = toolIds.get(outputIdx)
                  if (callId) {
                    controller.enqueue({ type: "tool-input-delta", id: callId, delta: chunk.delta ?? "" })
                    toolArgs.set(outputIdx, (toolArgs.get(outputIdx) ?? "") + (chunk.delta ?? ""))
                  }
                } else if (chunk.type === "response.function_call_arguments.done") {
                  const outputIdx = String(chunk.output_index ?? "")
                  const callId = toolIds.get(outputIdx)
                  if (callId) {
                    // Use the full arguments from .done event (more reliable than accumulated deltas)
                    const fullArgs = chunk.arguments ?? toolArgs.get(outputIdx) ?? "{}"
                    controller.enqueue({ type: "tool-input-end", id: callId })
                    // Emit tool-call event — AI SDK needs this to trigger tool execution
                    controller.enqueue({
                      type: "tool-call",
                      toolCallType: "function",
                      toolCallId: callId,
                      toolName: toolNames.get(outputIdx) ?? "",
                      input: fullArgs,
                    } as any)
                  }
                } else if (chunk.type === "response.completed") {
                  const resp = chunk.response
                  inputTokens = resp?.usage?.input_tokens ?? 0
                  outputTokens = resp?.usage?.output_tokens ?? 0
                  // If we emitted tool calls, finishReason MUST be "tool-calls" for AI SDK to continue the loop
                  finishReason = toolIds.size > 0 ? "tool-calls" : (resp?.status === "completed" ? "stop" : "other")
                }
              }

              if (textId) controller.enqueue({ type: "text-end", id: textId })

              controller.enqueue({
                type: "finish",
                usage: { inputTokens, outputTokens },
                finishReason,
                providerMetadata: undefined,
              })
            } catch (err) {
              log.error("doStream error", { modelId, error: err instanceof Error ? err.message : String(err) })
              controller.error(err)
              return
            }
            controller.close()
          },
        })

        return { stream }
      }

      // Chat Completions streaming
      const messages = promptToMessages(options.prompt)
      const tools = await toolsToCompletions(options.tools)
      const chunks = streamCompletions(
        { model: modelId, messages, tools, temperature: options.temperature ?? undefined, max_tokens: options.maxOutputTokens ?? undefined },
        { model: modelId },
      )

      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
          let textId: string | null = null
          const toolCallIds = new Map<number, string>()
          const toolCallNames = new Map<number, string>()
          const toolCallArgsAcc = new Map<number, string>()
          let promptTokens = 0
          let completionTokens = 0
          let finishReason: LanguageModelV2FinishReason = "other"

          controller.enqueue({ type: "stream-start", warnings })

          try {
            for await (const chunk of chunks) {
              const choice = chunk.choices?.[0]
              if (!choice) continue
              const delta = choice.delta

              if (delta.content) {
                if (!textId) { textId = nextId(); controller.enqueue({ type: "text-start", id: textId }) }
                controller.enqueue({ type: "text-delta", id: textId, delta: delta.content })
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index
                  if (tc.id && !toolCallIds.has(idx)) {
                    if (textId) { controller.enqueue({ type: "text-end", id: textId }); textId = null }
                    const id = tc.id
                    toolCallIds.set(idx, id)
                    toolCallNames.set(idx, tc.function?.name ?? "")
                    toolCallArgsAcc.set(idx, "")
                    controller.enqueue({ type: "tool-input-start", id, toolName: tc.function?.name ?? "" })
                  }
                  if (tc.function?.arguments) {
                    const id = toolCallIds.get(idx)!
                    controller.enqueue({ type: "tool-input-delta", id, delta: tc.function.arguments })
                    toolCallArgsAcc.set(idx, (toolCallArgsAcc.get(idx) ?? "") + tc.function.arguments)
                  }
                }
              }

              if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason)
              if (chunk.usage) { promptTokens = chunk.usage.prompt_tokens; completionTokens = chunk.usage.completion_tokens }
            }

            if (textId) controller.enqueue({ type: "text-end", id: textId })
            for (const [idx, id] of toolCallIds) {
              controller.enqueue({ type: "tool-input-end", id })
              // Emit tool-call event — AI SDK needs this to trigger tool execution
              controller.enqueue({
                type: "tool-call",
                toolCallType: "function",
                toolCallId: id,
                toolName: toolCallNames.get(idx) ?? "",
                input: toolCallArgsAcc.get(idx) ?? "{}",
              } as any)
            }

            controller.enqueue({
              type: "finish",
              usage: { inputTokens: promptTokens, outputTokens: completionTokens },
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
