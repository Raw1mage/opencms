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
  hasFunctionCall: boolean
  /** ID of the currently-open text part (null = no dangling text) */
  openTextId: string | null
  /** Accumulated function_call arguments per output_index (recovery buffer) */
  toolArgBuffer: Map<number, string>
  /** call_ids for which tool-call has been emitted — guards duplicate emission */
  emittedToolCalls: Set<string>
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
    hasFunctionCall: false,
    openTextId: null,
    toolArgBuffer: new Map(),
    emittedToolCalls: new Set(),
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

          const parts = mapEvent(value, state)
          for (const part of parts) {
            controller.enqueue(part)
          }
        }

        // Flush dangling text part before finish (§4.4: text-end if dangling)
        if (state.openTextId != null) {
          controller.enqueue({ type: "text-end", id: state.openTextId } as LanguageModelV2StreamPart)
          state.openTextId = null
        }

        // Flush dangling function_call parts (§4.7: tool-call synthesis on truncation).
        // If WS ended before .arguments.done / .output_item.done, the tool part would be
        // stranded in "pending" and later swept to "Tool execution aborted". Synthesize
        // tool-input-end + tool-call from the delta buffer so downstream code gets a
        // terminal state — even if the accumulated arguments JSON is partial (the tool
        // executor's parse error is a more honest failure than a silent abort).
        for (const [outputIdx, buffered] of state.toolArgBuffer) {
          const tracked = state.outputItems.get(outputIdx)
          if (!tracked || tracked.type !== "function_call" || !tracked.callId) continue
          if (state.emittedToolCalls.has(tracked.callId)) continue
          state.hasFunctionCall = true
          controller.enqueue({ type: "tool-input-end", id: tracked.callId } as LanguageModelV2StreamPart)
          controller.enqueue({
            type: "tool-call",
            toolCallId: tracked.callId,
            toolName: tracked.name ?? "unknown",
            input: buffered && buffered.length > 0 ? buffered : "{}",
            providerMetadata: tracked.id ? { openai: { itemId: tracked.id } } : undefined,
          } as LanguageModelV2StreamPart)
          state.emittedToolCalls.add(tracked.callId)
        }
        state.toolArgBuffer.clear()

        // Determine finish reason: function_call present → "tool-calls" (§4.6)
        const finishReason: LanguageModelV2FinishReason =
          state.finishReason === "stop" && state.hasFunctionCall
            ? "tool-calls"
            : (state.finishReason ?? "other")

        // Emit finish
        controller.enqueue({
          type: "finish",
          finishReason,
          usage: buildUsage(state.usage),
          providerMetadata: state.responseId
            ? { openai: { responseId: state.responseId } }
            : undefined,
        } as LanguageModelV2StreamPart)

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
      state.outputItems.set(idx, {
        type: item.type,
        id: item.id ?? `item_${idx}`,
        name: item.name,
        callId: item.call_id,
      })

      if (item.type === "message") {
        // Text output starts
        const id = `text_${state.textIdCounter++}`
        state.openTextId = id
        parts.push({ type: "text-start", id } as LanguageModelV2StreamPart)
      } else if (item.type === "function_call") {
        state.hasFunctionCall = true
        const id = item.call_id ?? `tool_${state.toolIdCounter++}`
        parts.push({
          type: "tool-input-start",
          id,
          toolName: item.name ?? "unknown",
        } as LanguageModelV2StreamPart)
        // Non-streaming path: arguments already complete in the added event.
        // Emit delta + end + tool-call (the last was previously missing and caused
        // pending tool parts to be swept to "Tool execution aborted" when codex
        // short-circuited output_item.done — see sse.ts §4.7 truncation fix).
        if (item.arguments && item.arguments !== "{}") {
          parts.push({ type: "tool-input-delta", id, delta: item.arguments } as LanguageModelV2StreamPart)
          parts.push({ type: "tool-input-end", id } as LanguageModelV2StreamPart)
          parts.push({
            type: "tool-call",
            toolCallId: id,
            toolName: item.name ?? "unknown",
            input: item.arguments,
            providerMetadata: item.id ? { openai: { itemId: item.id } } : undefined,
          } as LanguageModelV2StreamPart)
          state.emittedToolCalls.add(id)
        }
      }
      break
    }

    case "response.output_text.delta": {
      const delta = (event as any).delta as string
      // Auto-emit text-start if delta arrives before output_item.added (§4.4)
      if (state.openTextId == null) {
        const id = `text_${state.textIdCounter++}`
        state.openTextId = id
        parts.push({ type: "text-start", id } as LanguageModelV2StreamPart)
      }
      parts.push({ type: "text-delta", id: state.openTextId, delta } as LanguageModelV2StreamPart)
      break
    }

    case "response.output_text.done": {
      // Use openTextId (set by text-start) so text-end id matches the id AI SDK
      // registered on text-start. Recomputing from counter races with concurrent
      // output_item.added events and produced "text part text_N not found" errors.
      const id = state.openTextId ?? `text_${state.textIdCounter > 0 ? state.textIdCounter - 1 : 0}`
      if (state.openTextId != null) {
        parts.push({ type: "text-end", id } as LanguageModelV2StreamPart)
        state.openTextId = null
      }
      break
    }

    case "response.function_call_arguments.delta": {
      const delta = (event as any).delta as string
      const outputIdx = (event as any).output_index as number
      const trackedItem = state.outputItems.get(outputIdx)
      const callId = trackedItem?.callId ?? (event as any).call_id ?? `tool_${outputIdx}`
      parts.push({ type: "tool-input-delta", id: callId, delta } as LanguageModelV2StreamPart)
      // Buffer for truncation recovery: if stream ends before .arguments.done /
      // .output_item.done, the flush path can synthesize tool-call from this.
      const prev = state.toolArgBuffer.get(outputIdx) ?? ""
      state.toolArgBuffer.set(outputIdx, prev + (delta ?? ""))
      break
    }

    case "response.function_call_arguments.done": {
      const outputIdx = (event as any).output_index as number
      const trackedItem2 = state.outputItems.get(outputIdx)
      const callId = trackedItem2?.callId ?? (event as any).call_id ?? `tool_${outputIdx}`
      parts.push({ type: "tool-input-end", id: callId } as LanguageModelV2StreamPart)
      // Primary tool-call emission site: .arguments.done carries the full, final
      // `arguments` string. Emitting here (instead of waiting for .output_item.done)
      // closes the window where WS truncation between the two events left the tool
      // part stranded in "pending" → later swept to "Tool execution aborted".
      if (!state.emittedToolCalls.has(callId)) {
        const finalArgs =
          (event as any).arguments as string | undefined ??
          state.toolArgBuffer.get(outputIdx) ??
          "{}"
        state.hasFunctionCall = true
        parts.push({
          type: "tool-call",
          toolCallId: callId,
          toolName: trackedItem2?.name ?? "unknown",
          input: finalArgs,
          providerMetadata: trackedItem2?.id ? { openai: { itemId: trackedItem2.id } } : undefined,
        } as LanguageModelV2StreamPart)
        state.emittedToolCalls.add(callId)
      }
      state.toolArgBuffer.delete(outputIdx)
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
      // Mirror text-end guard (§ response.output_text.done): only emit
      // reasoning-end if reasoning-start was actually emitted on THIS stream.
      // After a WS reset (account rotation / previous_response_not_found),
      // the new stream's state is fresh — if the first reasoning event we
      // see is .done (because .delta fired on the dropped WS), emitting an
      // unmatched reasoning-end trips AI SDK's assembler with
      // "reasoning part reasoning_X not found".
      const trackedKey = -1000 - state.reasoningIdCounter
      if (state.outputItems.has(trackedKey)) {
        const id = `reasoning_${state.reasoningIdCounter}`
        parts.push({ type: "reasoning-end", id } as LanguageModelV2StreamPart)
        state.outputItems.delete(trackedKey)
      }
      state.reasoningIdCounter++
      break
    }

    case "response.output_item.done": {
      const doneItem = (event as any).item as { type: string; call_id?: string; name?: string; arguments?: string; id?: string }
      if (doneItem?.type === "function_call" && doneItem.call_id) {
        state.hasFunctionCall = true
        // Idempotent: if .arguments.done (or non-streaming output_item.added)
        // already emitted tool-call for this call_id, skip re-emission.
        // output_item.done is a secondary / fallback path that still fires tool-input-end
        // in case .arguments.done didn't fire at all (e.g., non-streaming shape).
        if (state.emittedToolCalls.has(doneItem.call_id)) {
          break
        }
        parts.push({ type: "tool-input-end", id: doneItem.call_id } as LanguageModelV2StreamPart)
        parts.push({
          type: "tool-call",
          toolCallId: doneItem.call_id,
          toolName: doneItem.name ?? "unknown",
          input: doneItem.arguments ?? "{}",
          providerMetadata: doneItem.id ? { openai: { itemId: doneItem.id } } : undefined,
        } as LanguageModelV2StreamPart)
        state.emittedToolCalls.add(doneItem.call_id)
      }
      break
    }

    case "response.incomplete": {
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
      // Map incomplete reason to finish reason
      const reason = (resp as any)?.incomplete_details?.reason
      state.finishReason = reason === "max_output_tokens" ? "length" : "other"
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
      state.finishReason = mapFinishReason(resp?.status)
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
