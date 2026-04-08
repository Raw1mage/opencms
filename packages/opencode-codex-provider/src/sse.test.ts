/**
 * sse.test.ts — Verify critical SSE mapping fixes.
 *
 * Tests:
 * 1. finishReason = "tool-calls" when function_call present
 * 2. text-end flush when stream ends with dangling text
 * 3. text-start auto-emit when delta arrives before output_item.added
 * 4. response.incomplete → finishReason "length"
 */
import { describe, test, expect } from "bun:test"
import { mapResponseStream } from "./sse"
import type { ResponseStreamEvent } from "./types"

function makeEventStream(events: ResponseStreamEvent[]): ReadableStream<ResponseStreamEvent> {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(e)
      controller.close()
    },
  })
}

async function collectParts(events: ResponseStreamEvent[]) {
  const { stream } = mapResponseStream(makeEventStream(events))
  const reader = stream.getReader()
  const parts: any[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

describe("sse mapResponseStream", () => {
  test("finishReason = tool-calls when function_call present", async () => {
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_1" } } as any,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"/tmp/x"}' },
      } as any,
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"/tmp/x"}' },
      } as any,
      {
        type: "response.completed",
        response: { id: "resp_1", status: "completed", usage: { input_tokens: 100, output_tokens: 50 } },
      } as any,
    ])

    const finish = parts.find((p: any) => p.type === "finish")
    expect(finish).toBeDefined()
    expect(finish.finishReason).toBe("tool-calls")
  })

  test("finishReason = stop when no function_call", async () => {
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_2" } } as any,
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } } as any,
      { type: "response.output_text.delta", output_index: 0, delta: "Hello" } as any,
      { type: "response.output_text.done", output_index: 0, text: "Hello" } as any,
      {
        type: "response.completed",
        response: { id: "resp_2", status: "completed", usage: { input_tokens: 50, output_tokens: 10 } },
      } as any,
    ])

    const finish = parts.find((p: any) => p.type === "finish")
    expect(finish.finishReason).toBe("stop")
  })

  test("text-end flush when stream ends with dangling text", async () => {
    // No response.output_text.done event — text left dangling
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_3" } } as any,
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } } as any,
      { type: "response.output_text.delta", output_index: 0, delta: "Hello world" } as any,
      // NO response.output_text.done — dangling!
      {
        type: "response.completed",
        response: { id: "resp_3", status: "completed", usage: { input_tokens: 50, output_tokens: 10 } },
      } as any,
    ])

    const textEnd = parts.filter((p: any) => p.type === "text-end")
    expect(textEnd.length).toBe(1) // flush should emit text-end
    // text-end should come BEFORE finish
    const textEndIdx = parts.findIndex((p: any) => p.type === "text-end")
    const finishIdx = parts.findIndex((p: any) => p.type === "finish")
    expect(textEndIdx).toBeLessThan(finishIdx)
  })

  test("text-start auto-emit when delta arrives before output_item.added", async () => {
    // delta arrives with no prior text-start
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_4" } } as any,
      // NO output_item.added — delta comes directly
      { type: "response.output_text.delta", output_index: 0, delta: "Surprise" } as any,
      { type: "response.output_text.done", output_index: 0, text: "Surprise" } as any,
      {
        type: "response.completed",
        response: { id: "resp_4", status: "completed", usage: { input_tokens: 50, output_tokens: 10 } },
      } as any,
    ])

    const textStart = parts.filter((p: any) => p.type === "text-start")
    expect(textStart.length).toBe(1) // auto-emitted
    // text-start should come before text-delta
    const startIdx = parts.findIndex((p: any) => p.type === "text-start")
    const deltaIdx = parts.findIndex((p: any) => p.type === "text-delta")
    expect(startIdx).toBeLessThan(deltaIdx)
  })

  test("response.incomplete → finishReason length", async () => {
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_5" } } as any,
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } } as any,
      { type: "response.output_text.delta", output_index: 0, delta: "Truncated..." } as any,
      { type: "response.output_text.done", output_index: 0, text: "Truncated..." } as any,
      {
        type: "response.incomplete",
        response: {
          id: "resp_5",
          status: "incomplete",
          usage: { input_tokens: 50, output_tokens: 128000 },
          incomplete_details: { reason: "max_output_tokens" },
        },
      } as any,
    ])

    const finish = parts.find((p: any) => p.type === "finish")
    expect(finish.finishReason).toBe("length")
  })

  test("tool-call emitted with correct arguments from output_item.done", async () => {
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_6" } } as any,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file" },
      } as any,
      // Streaming deltas may be obfuscated
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" } as any,
      // Done event has REAL arguments
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"/etc/hosts"}' },
      } as any,
      {
        type: "response.completed",
        response: { id: "resp_6", status: "completed", usage: { input_tokens: 100, output_tokens: 50 } },
      } as any,
    ])

    const toolCall = parts.find((p: any) => p.type === "tool-call")
    expect(toolCall).toBeDefined()
    expect(toolCall.toolName).toBe("read_file")
    expect(toolCall.input).toBe('{"path":"/etc/hosts"}')
    expect(toolCall.toolCallId).toBe("call_1")
  })

  test("usage captured correctly", async () => {
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_7" } } as any,
      {
        type: "response.completed",
        response: {
          id: "resp_7",
          status: "completed",
          usage: {
            input_tokens: 5000,
            output_tokens: 1200,
            input_tokens_details: { cached_tokens: 3000 },
            output_tokens_details: { reasoning_tokens: 400 },
          },
        },
      } as any,
    ])

    const finish = parts.find((p: any) => p.type === "finish")
    expect(finish.usage.inputTokens).toBe(5000)
    expect(finish.usage.outputTokens).toBe(1200)
    expect(finish.usage.cachedInputTokens).toBe(3000)
    expect(finish.usage.reasoningTokens).toBe(400)
  })
})
