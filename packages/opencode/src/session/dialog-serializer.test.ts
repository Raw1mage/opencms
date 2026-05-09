import { describe, expect, it } from "bun:test"
import {
  findUnansweredUserMessageId,
  parsePrevLastRound,
  serializeRedactedDialog,
} from "./dialog-serializer"
import type { MessageV2 } from "./message-v2"

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

function userMsg(id: string, text: string = "hello"): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "user",
      sessionID: "ses_test",
      time: { created: 1 },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
    } as MessageV2.User,
    parts: [
      {
        id: `prt_${id}_text`,
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
    input?: Record<string, unknown>
    status?: "completed" | "error" | "pending" | "running"
  }>
}

function assistantMsg(
  id: string,
  finish: MessageV2.Assistant["finish"],
  opts: AssistantOpts = {},
): MessageV2.WithParts {
  const parts: MessageV2.Part[] = []
  if (opts.reasoning) {
    parts.push({
      id: `prt_${id}_reasoning`,
      messageID: id,
      sessionID: "ses_test",
      type: "reasoning",
      text: opts.reasoning,
      time: { start: 1, end: 2 },
    } as MessageV2.ReasoningPart)
  }
  if (opts.text) {
    parts.push({
      id: `prt_${id}_text`,
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
        output: "OUTPUT_PAYLOAD_REDACT_ME",
        title: "",
        metadata: {},
        time: { start: 1, end: 2 },
      })
    } else if (status === "error") {
      Object.assign(baseState, {
        error: "OOPS",
        time: { start: 1, end: 2 },
      })
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
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "ses_test",
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
// serializeRedactedDialog
// ─────────────────────────────────────────────────────────────────────

describe("serializeRedactedDialog", () => {
  it("empty input → empty output", () => {
    const result = serializeRedactedDialog([])
    expect(result.text).toBe("")
    expect(result.lastRound).toBe(0)
    expect(result.messagesEmitted).toBe(0)
  })

  it("single user/assistant round renders Round 1 with text content", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", "what is X?"),
      assistantMsg("a1", "stop", { text: "X is a thing." }),
    ])
    expect(result.text).toContain("## Round 1")
    expect(result.text).toContain("**User**")
    expect(result.text).toContain("what is X?")
    expect(result.text).toContain("**Assistant**")
    expect(result.text).toContain("X is a thing.")
    expect(result.lastRound).toBe(1)
    expect(result.messagesEmitted).toBe(2)
  })

  it("round with reasoning + tool call renders all sections in order", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", "fix the bug"),
      assistantMsg("a1", "tool-calls", {
        reasoning: "let me grep for the symbol",
        tools: [{ id: "prt_grep_1", tool: "grep", input: { pattern: "frame_count" } }],
      }),
      assistantMsg("a2", "stop", { text: "found it: typo at line 42" }),
    ])
    expect(result.text).toContain("**Reasoning**")
    expect(result.text).toContain("let me grep for the symbol")
    expect(result.text).toContain('**Tool**: `grep({"pattern":"frame_count"})` → `recall_id: prt_grep_1`')
    expect(result.text).toContain("**Assistant**")
    expect(result.text).toContain("found it: typo at line 42")
    expect(result.lastRound).toBe(1)
    expect(result.messagesEmitted).toBe(3)
  })

  it("excludeUserMessageID skips the entire round headed by that user msg", () => {
    const result = serializeRedactedDialog(
      [
        userMsg("u1", "first question"),
        assistantMsg("a1", "stop", { text: "first answer" }),
        userMsg("u2_unanswered", "pending question"),
      ],
      { excludeUserMessageID: "u2_unanswered" },
    )
    expect(result.text).toContain("first question")
    expect(result.text).toContain("first answer")
    expect(result.text).not.toContain("pending question")
    expect(result.lastRound).toBe(1)
    expect(result.messagesEmitted).toBe(2)
  })

  it("startRound continues numbering across extends", () => {
    const result = serializeRedactedDialog(
      [
        userMsg("u1", "next question"),
        assistantMsg("a1", "stop", { text: "next answer" }),
      ],
      { startRound: 48 },
    )
    expect(result.text).toContain("## Round 48")
    expect(result.text).not.toContain("## Round 1")
    expect(result.lastRound).toBe(48)
  })

  it("tool args > 500 chars truncated with ellipsis", () => {
    const longCmd = "x".repeat(800)
    const result = serializeRedactedDialog([
      userMsg("u1", "go"),
      assistantMsg("a1", "tool-calls", {
        tools: [{ id: "prt_shell_1", tool: "shell", input: { cmd: longCmd } }],
      }),
    ])
    const toolLine = result.text.split("\n").find((l) => l.startsWith("**Tool**"))
    expect(toolLine).toBeDefined()
    // Args section between '(' and ')' should be capped at 500 + ellipsis
    expect(toolLine!).toContain("…")
    // Total args portion no longer than 501 chars
    const argsMatch = toolLine!.match(/`shell\((.+?)\)` →/)
    expect(argsMatch).toBeTruthy()
    expect(argsMatch![1].length).toBeLessThanOrEqual(501)
  })

  it("tool with status=pending NOT rendered (skipped)", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", "go"),
      assistantMsg("a1", "tool-calls", {
        tools: [{ id: "prt_pending", tool: "shell", status: "pending" }],
      }),
    ])
    expect(result.text).not.toContain("**Tool**")
    expect(result.text).not.toContain("prt_pending")
  })

  it("tool with status=running NOT rendered (skipped)", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", "go"),
      assistantMsg("a1", undefined, {
        tools: [{ id: "prt_running", tool: "shell", status: "running" }],
      }),
    ])
    expect(result.text).not.toContain("**Tool**")
  })

  it("tool with status=error IS rendered (output redacted same as completed)", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", "go"),
      assistantMsg("a1", "tool-calls", {
        tools: [{ id: "prt_err", tool: "read", status: "error", input: { file: "x" } }],
      }),
    ])
    expect(result.text).toContain('**Tool**: `read({"file":"x"})` → `recall_id: prt_err`')
  })

  it("multi-round monotonic numbering", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", "q1"),
      assistantMsg("a1", "stop", { text: "ans1" }),
      userMsg("u2", "q2"),
      assistantMsg("a2", "stop", { text: "ans2" }),
      userMsg("u3", "q3"),
      assistantMsg("a3", "stop", { text: "ans3" }),
    ])
    expect(result.text).toContain("## Round 1")
    expect(result.text).toContain("## Round 2")
    expect(result.text).toContain("## Round 3")
    expect(result.lastRound).toBe(3)
    expect(result.messagesEmitted).toBe(6)
    // Order: Round 1 must precede Round 2 must precede Round 3
    const idx1 = result.text.indexOf("## Round 1")
    const idx2 = result.text.indexOf("## Round 2")
    const idx3 = result.text.indexOf("## Round 3")
    expect(idx1).toBeLessThan(idx2)
    expect(idx2).toBeLessThan(idx3)
  })

  it("output never contains raw tool output payload (redacted to recall_id)", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", "go"),
      assistantMsg("a1", "tool-calls", {
        tools: [{ id: "prt_x", tool: "read", input: { f: "y" } }],
      }),
    ])
    expect(result.text).not.toContain("OUTPUT_PAYLOAD_REDACT_ME")
    expect(result.text).toContain("recall_id: prt_x")
  })

  it("user msg with empty text shows _(empty)_ placeholder", () => {
    const result = serializeRedactedDialog([
      userMsg("u1", ""),
      assistantMsg("a1", "stop", { text: "ans" }),
    ])
    expect(result.text).toContain("_(empty)_")
  })

  it("leading assistant messages with no preceding user are skipped", () => {
    const result = serializeRedactedDialog([
      assistantMsg("a0_orphan", "stop", { text: "orphan content" }),
      userMsg("u1", "actual question"),
      assistantMsg("a1", "stop", { text: "ans" }),
    ])
    expect(result.text).not.toContain("orphan content")
    expect(result.text).toContain("actual question")
    expect(result.lastRound).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// findUnansweredUserMessageId
// ─────────────────────────────────────────────────────────────────────

describe("findUnansweredUserMessageId", () => {
  it("returns undefined for empty stream", () => {
    expect(findUnansweredUserMessageId([])).toBeUndefined()
  })

  it("returns undefined when last user msg has finish=stop assistant child", () => {
    expect(
      findUnansweredUserMessageId([userMsg("u1"), assistantMsg("a1", "stop")]),
    ).toBeUndefined()
  })

  it("returns id when last user msg has no assistant child", () => {
    expect(findUnansweredUserMessageId([userMsg("u1")])).toBe("u1")
  })

  it("returns id when assistant child has finish=unknown", () => {
    expect(
      findUnansweredUserMessageId([userMsg("u1"), assistantMsg("a1", "unknown")]),
    ).toBe("u1")
  })

  it("respects prevAnchorIdx — only walks tail after anchor", () => {
    // anchor at idx 1; only u3 should be considered (u1 is before anchor)
    const msgs = [
      userMsg("u1", "old q"),
      assistantMsg("ANCHOR", "stop"), // pretend this is the anchor
      userMsg("u3", "new q"),
    ]
    expect(findUnansweredUserMessageId(msgs, 1)).toBe("u3")
  })

  it("returns undefined when post-anchor tail has no user msg", () => {
    const msgs = [
      userMsg("u1", "old"),
      assistantMsg("ANCHOR", "stop"),
      assistantMsg("a_post", "stop", { text: "drift" }),
    ]
    expect(findUnansweredUserMessageId(msgs, 1)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// parsePrevLastRound
// ─────────────────────────────────────────────────────────────────────

describe("parsePrevLastRound", () => {
  it("empty input → 0", () => {
    expect(parsePrevLastRound("")).toBe(0)
  })

  it("body with no headers → 0", () => {
    expect(parsePrevLastRound("just some prose with no markdown headers")).toBe(0)
  })

  it("single header → that number", () => {
    expect(parsePrevLastRound("## Round 5\n\n**User**\n\nhi")).toBe(5)
  })

  it("multiple headers → highest", () => {
    const body = "## Round 1\n\n...\n\n## Round 7\n\n...\n\n## Round 3\n\n..."
    expect(parsePrevLastRound(body)).toBe(7)
  })

  it("non-matching headers ignored", () => {
    const body = "## Section\n\n## Round 12\n\n## Round abc\n\n## Round 99"
    expect(parsePrevLastRound(body)).toBe(99)
  })
})
