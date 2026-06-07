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
import { shouldUseResponsesApi, AUTO_MODEL_ID, resolveAutoModel } from "./models"
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
  if (typeof output === "object" && "type" in output && "value" in output) {
    const typed = output as { type: string; value: unknown }
    if (typed.type === "text" || typed.type === "error-text") return String(typed.value || "{}")
    return JSON.stringify(typed.value)
  }
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

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

// ---------------------------------------------------------------------------
// Convert AI SDK prompt to Responses API input format
// ---------------------------------------------------------------------------

function promptToResponsesInput(prompt: LanguageModelV2CallOptions["prompt"]): any[] {
  const input: any[] = []
  for (const msg of prompt) {
    if (msg.role === "system") {
      input.push({ role: "system", content: msg.content })
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
      const aContent = msg.content
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
            arguments: typeof p.input === "string" ? (p.input || "{}") : JSON.stringify(p.input ?? {}),
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
      messages.push({ role: "system", content: msg.content })
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
      const aContent = msg.content
      for (const p of aContent) {
        if (p.type === "text") text += p.text
        else if (p.type === "tool-call") {
          toolCalls.push({
            id: p.toolCallId,
            type: "function",
            function: {
              name: p.toolName,
              arguments: typeof p.input === "string" ? p.input : JSON.stringify(p.input),
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

/**
 * Extract Copilot-specific options that the runtime threads in via
 * providerOptions["copilot-cli"]. ProviderTransform.options() (transform.ts L875+)
 * sets reasoningEffort="medium" / reasoningSummary="auto" / textVerbosity="low"
 * for gpt-5.* models; without forwarding them onto the wire, the CAPI fell back
 * to a weaker default (likely minimal/low) and the model emitted preamble-only
 * turns with no tool_calls (ses_1970097b4ffeZYJnoYNxGojywm, 2026-05-28).
 */
function readCopilotOptions(options: LanguageModelV2CallOptions): {
  reasoningEffort?: string
  reasoningSummary?: string
  textVerbosity?: string
} {
  const raw = (options.providerOptions?.["copilot-cli"] ?? {}) as Record<string, unknown>
  return {
    reasoningEffort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : undefined,
    reasoningSummary: typeof raw.reasoningSummary === "string" ? raw.reasoningSummary : undefined,
    textVerbosity: typeof raw.textVerbosity === "string" ? raw.textVerbosity : undefined,
  }
}

/**
 * Cheap text-only size proxy for the `auto` router. Pulls just the text /
 * tool-call / tool-result payloads from the prompt — deliberately skips
 * base64 image data so a single screenshot doesn't blow the size estimate and
 * wrongly escalate the tier.
 */
function promptTextSize(prompt: LanguageModelV2CallOptions["prompt"]): string {
  const parts: string[] = []
  for (const msg of prompt) {
    const content = (msg as any).content
    if (typeof content === "string") {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const p of content) {
      if (p?.type === "text" && typeof p.text === "string") parts.push(p.text)
      else if (p?.type === "tool-call") parts.push(typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}))
      else if (p?.type === "tool-result") parts.push(stringifyOutput((p as any).output))
    }
  }
  return parts.join("\n")
}

/** Resolve the synthetic `auto` id to a concrete model; pass real ids through unchanged. */
async function resolveModelId(modelId: string, options: LanguageModelV2CallOptions): Promise<string> {
  if (modelId !== AUTO_MODEL_ID) return modelId
  const copilotOpts = readCopilotOptions(options)
  return resolveAutoModel({
    promptText: promptTextSize(options.prompt),
    reasoningEffort: copilotOpts.reasoningEffort,
  })
}

/** Responses API nested shape: `reasoning: { effort, summary }` — only emit when at least one field is set. */
function buildReasoningField(opts: { reasoningEffort?: string; reasoningSummary?: string }): any {
  if (opts.reasoningEffort == null && opts.reasoningSummary == null) return undefined
  const r: Record<string, string> = {}
  if (opts.reasoningEffort != null) r.effort = opts.reasoningEffort
  if (opts.reasoningSummary != null) r.summary = opts.reasoningSummary
  return r
}

/** Responses API verbosity sits under `text: { verbosity }`. Omit when unset. */
function buildTextField(opts: { textVerbosity?: string }): any {
  if (opts.textVerbosity == null) return undefined
  return { verbosity: opts.textVerbosity }
}

export function createCopilotCLIModel(modelId: string): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "copilot-cli",
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV2CallOptions) {
      const warnings: LanguageModelV2CallWarning[] = []
      const effectiveModelId = await resolveModelId(modelId, options)
      const useResponses = shouldUseResponsesApi(effectiveModelId)
      const copilotOpts = readCopilotOptions(options)

      if (useResponses) {
        const input = promptToResponsesInput(options.prompt)
        const tools = await toolsToResponses(options.tools)
        let text = ""
        let inputTokens = 0
        let outputTokens = 0
        let reason: LanguageModelV2FinishReason = "other"
        const toolCalls: any[] = []

        for await (const chunk of streamResponses(
          {
            model: effectiveModelId,
            input,
            tools,
            temperature: options.temperature ?? undefined,
            max_output_tokens: options.maxOutputTokens ?? undefined,
            reasoning: buildReasoningField(copilotOpts),
            text: buildTextField(copilotOpts),
          },
          { model: effectiveModelId },
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
          content.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.function?.name, input: tc.function?.arguments ?? "{}" })
        }
        return { content, finishReason: reason, usage: usage(inputTokens, outputTokens), warnings }
      }

      // Chat Completions path
      const messages = promptToMessages(options.prompt)
      const tools = await toolsToCompletions(options.tools)
      const result = await callCompletions(
        {
          model: effectiveModelId,
          messages,
          tools,
          temperature: options.temperature ?? undefined,
          max_tokens: options.maxOutputTokens ?? undefined,
          reasoning_effort: copilotOpts.reasoningEffort,
          verbosity: copilotOpts.textVerbosity,
        },
        { model: effectiveModelId },
      )

      const content: any[] = []
      if (result.content) content.push({ type: "text", text: result.content, id: nextId() })
      for (const tc of result.toolCalls) {
        content.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.function?.name, input: tc.function?.arguments ?? "{}" })
      }

      return {
        content,
        finishReason: mapFinishReason(result.finishReason),
        usage: usage(result.usage.promptTokens, result.usage.completionTokens),
        warnings,
      }
    },

    async doStream(options: LanguageModelV2CallOptions) {
      const warnings: LanguageModelV2CallWarning[] = []
      const effectiveModelId = await resolveModelId(modelId, options)
      const useResponses = shouldUseResponsesApi(effectiveModelId)
      const copilotOpts = readCopilotOptions(options)

      // no-op (debug removed)

      if (useResponses) {
        // Responses API streaming
        const input = promptToResponsesInput(options.prompt)
        const tools = await toolsToResponses(options.tools)
        const chunks = streamResponses(
          {
            model: effectiveModelId,
            input,
            tools,
            temperature: options.temperature ?? undefined,
            max_output_tokens: options.maxOutputTokens ?? undefined,
            reasoning: buildReasoningField(copilotOpts),
            text: buildTextField(copilotOpts),
          },
          { model: effectiveModelId },
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
                usage: usage(inputTokens, outputTokens),
                finishReason,
                providerMetadata: undefined,
              })
            } catch (err) {
              log.error("doStream error", { modelId: effectiveModelId, error: err instanceof Error ? err.message : String(err) })
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
        {
          model: effectiveModelId,
          messages,
          tools,
          temperature: options.temperature ?? undefined,
          max_tokens: options.maxOutputTokens ?? undefined,
          reasoning_effort: copilotOpts.reasoningEffort,
          verbosity: copilotOpts.textVerbosity,
        },
        { model: effectiveModelId },
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
              usage: usage(promptTokens, completionTokens),
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
