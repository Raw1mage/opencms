/**
 * Anthropic SSE stream parser → LanguageModelV2StreamPart.
 *
 * Phase 2B: Line-based buffering with chunk boundary handling.
 * Ref: Anthropic Messages API SSE event types.
 */
import type {
  LanguageModelV2StreamPart,
  LanguageModelV2FinishReason,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import { stripToolPrefix } from "./convert.js"

// ---------------------------------------------------------------------------
// § 2B.1  parseAnthropicSSE — main entry point
// ---------------------------------------------------------------------------

export function parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
): ReadableStream<LanguageModelV2StreamPart> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let remainder = ""
  let currentEventType = ""

  // Track active content blocks for id generation
  const activeBlocks = new Map<
    number,
    { type: string; id: string; toolName?: string }
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

  function processLines(
    text: string,
    controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  ) {
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

  function dispatchEvent(
    event: any,
    controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
  ) {
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
          activeBlocks.set(idx, { type: "text", id })
          controller.enqueue({ type: "text-start", id })
        } else if (block.type === "thinking") {
          activeBlocks.set(idx, { type: "thinking", id })
          controller.enqueue({ type: "reasoning-start", id })
        } else if (block.type === "tool_use") {
          const toolName = stripToolPrefix(block.name || "")
          activeBlocks.set(idx, { type: "tool_use", id: block.id || id, toolName })
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
        } else if (delta.type === "input_json_delta") {
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
          controller.enqueue({ type: "reasoning-end", id: info.id })
        } else if (info.type === "tool_use") {
          controller.enqueue({ type: "tool-input-end", id: info.id })
        }
        activeBlocks.delete(idx)
        break
      }

      // § 1B.5  message_delta → usage update + finish reason
      case "message_delta": {
        if (event.usage) {
          usage.outputTokens = event.usage.output_tokens
        }
        // Finish reason is emitted in message_stop
        break
      }

      // § 1B.6  message_stop → finish
      case "message_stop": {
        // Determine finish reason from the last message_delta's stop_reason
        // Default to "stop" if not explicitly set
        controller.enqueue({
          type: "finish",
          finishReason: mapFinishReason(event._stopReason),
          usage,
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

// Cache stop_reason from message_delta for use in message_stop
let _lastStopReason: string | undefined

export function mapFinishReason(
  reason: string | undefined,
): LanguageModelV2FinishReason {
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
