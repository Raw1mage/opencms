import { describe, expect, it } from "bun:test"
import { findDuplicateSiblingInMessages, stableStringify } from "./tool-invoker"
import type { MessageV2 } from "./message-v2"

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

function userMsg(id: string, text: string = "x"): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses",
      role: "user",
      time: { created: 0 },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
    } as MessageV2.User,
    parts: [
      {
        id: `prt_${id}`,
        messageID: id,
        sessionID: "ses",
        type: "text",
        text,
        time: { start: 0, end: 0 },
      } as MessageV2.TextPart,
    ],
  }
}

function assistantWithTool(
  id: string,
  toolID: string,
  input: unknown,
  status: "completed" | "running" | "error" = "completed",
  output: string = "RESULT",
  callID?: string,
): MessageV2.WithParts {
  const cid = callID ?? `call_${id}`
  const baseState: Record<string, unknown> = { status, input }
  if (status === "completed") {
    Object.assign(baseState, { output, title: "", metadata: {}, time: { start: 0, end: 1 } })
  } else if (status === "error") {
    Object.assign(baseState, { error: "OOPS", time: { start: 0, end: 1 } })
  } else if (status === "running") {
    Object.assign(baseState, { time: { start: 0 } })
  }
  return {
    info: {
      id,
      sessionID: "ses",
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
      finish: "tool-calls",
      time: { created: 0, completed: 1 },
    } as MessageV2.Assistant,
    parts: [
      {
        id: `prt_${cid}`,
        messageID: id,
        sessionID: "ses",
        type: "tool",
        callID: cid,
        tool: toolID,
        state: baseState as MessageV2.ToolPart["state"],
      } as MessageV2.ToolPart,
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────
// stableStringify
// ─────────────────────────────────────────────────────────────────────

describe("stableStringify", () => {
  it("sorts object keys for deterministic signature", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it("descends into nested objects with sorted keys", () => {
    const a = { outer: { y: 1, x: 2 }, top: "z" }
    const b = { top: "z", outer: { x: 2, y: 1 } }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it("preserves array order (positional)", () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it("handles primitives", () => {
    expect(stableStringify(null)).toBe("null")
    expect(stableStringify(true)).toBe("true")
    expect(stableStringify(42)).toBe("42")
    expect(stableStringify("x")).toBe(JSON.stringify("x"))
  })
})

// ─────────────────────────────────────────────────────────────────────
// findDuplicateSiblingInMessages
// ─────────────────────────────────────────────────────────────────────

describe("findDuplicateSiblingInMessages", () => {
  it("returns undefined when no prior tool calls exist", () => {
    const msgs = [userMsg("u1", "go")]
    expect(findDuplicateSiblingInMessages(msgs, "glob", { p: "*" }, "call_self")).toBeUndefined()
  })

  it("matches identical (tool, args) within current user turn", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { path: "/x", pattern: "*" }),
    ]
    const dup = findDuplicateSiblingInMessages(msgs, "glob", { path: "/x", pattern: "*" }, "call_other")
    expect(dup).toBeDefined()
    expect(dup!.callID).toBe("call_a1")
  })

  it("matches across consecutive assistant messages within same user turn", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { path: "/x", pattern: "*" }),
      assistantWithTool("a2", "read", { file: "/foo" }),
    ]
    const dup = findDuplicateSiblingInMessages(msgs, "glob", { path: "/x", pattern: "*" }, "call_self")
    expect(dup).toBeDefined()
    expect(dup!.messageID).toBe("a1")
  })

  it("does NOT match across user-message boundary", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { path: "/x", pattern: "*" }),
      userMsg("u2"), // new user turn
      assistantWithTool("a2", "read", { file: "/foo" }), // current
    ]
    expect(findDuplicateSiblingInMessages(msgs, "glob", { path: "/x", pattern: "*" }, "call_self")).toBeUndefined()
  })

  it("excludes self via callID", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { p: "*" }, "completed", "RESULT", "call_X"),
    ]
    expect(findDuplicateSiblingInMessages(msgs, "glob", { p: "*" }, "call_X")).toBeUndefined()
  })

  it("does NOT dedup against running siblings (race tolerance)", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { p: "*" }, "running", ""),
    ]
    expect(findDuplicateSiblingInMessages(msgs, "glob", { p: "*" }, "call_other")).toBeUndefined()
  })

  it("does NOT dedup against errored siblings (retry should re-run)", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { p: "*" }, "error"),
    ]
    expect(findDuplicateSiblingInMessages(msgs, "glob", { p: "*" }, "call_other")).toBeUndefined()
  })

  it("does NOT match different tool with same args", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { path: "/x" }),
    ]
    expect(findDuplicateSiblingInMessages(msgs, "read", { path: "/x" }, "call_other")).toBeUndefined()
  })

  it("does NOT match same tool with different args", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { path: "/x" }),
    ]
    expect(findDuplicateSiblingInMessages(msgs, "glob", { path: "/y" }, "call_other")).toBeUndefined()
  })

  it("matches despite key-order differences in args (stableStringify normalises)", () => {
    const msgs = [
      userMsg("u1"),
      assistantWithTool("a1", "glob", { path: "/x", pattern: "*" }),
    ]
    const dup = findDuplicateSiblingInMessages(msgs, "glob", { pattern: "*", path: "/x" }, "call_other")
    expect(dup).toBeDefined()
  })

  it("regression — gdrive session sequential glob duplicate is detected", () => {
    // Reproduces ses_1efaacf0 trace: step 1 ran Glob `*` at /home/pkcs12/projects/opencode,
    // step 2 issued same Glob with same args.
    const msgs = [
      userMsg("u1", "列出~/projects/opencode/"),
      assistantWithTool("a_step1", "glob", { pattern: "*", path: "/home/pkcs12/projects/opencode" }),
    ]
    const dup = findDuplicateSiblingInMessages(
      msgs,
      "glob",
      { pattern: "*", path: "/home/pkcs12/projects/opencode" },
      "call_step2",
    )
    expect(dup).toBeDefined()
    expect((dup!.state as any).output).toBe("RESULT")
  })
})
