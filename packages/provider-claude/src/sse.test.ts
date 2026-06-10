/**
 * sse.test.ts — Anthropic SSE parser regression tests.
 *
 * Focus: the truncated-stream guard. Anthropic's SSE contract guarantees a
 * terminal `message_stop` event. When the connection drops mid-response the
 * stream closes (reader done) WITHOUT it — observed in production as a silent
 * empty turn (step-start, then zero content, finishReason "unknown", tokens 0,
 * host runloop stalls → "只說不做").
 *
 * DB evidence motivating these tests: session ses_1890b118affe…, assistant
 * message …8L6dRw — a single `step-start` part, empty finish, 0 tokens.
 *
 * Fix under test: parseAnthropicSSE's done-branch emits an `error` part when
 * `message_stop` never arrived, routing the host to its `case "error": throw`
 * path (retry/rotation) instead of a silent stall.
 */
import { describe, test, expect } from "bun:test"
import { parseAnthropicSSE, mapFinishReason } from "./sse"
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider"

/** Encode an array of raw SSE lines into a single-chunk byte stream. */
function makeByteStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function collectParts(raw: string): Promise<LanguageModelV2StreamPart[]> {
  const stream = parseAnthropicSSE(makeByteStream(raw))
  const reader = stream.getReader()
  const parts: LanguageModelV2StreamPart[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

/** Minimal well-formed Anthropic SSE: a text block + proper terminal events. */
const WELL_FORMED =
  `event: message_start\n` +
  `data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":10}}}\n\n` +
  `event: content_block_start\n` +
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
  `event: content_block_delta\n` +
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
  `event: content_block_stop\n` +
  `data: {"type":"content_block_stop","index":0}\n\n` +
  `event: message_delta\n` +
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n` +
  `event: message_stop\n` +
  `data: {"type":"message_stop"}\n\n`

/** Same prefix as WELL_FORMED but the connection drops before message_stop. */
const TRUNCATED =
  `event: message_start\n` +
  `data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":10}}}\n\n`

describe("parseAnthropicSSE — terminal contract", () => {
  test("well-formed stream emits a finish (stop) and NO error", async () => {
    const parts = await collectParts(WELL_FORMED)
    const finish = parts.find((p) => p.type === "finish")
    const error = parts.find((p) => p.type === "error")
    expect(finish).toBeDefined()
    expect((finish as any).finishReason).toBe("stop")
    expect(error).toBeUndefined()
  })

  // Regression guard for the empty-turn stall: a stream that closes before
  // message_stop MUST surface an error part (fail fast), never close silently.
  test("truncated stream (no message_stop) emits an error part", async () => {
    const parts = await collectParts(TRUNCATED)
    const error = parts.find((p) => p.type === "error")
    const finish = parts.find((p) => p.type === "finish")
    expect(error).toBeDefined()
    expect(String((error as any).error)).toContain("message_stop")
    // No synthetic finish — the host must treat this as a hard error → retry.
    expect(finish).toBeUndefined()
  })

  test("a stream that never produced any frame still errors (not silent)", async () => {
    const parts = await collectParts("")
    const error = parts.find((p) => p.type === "error")
    expect(error).toBeDefined()
  })
})

describe("mapFinishReason", () => {
  test("maps Anthropic stop_reason values", () => {
    expect(mapFinishReason("end_turn")).toBe("stop")
    expect(mapFinishReason("tool_use")).toBe("tool-calls")
    expect(mapFinishReason("max_tokens")).toBe("length")
    expect(mapFinishReason(undefined)).toBe("other")
  })

  // Regression: every documented stop_reason must map to a TERMINAL finish, not
  // the catch-all "other" — collapsing a real stop to "other" is the host
  // re-fire loop (Fable at large context: refusal/model_context_window_exceeded
  // → "other" → never breaks). Only a genuinely unknown reason may be "other".
  test("all current Anthropic stop_reasons map to terminal finishes", () => {
    expect(mapFinishReason("stop_sequence")).toBe("stop")
    expect(mapFinishReason("pause_turn")).toBe("stop")
    expect(mapFinishReason("refusal")).toBe("content-filter")
    expect(mapFinishReason("content_filter")).toBe("content-filter")
    expect(mapFinishReason("model_context_window_exceeded")).toBe("length")
    // Only a truly unknown reason falls back to "other".
    expect(mapFinishReason("some_future_reason")).toBe("other")
  })
})

describe("finish part preserves raw stop_reason (faithful record)", () => {
  test("rawStopReason carries the verbatim Anthropic stop_reason", async () => {
    const stream =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"id":"msg_1","model":"claude-fable-5","usage":{"input_tokens":2}}}\n\n` +
      `event: message_delta\n` +
      `data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":2}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`
    const parts = await collectParts(stream)
    const finish = parts.find((p) => p.type === "finish") as any
    expect(finish).toBeDefined()
    expect(finish.finishReason).toBe("content-filter")
    expect(finish.providerMetadata?.anthropic?.rawStopReason).toBe("refusal")
  })

  test("rawStopReason is null (not dropped) when absent", async () => {
    const stream =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"id":"msg_1","model":"claude-fable-5","usage":{"input_tokens":2}}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`
    const parts = await collectParts(stream)
    const finish = parts.find((p) => p.type === "finish") as any
    expect(finish.providerMetadata?.anthropic?.rawStopReason).toBeNull()
  })
})
