/**
 * Stream-level test for ANTML tool-call salvage in parseAnthropicSSE.
 *
 * Incident 2026-05-30 (ses_189df799…): opus-4-8 leaked tool calls as text
 * (<invoke …>) in a text block with stop_reason=end_turn. We verify the parser
 * now (a) emits a real tool-call part with the prefix stripped, and (b) forces
 * finishReason to "tool-calls" so the host runloop dispatches it.
 */
import { describe, test, expect } from "bun:test"
import { parseAnthropicSSE } from "./sse"
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider"

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

function sse(eventType: string, data: object): string {
  return `event: ${eventType}\n` + `data: ${JSON.stringify({ type: eventType, ...data })}\n\n`
}

describe("parseAnthropicSSE — ANTML salvage", () => {
  test("leaked <invoke> text becomes a real tool-call and forces finish=tool-calls", async () => {
    const leaked =
      "course\n" +
      '<invoke name="mcp__bash">\n' +
      '<parameter name="command">echo hi</parameter>\n' +
      "</invoke>"
    const raw =
      sse("message_start", { message: { id: "msg_1", model: "claude-opus-4-8", usage: { input_tokens: 10 } } }) +
      sse("content_block_start", { index: 0, content_block: { type: "text" } }) +
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: leaked } }) +
      sse("content_block_stop", { index: 0 }) +
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
      sse("message_stop", {})

    const parts = await collectParts(raw)
    const toolCalls = parts.filter((p) => p.type === "tool-call") as any[]
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0].toolName).toBe("bash") // mcp__ prefix stripped
    expect(JSON.parse(toolCalls[0].input).command).toBe("echo hi")

    const finish = parts.find((p) => p.type === "finish") as any
    expect(finish.finishReason).toBe("tool-calls") // overridden from end_turn
  })

  test("normal text turn is untouched (finish=stop, no tool-call)", async () => {
    const raw =
      sse("message_start", { message: { id: "msg_2", model: "claude-opus-4-8", usage: { input_tokens: 3 } } }) +
      sse("content_block_start", { index: 0, content_block: { type: "text" } }) +
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "just a normal answer" } }) +
      sse("content_block_stop", { index: 0 }) +
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }) +
      sse("message_stop", {})

    const parts = await collectParts(raw)
    expect(parts.filter((p) => p.type === "tool-call").length).toBe(0)
    const finish = parts.find((p) => p.type === "finish") as any
    expect(finish.finishReason).toBe("stop")
  })
})
