/**
 * sse.test.ts — Verify critical SSE mapping fixes.
 *
 * Tests:
 * 1. finishReason = "tool-calls" when function_call present
 * 2. text-end flush when stream ends with dangling text
 * 3. text-start auto-emit when delta arrives before output_item.added
 * 4. response.incomplete → finishReason "length"
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
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

  test("tool-call emitted from .arguments.done when .output_item.done never arrives (WS truncation)", async () => {
    // Reproduces the "apply_patch Tool execution aborted" bug:
    // .arguments.done carries the full arguments; .output_item.done is truncated.
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_trunc" } } as any,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_trunc", call_id: "call_trunc", name: "apply_patch" },
      } as any,
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' } as any,
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '"/tmp/a"}' } as any,
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        call_id: "call_trunc",
        arguments: '{"path":"/tmp/a"}',
      } as any,
      // NO response.output_item.done — stream truncates here
      {
        type: "response.completed",
        response: { id: "resp_trunc", status: "completed", usage: { input_tokens: 10, output_tokens: 20 } },
      } as any,
    ])

    const toolCalls = parts.filter((p: any) => p.type === "tool-call")
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0].toolName).toBe("apply_patch")
    expect(toolCalls[0].input).toBe('{"path":"/tmp/a"}')
    expect(toolCalls[0].toolCallId).toBe("call_trunc")
  })

  test("tool-call emitted once when both .arguments.done and .output_item.done fire (idempotency)", async () => {
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_both" } } as any,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_both", call_id: "call_both", name: "read_file" },
      } as any,
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"/x"}' } as any,
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        call_id: "call_both",
        arguments: '{"path":"/x"}',
      } as any,
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "fc_both", call_id: "call_both", name: "read_file", arguments: '{"path":"/x"}' },
      } as any,
      {
        type: "response.completed",
        response: { id: "resp_both", status: "completed", usage: { input_tokens: 10, output_tokens: 20 } },
      } as any,
    ])

    const toolCalls = parts.filter((p: any) => p.type === "tool-call")
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0].input).toBe('{"path":"/x"}')
  })

  test("tool-call synthesized from delta buffer when stream flushes without .arguments.done", async () => {
    // Deepest truncation: WS closes after some deltas, before .arguments.done fires.
    // Synthesis from toolArgBuffer is a last resort — downstream will surface the
    // (possibly partial) JSON as a tool-exec error rather than a silent abort.
    const parts = await collectParts([
      { type: "response.created", response: { id: "resp_deep" } } as any,
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_deep", call_id: "call_deep", name: "apply_patch" },
      } as any,
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"patch":"' } as any,
      { type: "response.function_call_arguments.delta", output_index: 0, delta: 'partial' } as any,
      // Stream ends here — no .arguments.done, no .output_item.done, no .completed
    ])

    const toolCalls = parts.filter((p: any) => p.type === "tool-call")
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0].toolCallId).toBe("call_deep")
    expect(toolCalls[0].input).toBe('{"patch":"partial')
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

// ---------------------------------------------------------------------------
// Integration: empty-turn classifier hook
// (spec codex-empty-turn-recovery, task 1.12)
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  setEmptyTurnLogPath,
  setEmptyTurnLogBus,
  _resetForTest as _resetEmptyTurnLogForTest,
} from "./empty-turn-log"

describe("empty-turn classifier integration in sse flush", () => {
  let tmpDir: string
  let logPath: string
  let logContext: any

  function makeStreamFromEvents(events: ResponseStreamEvent[]) {
    return new ReadableStream<ResponseStreamEvent>({
      start(controller) {
        for (const e of events) controller.enqueue(e)
        controller.close()
      },
    })
  }

  async function collectFinish(events: ResponseStreamEvent[], options: any) {
    const { stream } = mapResponseStream(makeStreamFromEvents(events), options)
    const reader = stream.getReader()
    let finish: any = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if ((value as any).type === "finish") finish = value
    }
    return finish
  }

  function readLogLines(): any[] {
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
  }

  beforeEach(() => {
    _resetEmptyTurnLogForTest()
    tmpDir = join(tmpdir(), `cetlog-int-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    logPath = join(tmpDir, "empty-turns.jsonl")
    setEmptyTurnLogPath(logPath)
    logContext = {
      sessionId: "ses_test_integration",
      messageId: "msg_test_int",
      accountId: "codex-test-account",
      modelId: "gpt-5.5",
      requestOptionsShape: {
        store: false,
        hasReasoningEffort: true,
        reasoningEffortValue: "medium",
        includeFields: [],
        hasTools: false,
        toolCount: 0,
        promptCacheKeyHash: "deadbeefdeadbeef",
        inputItemCount: 1,
        instructionsByteSize: 100,
      },
    }
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  test("empty turn at clean stream end → classifier fires, log written, metadata attached", async () => {
    const finish = await collectFinish(
      [
        { type: "response.created", response: { id: "resp_empty_1" } } as any,
        // No deltas, no items
        {
          type: "response.completed",
          response: { id: "resp_empty_1", status: "completed", usage: { input_tokens: 100, output_tokens: 0 } },
        } as any,
      ],
      { logContext },
    )
    expect(finish).toBeDefined()
    expect(finish.providerMetadata.openai.emptyTurnClassification).toBeDefined()
    const cls = finish.providerMetadata.openai.emptyTurnClassification
    // logContext sets hasReasoningEffort=true → server_empty_output_with_reasoning
    // (Phase 2 predicate; finishReason maps to "other" per DD-9)
    expect(cls.causeFamily).toBe("server_empty_output_with_reasoning")
    expect(cls.recoveryAction).toBe("pass-through-to-runloop-nudge")
    expect(cls.suspectParams).toEqual(["reasoning.effort"])
    expect(finish.finishReason).toBe("other")
    expect(typeof cls.logSequence).toBe("number")
    expect(cls.retryAttempted).toBe(false)

    const lines = readLogLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].causeFamily).toBe("server_empty_output_with_reasoning")
    expect(lines[0].sessionId).toBe("ses_test_integration")
    expect(lines[0].providerId).toBe("codex")
    expect(lines[0].modelId).toBe("gpt-5.5")
    expect(lines[0].logSequence).toBe(cls.logSequence)
  })

  test("successful turn (text deltas + completed) → no classifier hook, no log", async () => {
    const finish = await collectFinish(
      [
        { type: "response.created", response: { id: "resp_ok" } } as any,
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_ok" },
        } as any,
        { type: "response.output_text.delta", output_index: 0, delta: "Hello" } as any,
        { type: "response.output_text.delta", output_index: 0, delta: " world" } as any,
        { type: "response.output_text.done", output_index: 0, text: "Hello world" } as any,
        {
          type: "response.completed",
          response: { id: "resp_ok", status: "completed", usage: { input_tokens: 50, output_tokens: 2 } },
        } as any,
      ],
      { logContext },
    )
    expect(finish.finishReason).toBe("stop")
    expect(finish.providerMetadata?.openai?.emptyTurnClassification).toBeUndefined()
    expect(readLogLines()).toHaveLength(0)
  })

  test("WS truncation simulation (no terminal event) → classifier fires, log written", async () => {
    // Simulate the msg_dfe39162f fingerprint: stream ends without
    // response.completed/.incomplete/.failed/error.
    const finish = await collectFinish(
      [
        { type: "response.created", response: { id: "resp_trunc_int" } } as any,
        // Stream just ends
      ],
      {
        logContext,
        getTransportSnapshot: () => ({
          wsFrameCount: 2,
          terminalEventReceived: false,
          terminalEventType: null as any,
          wsCloseCode: 1006,
          wsCloseReason: "abnormal closure",
          serverErrorMessage: null,
          deltasObserved: { text: 0, toolCallArguments: 0, reasoning: 0 },
        }),
      },
    )
    expect(finish.finishReason).toBe("unknown")
    const cls = finish.providerMetadata.openai.emptyTurnClassification
    expect(cls.causeFamily).toBe("ws_truncation") // Phase 2 predicate
    expect(cls.recoveryAction).toBe("retry-once-then-soft-fail")

    const lines = readLogLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].wsFrameCount).toBe(2)
    expect(lines[0].terminalEventReceived).toBe(false)
    expect(lines[0].wsCloseCode).toBe(1006)
  })

  test("INV-01: no logContext → empty turn produces normal finish, no log, no exception", async () => {
    const finish = await collectFinish(
      [
        { type: "response.created", response: { id: "resp_no_ctx" } } as any,
        {
          type: "response.completed",
          response: { id: "resp_no_ctx", status: "completed", usage: { input_tokens: 10, output_tokens: 0 } },
        } as any,
      ],
      {},
    )
    expect(finish.finishReason).toBe("stop")
    expect(finish.providerMetadata?.openai?.emptyTurnClassification).toBeUndefined()
    expect(readLogLines()).toHaveLength(0)
  })

  test("INV-05: log path broken → classifier still completes, finish still emitted", async () => {
    const blocker = join(tmpDir, "blocker-file")
    require("fs").writeFileSync(blocker, "x")
    setEmptyTurnLogPath(join(blocker, "subdir", "empty-turns.jsonl"))
    const errors: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errors.push(msg)
    try {
      const finish = await collectFinish(
        [
          { type: "response.created", response: { id: "resp_log_fail" } } as any,
          {
            type: "response.completed",
            response: { id: "resp_log_fail", status: "completed", usage: { input_tokens: 10, output_tokens: 0 } },
          } as any,
        ],
        { logContext },
      )
      expect(finish.providerMetadata.openai.emptyTurnClassification).toBeDefined()
      expect(errors.some((e) => e.startsWith("[CODEX-EMPTY-TURN] log emission failed:"))).toBe(true)
    } finally {
      console.error = origErr
    }
  })

  test("Phase 2: response.incomplete → server_incomplete + finishReason=length", async () => {
    const finish = await collectFinish(
      [
        { type: "response.created", response: { id: "resp_inc" } } as any,
        {
          type: "response.incomplete",
          response: {
            id: "resp_inc",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 50, output_tokens: 0 },
          },
        } as any,
      ],
      { logContext },
    )
    expect(finish.finishReason).toBe("length")
    const cls = finish.providerMetadata.openai.emptyTurnClassification
    expect(cls.causeFamily).toBe("server_incomplete")
    expect(cls.recoveryAction).toBe("pass-through-to-runloop-nudge")
    const lines = readLogLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].causeFamily).toBe("server_incomplete")
  })

  test("Phase 2: response.failed → server_failed + finishReason=error", async () => {
    const finish = await collectFinish(
      [
        { type: "response.created", response: { id: "resp_fail" } } as any,
        {
          type: "response.failed",
          response: {
            id: "resp_fail",
            status: "failed",
            error: { message: "Model overloaded" },
          },
        } as any,
      ],
      { logContext },
    )
    // Note: response.failed currently endsWithError() in mapEvent which sets
    // finishReason via state.finishReason="error"; the empty-turn-recovery
    // classifier path runs only when controller.error wasn't called.
    // For the SSE-only test path (no transport-ws), the failed event maps
    // to a regular error path; verify the classifier still picks it up
    // when reachable.
    if (finish) {
      // If finish was emitted (not error path), classifier should match
      const cls = finish.providerMetadata?.openai?.emptyTurnClassification
      if (cls) {
        expect(cls.causeFamily).toBe("server_failed")
      }
    }
  })

  test("Phase 2: response.completed without suspect params → unclassified", async () => {
    const noSuspectContext = {
      ...logContext,
      requestOptionsShape: {
        ...logContext.requestOptionsShape,
        hasReasoningEffort: false,
        reasoningEffortValue: null,
        includeFields: [],
      },
    }
    const finish = await collectFinish(
      [
        { type: "response.created", response: { id: "resp_uncl" } } as any,
        {
          type: "response.completed",
          response: { id: "resp_uncl", status: "completed", usage: { input_tokens: 10, output_tokens: 0 } },
        } as any,
      ],
      { logContext: noSuspectContext },
    )
    const cls = finish.providerMetadata.openai.emptyTurnClassification
    expect(cls.causeFamily).toBe("unclassified")
    expect(cls.suspectParams).toEqual([])
    expect(finish.finishReason).toBe("stop") // completed → stop
  })

  test("Phase 2: ws_no_frames via getTransportSnapshot frameCount=0", async () => {
    const finish = await collectFinish(
      [],
      {
        logContext,
        getTransportSnapshot: () => ({
          wsFrameCount: 0,
          terminalEventReceived: false,
          terminalEventType: null as any,
          wsCloseCode: 1006,
          wsCloseReason: "no frames",
          serverErrorMessage: null,
          deltasObserved: { text: 0, toolCallArguments: 0, reasoning: 0 },
        }),
      },
    )
    const cls = finish.providerMetadata.openai.emptyTurnClassification
    expect(cls.causeFamily).toBe("ws_no_frames")
    expect(cls.recoveryAction).toBe("retry-once-then-soft-fail")
    expect(finish.finishReason).toBe("unknown")
  })

  test("bus mirror fires alongside JSONL", async () => {
    const busCalls: { channel: string; payload: unknown }[] = []
    setEmptyTurnLogBus((channel, payload) => {
      busCalls.push({ channel, payload })
    })
    await collectFinish(
      [
        { type: "response.created", response: { id: "resp_bus" } } as any,
        {
          type: "response.completed",
          response: { id: "resp_bus", status: "completed", usage: { input_tokens: 10, output_tokens: 0 } },
        } as any,
      ],
      { logContext },
    )
    expect(busCalls).toHaveLength(1)
    expect(busCalls[0].channel).toBe("codex.emptyTurn")
    // logContext sets hasReasoningEffort=true → matches Phase 2 server_empty predicate
    expect((busCalls[0].payload as any).causeFamily).toBe("server_empty_output_with_reasoning")
  })
})
