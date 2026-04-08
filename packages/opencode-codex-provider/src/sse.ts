/**
 * Responses API SSE → LanguageModelV2StreamPart parser.
 *
 * Parses Server-Sent Events from the Codex Responses API
 * and maps them to AI SDK's LanguageModelV2StreamPart format.
 */
import type {
  LanguageModelV2StreamPart,
  LanguageModelV2FinishReason,
  LanguageModelV2Usage,
  LanguageModelV2Source,
} from "@ai-sdk/provider"
import type { ResponseStreamEvent, ResponseObject } from "./types.js"

// ---------------------------------------------------------------------------
// § 1  SSE line parser → JSON events
// ---------------------------------------------------------------------------

/**
 * Parse a raw SSE byte stream into ResponseStreamEvent objects.
 * Standard SSE: lines starting with "data: " contain JSON payloads.
 * "data: [DONE]" signals end of stream.
 */
export function parseSSEStream(body: ReadableStream<Uint8Array>): ReadableStream<ResponseStreamEvent> {
  const decoder = new TextDecoder()
  let buffer = ""

  return new ReadableStream<ResponseStreamEvent>({
    async start(controller) {
      const reader = body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(":")) continue
            if (trimmed === "data: [DONE]") {
              controller.close()
              return
            }
            if (trimmed.startsWith("data: ")) {
              try {
                const event = JSON.parse(trimmed.slice(6)) as ResponseStreamEvent
                controller.enqueue(event)
              } catch {
                // Malformed JSON line — skip
              }
            }
          }
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

// ---------------------------------------------------------------------------
// § 2  ResponseStreamEvent → LanguageModelV2StreamPart
// ---------------------------------------------------------------------------

/** State tracker for mapping output indices to part IDs */
interface StreamState {
  responseId?: string
  outputItems: Map<number, { type: string; id: string; name?: string; callId?: string }>
  textIdCounter: number
  toolIdCounter: number
  reasoningIdCounter: number
  usage?: ResponseUsageCapture
  finishReason?: LanguageModelV2FinishReason
}

interface ResponseUsageCapture {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  reasoningTokens?: number
}

/**
 * Transform Responses API events into LanguageModelV2StreamPart stream.
 * Returns the stream and a promise that resolves to the final response_id.
 */
export function mapResponseStream(
  events: ReadableStream<ResponseStreamEvent>,
): {
  stream: ReadableStream<LanguageModelV2StreamPart>
  responseIdPromise: Promise<string | undefined>
} {
  const state: StreamState = {
    outputItems: new Map(),
    textIdCounter: 0,
    toolIdCounter: 0,
    reasoningIdCounter: 0,
  }

  let resolveResponseId: (id: string | undefined) => void
  const responseIdPromise = new Promise<string | undefined>((resolve) => {
    resolveResponseId = resolve
  })

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    async start(controller) {
      const reader = events.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          if (value.type?.includes("function_call")) {
            console.error(`[CODEX-SSE] mapEvent: type=${value.type} FULL=${JSON.stringify(value).slice(0,500)}`)
          }
          const parts = mapEvent(value, state)
          for (const part of parts) {
            controller.enqueue(part)
          }
        }

        // Emit finish if not already emitted
        if (state.finishReason) {
          controller.enqueue({
            type: "finish",
            finishReason: state.finishReason,
            usage: buildUsage(state.usage),
            providerMetadata: state.responseId
              ? { openai: { responseId: state.responseId } }
              : undefined,
          } as LanguageModelV2StreamPart)
        }

        resolveResponseId(state.responseId)
        controller.close()
      } catch (error) {
        resolveResponseId(undefined)
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })

  return { stream, responseIdPromise }
}

// ---------------------------------------------------------------------------
// § 3  Event mapping
// ---------------------------------------------------------------------------

function mapEvent(event: ResponseStreamEvent, state: StreamState): LanguageModelV2StreamPart[] {
  const parts: LanguageModelV2StreamPart[] = []

  switch (event.type) {
    case "response.created":
    case "response.in_progress": {
      const resp = (event as any).response as ResponseObject | undefined
      if (resp?.id) state.responseId = resp.id
      break
    }

    case "response.output_item.added": {
      const item = (event as any).item as { type: string; id?: string; name?: string; call_id?: string; arguments?: string }
      const idx = (event as any).output_index as number
      if (item.type === "function_call") {
        console.error(`[CODEX-TOOL] output_item.added: idx=${idx} name=${item.name} call_id=${item.call_id} hasArgs=${!!item.arguments} argsLen=${item.arguments?.length ?? 0} argsPreview=${(item.arguments ?? "").slice(0, 100)}`)
      }
      state.outputItems.set(idx, {
        type: item.type,
        id: item.id ?? `item_${idx}`,
        name: item.name,
        callId: item.call_id,
      })

      if (item.type === "message") {
        // Text output starts
        const id = `text_${state.textIdCounter++}`
        parts.push({ type: "text-start", id } as LanguageModelV2StreamPart)
      } else if (item.type === "function_call") {
        const id = item.call_id ?? `tool_${state.toolIdCounter++}`
        parts.push({
          type: "tool-input-start",
          id,
          toolName: item.name ?? "unknown",
        } as LanguageModelV2StreamPart)
        // If arguments are already complete in the added event (non-streaming tool call),
        // emit them immediately as delta + end
        if (item.arguments && item.arguments !== "{}") {
          parts.push({ type: "tool-input-delta", id, delta: item.arguments } as LanguageModelV2StreamPart)
          parts.push({ type: "tool-input-end", id } as LanguageModelV2StreamPart)
        }
      }
      break
    }

    case "response.output_text.delta": {
      const delta = (event as any).delta as string
      const id = `text_${state.textIdCounter > 0 ? state.textIdCounter - 1 : 0}`
      parts.push({ type: "text-delta", id, delta } as LanguageModelV2StreamPart)
      break
    }

    case "response.output_text.done": {
      const id = `text_${state.textIdCounter > 0 ? state.textIdCounter - 1 : 0}`
      parts.push({ type: "text-end", id } as LanguageModelV2StreamPart)
      break
    }

    case "response.function_call_arguments.delta": {
      const delta = (event as any).delta as string
      const outputIdx = (event as any).output_index as number
      const trackedItem = state.outputItems.get(outputIdx)
      const callId = trackedItem?.callId ?? (event as any).call_id ?? `tool_${outputIdx}`
      parts.push({ type: "tool-input-delta", id: callId, delta } as LanguageModelV2StreamPart)
      break
    }

    case "response.function_call_arguments.done": {
      const outputIdx = (event as any).output_index as number
      const trackedItem2 = state.outputItems.get(outputIdx)
      const callId = trackedItem2?.callId ?? (event as any).call_id ?? `tool_${outputIdx}`
      parts.push({ type: "tool-input-end", id: callId } as LanguageModelV2StreamPart)
      break
    }

    case "response.reasoning_summary_text.delta": {
      const delta = (event as any).delta as string
      const id = `reasoning_${state.reasoningIdCounter}`
      // First delta starts reasoning
      if (!state.outputItems.has(-1000 - state.reasoningIdCounter)) {
        state.outputItems.set(-1000 - state.reasoningIdCounter, { type: "reasoning", id })
        parts.push({ type: "reasoning-start", id } as LanguageModelV2StreamPart)
      }
      parts.push({ type: "reasoning-delta", id, delta } as LanguageModelV2StreamPart)
      break
    }

    case "response.reasoning_summary_text.done": {
      const id = `reasoning_${state.reasoningIdCounter}`
      parts.push({ type: "reasoning-end", id } as LanguageModelV2StreamPart)
      state.reasoningIdCounter++
      break
    }

    case "response.output_item.done": {
      // Item completed — no action needed, text-end/tool-input-end handle closure
      break
    }

    case "response.completed": {
      const resp = (event as any).response as ResponseObject | undefined
      if (resp?.id) state.responseId = resp.id
      if (resp?.usage) {
        state.usage = {
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens,
          cachedTokens: resp.usage.input_tokens_details?.cached_tokens,
          reasoningTokens: resp.usage.output_tokens_details?.reasoning_tokens,
        }
      }
      state.finishReason = resp?.status === "completed" ? "stop" : "other"
      break
    }

    case "response.failed": {
      const resp = (event as any).response as ResponseObject | undefined
      const errorMsg = resp?.error?.message ?? "Response failed"
      parts.push({
        type: "error",
        error: new Error(errorMsg),
      } as LanguageModelV2StreamPart)
      state.finishReason = "error"
      break
    }

    case "error": {
      const error = (event as any).error as { message: string; code?: string }
      parts.push({
        type: "error",
        error: new Error(error.message),
      } as LanguageModelV2StreamPart)
      state.finishReason = "error"
      break
    }

    // rate_limits, content_part events, etc. — pass through silently
  }

  return parts
}

// ---------------------------------------------------------------------------
// § 4  Helpers
// ---------------------------------------------------------------------------

function buildUsage(capture: ResponseUsageCapture | undefined): LanguageModelV2Usage & {
  cachedInputTokens?: number
  reasoningTokens?: number
} {
  return {
    inputTokens: capture?.inputTokens,
    outputTokens: capture?.outputTokens,
    totalTokens: capture ? capture.inputTokens + capture.outputTokens : undefined,
    cachedInputTokens: capture?.cachedTokens,
    reasoningTokens: capture?.reasoningTokens,
  }
}

export function mapFinishReason(status: string | undefined): LanguageModelV2FinishReason {
  switch (status) {
    case "completed":
      return "stop"
    case "cancelled":
      return "stop"
    case "failed":
      return "error"
    case "incomplete":
      return "length"
    default:
      return "other"
  }
}
