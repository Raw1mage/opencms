/**
 * Anthropic SSE stream parser → LanguageModelV2StreamPart.
 *
 * Phase 2B: Line-based buffering with chunk boundary handling.
 * Ref: Anthropic Messages API SSE event types.
 */
import type { LanguageModelV2StreamPart, LanguageModelV2FinishReason, LanguageModelV2Usage } from "@ai-sdk/provider"
import { stripToolPrefix } from "./convert.js"

// ---------------------------------------------------------------------------
// § 2B.1  parseAnthropicSSE — main entry point
// ---------------------------------------------------------------------------

export function parseAnthropicSSE(body: ReadableStream<Uint8Array>): ReadableStream<LanguageModelV2StreamPart> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let remainder = ""
  let currentEventType = ""

  // Track active content blocks for id generation
  const activeBlocks = new Map<
    number,
    { type: string; id: string; toolName?: string; input?: string; signature?: string }
  >()
  let blockCounter = 0

  // Accumulate usage across message_start and message_delta
  const usage: LanguageModelV2Usage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    cachedInputTokens: undefined,
  }

  let messageId: string | undefined
  let messageModel: string | undefined
  let emittedStreamStart = false
  // Anthropic emits the final stop_reason on message_delta (NOT message_stop);
  // cache it per-stream so message_stop can map it. Without this every turn
  // finished as "other" instead of "stop", so the runloop thought the turn
  // wasn't done and re-requested with the assistant reply trailing → Anthropic
  // 400 "does not support assistant message prefill".
  let lastStopReason: string | undefined
  // [DIAG:claude-resp] Per-stream block-production tally for the "no-thinking
  // session stalls" investigation (issues/bug_20260530_narrate_then_stall_regression.md).
  // A stall ≈ "stream opened, finished, but produced no text/tool block" — i.e.
  // an empty completion the runloop can't advance on. Count what was actually
  // emitted so a reproduced stall is tied to a concrete production tally + the
  // RAW stop_reason (mapped "other" when undefined → runloop mis-advance).
  let producedText = 0
  let producedReasoning = 0
  let producedToolUse = 0
  // Anthropic reports cache-write tokens as cache_creation_input_tokens; not part
  // of LanguageModelV2Usage, so carry it out via finish providerMetadata for the
  // host's cache-write accounting (else cache write always shows 0).
  let cacheCreationTokens: number | undefined

  return new ReadableStream<LanguageModelV2StreamPart>({
    async pull(controller) {
      // Emit stream-start on first pull
      if (!emittedStreamStart) {
        emittedStreamStart = true
        controller.enqueue({ type: "stream-start", warnings: [] })
      }

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          // Flush remaining
          if (remainder.trim()) {
            processLines(remainder, controller)
            remainder = ""
          }
          controller.close()
          return
        }

        const text = remainder + decoder.decode(value, { stream: true })
        const lastNewline = text.lastIndexOf("\n")

        if (lastNewline === -1) {
          remainder = text
          continue
        }

        const complete = text.slice(0, lastNewline + 1)
        remainder = text.slice(lastNewline + 1)

        processLines(complete, controller)
        return // yield control back after processing a chunk
      }
    },
  })

  function processLines(text: string, controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim()

      if (trimmed === "") {
        // Empty line = event boundary, reset event type
        currentEventType = ""
        continue
      }

      if (trimmed.startsWith("event: ")) {
        currentEventType = trimmed.slice(7).trim()
        continue
      }

      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6)
        try {
          const parsed = JSON.parse(data)
          // Emit raw event for debugging
          controller.enqueue({ type: "raw", rawValue: parsed })
          dispatchEvent(parsed, controller)
        } catch {
          // Not valid JSON — ignore (could be keep-alive or partial)
        }
      }

      // § 2B.5 Ping — `:` prefix lines are comments/keep-alive, ignore
    }
  }

  function dispatchEvent(event: any, controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>) {
    switch (event.type) {
      // § 1B.1  message_start → response-metadata
      case "message_start": {
        const msg = event.message
        if (msg) {
          messageId = msg.id
          messageModel = msg.model
          controller.enqueue({
            type: "response-metadata",
            id: msg.id,
            modelId: msg.model,
            timestamp: new Date(),
          })
          // § 1B.8  Extract initial usage
          if (msg.usage) {
            usage.inputTokens = msg.usage.input_tokens
            usage.cachedInputTokens = msg.usage.cache_read_input_tokens
            cacheCreationTokens = msg.usage.cache_creation_input_tokens
          }
        }
        break
      }

      // § 1B.2  content_block_start
      case "content_block_start": {
        const idx = event.index as number
        const block = event.content_block
        const id = `block-${blockCounter++}`

        if (block.type === "text") {
          producedText++
          activeBlocks.set(idx, { type: "text", id })
          controller.enqueue({ type: "text-start", id })
        } else if (block.type === "thinking") {
          producedReasoning++
          activeBlocks.set(idx, { type: "thinking", id })
          controller.enqueue({ type: "reasoning-start", id })
        } else if (block.type === "tool_use") {
          producedToolUse++
          const toolName = stripToolPrefix(block.name || "")
          activeBlocks.set(idx, { type: "tool_use", id: block.id || id, toolName, input: "" })
          controller.enqueue({
            type: "tool-input-start",
            id: block.id || id,
            toolName,
          })
        }
        break
      }

      // § 1B.3  content_block_delta
      case "content_block_delta": {
        const idx = event.index as number
        const delta = event.delta
        const info = activeBlocks.get(idx)
        if (!info) break

        if (delta.type === "text_delta") {
          controller.enqueue({ type: "text-delta", id: info.id, delta: delta.text })
        } else if (delta.type === "thinking_delta") {
          controller.enqueue({ type: "reasoning-delta", id: info.id, delta: delta.thinking })
        } else if (delta.type === "signature_delta") {
          // Anthropic signs each thinking block; the signature must be replayed
          // when the thinking block is sent back in history. Accumulate it for
          // the reasoning-end providerMetadata below.
          info.signature = (info.signature ?? "") + (delta.signature ?? "")
        } else if (delta.type === "input_json_delta") {
          // Accumulate the streamed JSON so content_block_stop can emit the
          // final tool-call part with the complete input.
          info.input = (info.input ?? "") + (delta.partial_json ?? "")
          controller.enqueue({ type: "tool-input-delta", id: info.id, delta: delta.partial_json })
        }
        break
      }

      // § 1B.4  content_block_stop
      case "content_block_stop": {
        const idx = event.index as number
        const info = activeBlocks.get(idx)
        if (!info) break

        if (info.type === "text") {
          controller.enqueue({ type: "text-end", id: info.id })
        } else if (info.type === "thinking") {
          // Carry the signature out via providerMetadata so the AI SDK stores it
          // on the reasoning part; convertPrompt replays it as thinking.signature.
          controller.enqueue({
            type: "reasoning-end",
            id: info.id,
            ...(info.signature ? { providerMetadata: { anthropic: { signature: info.signature } } } : {}),
          })
        } else if (info.type === "tool_use") {
          controller.enqueue({ type: "tool-input-end", id: info.id })
          // CRITICAL: emit the final tool-call part. Without it the AI SDK
          // never dispatches the tool — every tool call stayed `pending` and
          // was reconstructed as "[Tool execution was interrupted]". (codex's
          // parser already emits this; claude's never did.)
          controller.enqueue({
            type: "tool-call",
            toolCallId: info.id,
            toolName: info.toolName ?? "unknown",
            input: info.input && info.input.length > 0 ? info.input : "{}",
          })
        }
        activeBlocks.delete(idx)
        break
      }

      // § 1B.5  message_delta → usage update + finish reason
      case "message_delta": {
        if (event.usage) {
          usage.outputTokens = event.usage.output_tokens
        }
        // The stop_reason arrives here in delta.stop_reason; cache it for the
        // message_stop finish event below.
        if (event.delta?.stop_reason) {
          lastStopReason = event.delta.stop_reason
        }
        break
      }

      // § 1B.6  message_stop → finish
      case "message_stop": {
        // [DIAG:claude-resp] Response-boundary checkpoint. A "no-thinking stall"
        // should surface here as rawStop=undefined → mapped "other", and/or a
        // zero production tally (no text/tool block) — an empty completion the
        // host runloop cannot advance on. Tying the reproduced symptom to THIS
        // line is what closes the code-thinker "no log, no root cause" gap.
        const mapped = mapFinishReason(lastStopReason)
        if (lastStopReason === undefined || producedText + producedToolUse === 0 || mapped === "other") {
          console.warn(
            `[DIAG:claude-resp] SUSPECT-EMPTY rawStop=${lastStopReason ?? "undefined"} mapped=${mapped}` +
              ` text=${producedText} reasoning=${producedReasoning} toolUse=${producedToolUse}` +
              ` outTokens=${usage.outputTokens ?? "-"}`,
          )
        } else {
          console.warn(
            `[DIAG:claude-resp] ok rawStop=${lastStopReason} mapped=${mapped}` +
              ` text=${producedText} reasoning=${producedReasoning} toolUse=${producedToolUse}`,
          )
        }
        // Finish reason comes from the cached message_delta stop_reason.
        controller.enqueue({
          type: "finish",
          finishReason: mapFinishReason(lastStopReason),
          usage,
          ...(cacheCreationTokens != null
            ? { providerMetadata: { anthropic: { cacheCreationInputTokens: cacheCreationTokens } } }
            : {}),
        })
        break
      }

      // § 2B.5  ping — keep-alive, ignore
      case "ping":
        break

      // § 2B.4  error
      case "error": {
        controller.enqueue({
          type: "error",
          error: event.error || event,
        })
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// § 1B.5  Finish reason mapping
// ---------------------------------------------------------------------------

export function mapFinishReason(reason: string | undefined): LanguageModelV2FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool-calls"
    case "content_filter":
      return "content-filter"
    default:
      return "other"
  }
}
