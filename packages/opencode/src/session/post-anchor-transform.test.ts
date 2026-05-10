import { afterEach, describe, expect, it, mock } from "bun:test"
import { redactToolPart, transformPostAnchorTail, __test__ } from "./post-anchor-transform"
import { Tweaks } from "../config/tweaks"
import type { MessageV2 } from "./message-v2"

const originalTweaksSync = Tweaks.compactionSync

afterEach(() => {
  ;(Tweaks as any).compactionSync = originalTweaksSync
})

function stubTweaks(overrides: Record<string, unknown> = {}) {
  ;(Tweaks as any).compactionSync = mock(() => ({
    ...originalTweaksSync(),
    ...overrides,
  }))
}

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

function anchorMsg(id: string = "msg_anchor"): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "assistant",
      parentID: "p",
      modelID: "gpt-5.5",
      providerId: "codex",
      mode: "primary",
      agent: "default",
      path: { cwd: ".", root: "." },
      summary: true,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      time: { created: 0, completed: 1 },
    } as MessageV2.Assistant,
    parts: [
      {
        id: `prt_${id}`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text: "anchor body",
        time: { start: 0, end: 1 },
      } as MessageV2.TextPart,
    ],
  }
}

function userMsg(id: string, text: string = "hi"): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
    } as MessageV2.User,
    parts: [
      {
        id: `prt_${id}`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text,
        time: { start: 1, end: 2 },
      } as MessageV2.TextPart,
    ],
  }
}

interface AssistantOpts {
  text?: string
  reasoning?: string
  tools?: Array<{
    id: string
    tool: string
    status?: "completed" | "error" | "pending" | "running"
    output?: string
    input?: Record<string, unknown>
  }>
  compactionPart?: boolean
}

function assistantMsg(
  id: string,
  finish: MessageV2.Assistant["finish"],
  opts: AssistantOpts = {},
): MessageV2.WithParts {
  const parts: MessageV2.Part[] = []
  if (opts.reasoning) {
    parts.push({
      id: `prt_${id}_r`,
      messageID: id,
      sessionID: "ses_test",
      type: "reasoning",
      text: opts.reasoning,
      time: { start: 1, end: 2 },
    } as MessageV2.ReasoningPart)
  }
  if (opts.text) {
    parts.push({
      id: `prt_${id}_t`,
      messageID: id,
      sessionID: "ses_test",
      type: "text",
      text: opts.text,
      time: { start: 2, end: 3 },
    } as MessageV2.TextPart)
  }
  for (const t of opts.tools ?? []) {
    const status = t.status ?? "completed"
    const baseState = { status, input: t.input ?? {} } as Record<string, unknown>
    if (status === "completed") {
      Object.assign(baseState, {
        output: t.output ?? "RAW_OUTPUT_PAYLOAD",
        title: "",
        metadata: {},
        time: { start: 1, end: 2 },
      })
    } else if (status === "error") {
      Object.assign(baseState, { error: "OOPS", time: { start: 1, end: 2 } })
    } else if (status === "pending") {
      Object.assign(baseState, { raw: "{}" })
    } else if (status === "running") {
      Object.assign(baseState, { time: { start: 1 } })
    }
    parts.push({
      id: t.id,
      messageID: id,
      sessionID: "ses_test",
      type: "tool",
      callID: t.id,
      tool: t.tool,
      state: baseState as MessageV2.ToolPart["state"],
    } as MessageV2.ToolPart)
  }
  if (opts.compactionPart) {
    parts.push({
      id: `prt_${id}_c`,
      messageID: id,
      sessionID: "ses_test",
      type: "compaction",
      observed: "manual",
      kind: "narrative",
    } as any)
  }
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "assistant",
      parentID: "p",
      modelID: "gpt-5.5",
      providerId: "codex",
      mode: "primary",
      agent: "default",
      path: { cwd: ".", root: "." },
      summary: false,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish,
      time: { created: 2, completed: 3 },
    } as MessageV2.Assistant,
    parts,
  }
}

// ─────────────────────────────────────────────────────────────────────
// redactToolPart
// ─────────────────────────────────────────────────────────────────────

describe("redactToolPart", () => {
  it("replaces output with [recall_id: <part.id>] for completed status", () => {
    const part: MessageV2.ToolPart = {
      id: "prt_x",
      messageID: "m",
      sessionID: "s",
      type: "tool",
      callID: "prt_x",
      tool: "read",
      state: {
        status: "completed",
        input: { f: "y" },
        output: "RAW_DATA",
        title: "",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }
    const out = redactToolPart(part)
    expect((out.state as any).output).toBe("[recall_id: prt_x]")
    expect((out.state as any).input).toEqual({ f: "y" })
    expect(out.tool).toBe("read")
    expect(out.id).toBe("prt_x")
  })

  it("idempotent — already-redacted output passes through unchanged", () => {
    const part: MessageV2.ToolPart = {
      id: "prt_x",
      messageID: "m",
      sessionID: "s",
      type: "tool",
      callID: "prt_x",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "[recall_id: prt_x]",
        title: "",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }
    const out = redactToolPart(part)
    expect(out).toBe(part) // same reference
  })

  it("error-status tool part is NOT redacted (preserved verbatim)", () => {
    const part: MessageV2.ToolPart = {
      id: "prt_e",
      messageID: "m",
      sessionID: "s",
      type: "tool",
      callID: "prt_e",
      tool: "shell",
      state: {
        status: "error",
        input: {},
        error: "command failed",
        time: { start: 0, end: 1 },
      },
    }
    const out = redactToolPart(part)
    expect(out).toBe(part)
  })
})

// ─────────────────────────────────────────────────────────────────────
// transformPostAnchorTail v7 (default flag=true) — retired to pass-through
// ─────────────────────────────────────────────────────────────────────
//
// 2026-05-10: v7 was originally a render-time redactor that replaced every
// completed tool output with `[recall_id: <part.id>]`. Production observation
// showed this blinded the model to its own just-completed tool result inside
// the same multi-step assistant turn, triggering recall_toolcall_raw spam and
// bash replays. v7 is now a pass-through — redaction is a one-time event at
// compaction extend (`tryNarrative` → `serializeRedactedDialog`), not a
// render-time state.

describe("transformPostAnchorTail v7 (pass-through, post-retirement)", () => {
  it("empty input → empty output, all counters zero", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const result = transformPostAnchorTail([])
    expect(result.messages).toEqual([])
    expect(result.transformedTurnCount).toBe(0)
    expect(result.redactedToolPartCount).toBe(0)
  })

  it("preserves all messages — multi-task continuity (no drops)", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const msgs: MessageV2.WithParts[] = [
      anchorMsg(),
      userMsg("u1", "first task"),
      assistantMsg("a1", "stop", { text: "first answer" }),
      userMsg("u2", "second task"),
      assistantMsg("a2", "stop", { text: "second answer" }),
      userMsg("u3", "current question"),
    ]
    const result = transformPostAnchorTail(msgs)
    expect(result.messages).toBe(msgs) // pass-through, same reference
    expect(result.transformedTurnCount).toBe(0)
    expect(result.redactedToolPartCount).toBe(0)
  })

  it("does NOT redact completed tool output — payload stays raw", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const msgs: MessageV2.WithParts[] = [
      anchorMsg(),
      userMsg("u1", "go"),
      assistantMsg("a1", "tool-calls", {
        tools: [{ id: "prt_tool_X", tool: "read", output: "BIG_FILE_CONTENTS" }],
      }),
    ]
    const result = transformPostAnchorTail(msgs)
    const a1 = result.messages[2]
    const toolPart = a1.parts.find((p) => p.type === "tool") as MessageV2.ToolPart
    expect((toolPart.state as any).output).toBe("BIG_FILE_CONTENTS")
    expect(result.redactedToolPartCount).toBe(0)
  })

  it("preserves text + reasoning + tool args + tool output verbatim", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const msgs: MessageV2.WithParts[] = [
      anchorMsg(),
      userMsg("u1", "go"),
      assistantMsg("a1", "stop", {
        reasoning: "internal CoT here",
        text: "user-visible answer",
        tools: [
          { id: "prt_t1", tool: "grep", input: { pattern: "X" }, output: "GREP_RESULTS" },
        ],
      }),
    ]
    const result = transformPostAnchorTail(msgs)
    const a1 = result.messages[2]
    const reasoning = a1.parts.find((p) => p.type === "reasoning") as MessageV2.ReasoningPart
    const text = a1.parts.find((p) => p.type === "text") as MessageV2.TextPart
    const tool = a1.parts.find((p) => p.type === "tool") as MessageV2.ToolPart
    expect(reasoning.text).toBe("internal CoT here")
    expect(text.text).toBe("user-visible answer")
    expect((tool.state as any).input).toEqual({ pattern: "X" })
    expect((tool.state as any).output).toBe("GREP_RESULTS")
  })

  it("multi-step assistant: step 2 sees step 1's tool output verbatim (regression guard)", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    // Simulate a multi-step assistant turn where step 1 (Glob) just completed
    // and step 2 is about to start. Pre-fix v7 would have redacted the Glob
    // output here, blinding step 2 to its own immediately-prior result.
    const stepBoundaryAssistant = assistantMsg("a_multi", "tool-calls", {
      tools: [{ id: "prt_glob1", tool: "glob", output: "/path/a\n/path/b\n/path/c" }],
    })
    const msgs = [anchorMsg(), userMsg("u1", "list /path"), stepBoundaryAssistant]
    const result = transformPostAnchorTail(msgs)
    const tp = result.messages[2].parts.find((p) => p.type === "tool") as MessageV2.ToolPart
    expect((tp.state as any).output).toBe("/path/a\n/path/b\n/path/c")
  })

  it("anchor at index 0 not touched", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const anchor = anchorMsg()
    anchor.parts.push({
      id: "prt_anchor_tool",
      messageID: anchor.info.id,
      sessionID: "ses_test",
      type: "tool",
      callID: "prt_anchor_tool",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "anchor-embedded output",
        title: "",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as MessageV2.ToolPart)
    const result = transformPostAnchorTail([anchor])
    const tp = result.messages[0].parts.find((p) => p.type === "tool") as MessageV2.ToolPart
    expect((tp.state as any).output).toBe("anchor-embedded output")
    expect(result.redactedToolPartCount).toBe(0)
  })

  it("user messages pass through unchanged regardless of position", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const msgs = [anchorMsg(), userMsg("u1", "first"), userMsg("u2", "second")]
    const result = transformPostAnchorTail(msgs)
    expect(result.messages[1]).toBe(msgs[1])
    expect(result.messages[2]).toBe(msgs[2])
  })

  it("error-status tool part stays visible verbatim", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const a1 = assistantMsg("a1", "tool-calls", {
      tools: [{ id: "prt_err", tool: "shell", status: "error" }],
    })
    const result = transformPostAnchorTail([anchorMsg(), userMsg("u1"), a1])
    const tp = result.messages[2].parts.find((p) => p.type === "tool") as MessageV2.ToolPart
    expect((tp.state as any).error).toBe("OOPS")
    expect(result.redactedToolPartCount).toBe(0)
  })

  it("returns input array by reference (no clone, no allocation)", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const a1 = assistantMsg("a1", "stop", { text: "ans, no tools" })
    const msgs = [anchorMsg(), userMsg("u1"), a1]
    const result = transformPostAnchorTail(msgs)
    expect(result.messages).toBe(msgs)
  })
})

// ─────────────────────────────────────────────────────────────────────
// transformPostAnchorTail v6 (legacy, flag=false)
// ─────────────────────────────────────────────────────────────────────

describe("transformPostAnchorTail v6 (legacy fallback)", () => {
  it("flag=false → drops completed assistants before lastUserIdx", () => {
    stubTweaks({ enableDialogRedactionAnchor: false })
    const msgs: MessageV2.WithParts[] = [
      anchorMsg(),
      userMsg("u1", "first task"),
      assistantMsg("a1_old", "stop", { text: "old answer" }), // dropped
      userMsg("u2", "current task"),
      assistantMsg("a2_current", "stop", { text: "current answer" }), // kept
    ]
    const result = transformPostAnchorTail(msgs)
    expect(result.messages).toHaveLength(4)
    expect(result.transformedTurnCount).toBe(1)
    expect(result.messages.find((m) => m.info.id === "a1_old")).toBeUndefined()
    expect(result.messages.find((m) => m.info.id === "a2_current")).toBeDefined()
  })

  it("flag=false + no user msg in tail → drops nothing (matches v6 conservative behaviour)", () => {
    stubTweaks({ enableDialogRedactionAnchor: false })
    const msgs = [anchorMsg(), assistantMsg("a1", "stop", { text: "x" })]
    const result = transformPostAnchorTail(msgs)
    expect(result.messages).toHaveLength(2)
    expect(result.transformedTurnCount).toBe(0)
  })

  it("flag=false → does NOT redact tool outputs (v6 leaves payloads intact)", () => {
    stubTweaks({ enableDialogRedactionAnchor: false })
    const msgs = [
      anchorMsg(),
      userMsg("u1", "go"),
      assistantMsg("a1", "tool-calls", {
        tools: [{ id: "prt_x", tool: "read", output: "RAW_PAYLOAD" }],
      }),
    ]
    const result = transformPostAnchorTail(msgs)
    const tp = result.messages[2].parts.find((p) => p.type === "tool") as MessageV2.ToolPart
    expect((tp.state as any).output).toBe("RAW_PAYLOAD")
  })
})

// ─────────────────────────────────────────────────────────────────────
// TransformResult schema invariants
// ─────────────────────────────────────────────────────────────────────

describe("TransformResult schema (back-compat)", () => {
  it("v7 always reports transformedTurnCount=0 (vestigial)", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const msgs = [anchorMsg(), userMsg("u1"), assistantMsg("a1", "stop", { text: "x" })]
    const result = transformPostAnchorTail(msgs)
    expect(result.transformedTurnCount).toBe(0)
  })

  it("v7 always reports cacheRefHits=0 and cacheRefMisses=0 (vestigial)", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const result = transformPostAnchorTail([anchorMsg()])
    expect(result.cacheRefHits).toBe(0)
    expect(result.cacheRefMisses).toBe(0)
  })

  it("v7 messages array length equals input length", () => {
    stubTweaks({ enableDialogRedactionAnchor: true })
    const msgs = [anchorMsg(), userMsg("u1"), assistantMsg("a1", "stop"), userMsg("u2")]
    const result = transformPostAnchorTail(msgs)
    expect(result.messages.length).toBe(msgs.length)
  })
})

// ─────────────────────────────────────────────────────────────────────
// __test__ direct seam — v6 / v7 implementations callable independently
// ─────────────────────────────────────────────────────────────────────

describe("__test__ direct dispatch", () => {
  it("__test__.v7 is pass-through regardless of feature flag", () => {
    stubTweaks({ enableDialogRedactionAnchor: false }) // flag value irrelevant
    const msgs = [
      anchorMsg(),
      userMsg("u1"),
      assistantMsg("a1", "tool-calls", {
        tools: [{ id: "prt_x", tool: "read", output: "RAW" }],
      }),
    ]
    const result = __test__.v7(msgs)
    const tp = result.messages[2].parts.find((p) => p.type === "tool") as MessageV2.ToolPart
    expect((tp.state as any).output).toBe("RAW")
    expect(result.redactedToolPartCount).toBe(0)
    expect(result.messages).toBe(msgs)
  })

  it("__test__.v6 drops regardless of feature flag", () => {
    stubTweaks({ enableDialogRedactionAnchor: true }) // flag on
    const msgs = [
      anchorMsg(),
      userMsg("u1"),
      assistantMsg("a1_old", "stop", { text: "drop me" }),
      userMsg("u2"),
    ]
    const result = __test__.v6(msgs)
    expect(result.messages).toHaveLength(3)
    expect(result.transformedTurnCount).toBe(1)
  })
})
