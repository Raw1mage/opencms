import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Session } from "."
import { Tweaks } from "../config/tweaks"
import type { MessageV2 } from "./message-v2"

// ─────────────────────────────────────────────────────────────────────
// Test seam state
// ─────────────────────────────────────────────────────────────────────

const originalSessionMessages = Session.messages
const originalTweaksSync = Tweaks.compactionSync

afterEach(() => {
  ;(Session as any).messages = originalSessionMessages
  ;(Tweaks as any).compactionSync = originalTweaksSync
})

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers — minimal MessageV2.WithParts
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
        id: `prt_${id}_t`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text,
        time: { start: 1, end: 2 },
      } as MessageV2.TextPart,
    ],
  }
}

function assistantMsg(id: string, finish: MessageV2.Assistant["finish"], text?: string): MessageV2.WithParts {
  const parts: MessageV2.Part[] = []
  if (text) {
    parts.push({
      id: `prt_${id}_t`,
      messageID: id,
      sessionID: "ses_test",
      type: "text",
      text,
      time: { start: 1, end: 2 },
    } as MessageV2.TextPart)
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

function anchorMsg(id: string, body: string): MessageV2.WithParts {
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
      summary: true, // ← marks this as the anchor
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      time: { created: 0, completed: 1 },
    } as MessageV2.Assistant,
    parts: [
      {
        id: `prt_${id}_body`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text: body,
        time: { start: 0, end: 1 },
      } as MessageV2.TextPart,
    ],
  }
}

function stubMessages(msgs: MessageV2.WithParts[]) {
  ;(Session as any).messages = mock(async () => msgs)
}

function stubTweaks(overrides: Record<string, unknown> = {}) {
  ;(Tweaks as any).compactionSync = mock(() => ({
    ...originalTweaksSync(),
    ...overrides,
  }))
}

const RUN_INPUT_BASE = {
  sessionID: "ses_test",
  observed: "manual" as const,
  step: 0,
  fromAccountId: undefined,
  toAccountId: undefined,
}

// ─────────────────────────────────────────────────────────────────────
// tryNarrative — redacted-dialog body construction (DD-3)
// ─────────────────────────────────────────────────────────────────────

describe("tryNarrative (redacted-dialog body source)", () => {
  it("first compaction with no prior anchor — body equals serialised tail", async () => {
    stubMessages([
      userMsg("u1", "first question"),
      assistantMsg("a1", "stop", "first answer"),
      userMsg("u2", "second question"),
      assistantMsg("a2", "stop", "second answer"),
    ])
    stubTweaks({ enableDialogRedactionAnchor: true })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(RUN_INPUT_BASE as any, undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe("narrative")
    expect(result.summaryText).toContain("## Round 1")
    expect(result.summaryText).toContain("## Round 2")
    expect(result.summaryText).toContain("first question")
    expect(result.summaryText).toContain("first answer")
    expect(result.summaryText).toContain("second answer")
    expect(result.truncated).toBe(false)
  })

  it("subsequent compaction with prior anchor — body equals prevBody + serialised tail", async () => {
    const PREV_BODY = "## Round 1\n\n**User**\n\nold question\n\n**Assistant**\n\nold answer"
    stubMessages([
      userMsg("u_old", "old question"),
      anchorMsg("anchor_msg", PREV_BODY),
      userMsg("u2", "new question"),
      assistantMsg("a2", "stop", "new answer"),
    ])
    stubTweaks({ enableDialogRedactionAnchor: true })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(RUN_INPUT_BASE as any, undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summaryText.startsWith(PREV_BODY)).toBe(true)
    expect(result.summaryText).toContain("## Round 2") // continues numbering
    expect(result.summaryText).toContain("new question")
    expect(result.summaryText).toContain("new answer")
    // Old user msg (pre-anchor) NOT re-emitted
    const newSegment = result.summaryText.slice(PREV_BODY.length)
    expect(newSegment).not.toContain("old question")
  })

  it("claude fadeout leaves newest C round out of narrative anchor and records projection metadata", async () => {
    stubMessages([
      userMsg("u1", "B question"),
      assistantMsg("a1", "stop", "B answer"),
      userMsg("u2", "C decision"),
      assistantMsg("a2", "stop", "C artifact"),
    ])
    stubTweaks({
      enableDialogRedactionAnchor: true,
      fadeout: {
        ...originalTweaksSync().fadeout,
        enabled: true,
        bTailRounds: 1,
        bTailMaxTokens: 12_000,
      },
    })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(
      RUN_INPUT_BASE as any,
      {
        providerId: "claude-cli",
        limit: { context: 1_000_000 },
      } as any,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summaryText).toContain("B question")
    expect(result.summaryText).toContain("B answer")
    expect(result.summaryText).not.toContain("C decision")
    expect(result.summaryText).not.toContain("C artifact")
    expect(result.rawTailProjection).toEqual({ rounds: 1, maxTokens: 12_000 })
  })

  it("non-claude narrative keeps existing B+C folding behavior", async () => {
    stubMessages([
      userMsg("u1", "B question"),
      assistantMsg("a1", "stop", "B answer"),
      userMsg("u2", "C decision"),
      assistantMsg("a2", "stop", "C artifact"),
    ])
    stubTweaks({ enableDialogRedactionAnchor: true })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(
      RUN_INPUT_BASE as any,
      {
        providerId: "codex",
        limit: { context: 272_000 },
      } as any,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summaryText).toContain("C decision")
    expect(result.summaryText).toContain("C artifact")
    expect(result.rawTailProjection).toBeUndefined()
  })

  it("excludes unanswered user msg from extend (Spec 1 synergy)", async () => {
    stubMessages([
      userMsg("u1", "finished question"),
      assistantMsg("a1", "stop", "finished answer"),
      userMsg("u2_unanswered", "pending question"),
      // No assistant child for u2 → unanswered
    ])
    stubTweaks({ enableDialogRedactionAnchor: true })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(RUN_INPUT_BASE as any, undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summaryText).toContain("finished question")
    expect(result.summaryText).toContain("finished answer")
    expect(result.summaryText).not.toContain("pending question")
  })

  it("memory empty → ok=false, reason=memory empty", async () => {
    stubMessages([])
    stubTweaks({ enableDialogRedactionAnchor: true })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(RUN_INPUT_BASE as any, undefined)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("memory empty")
  })

  it("only unanswered user msg in stream → returns ok=false (memory empty)", async () => {
    stubMessages([userMsg("u_only", "the only msg, unanswered")])
    stubTweaks({ enableDialogRedactionAnchor: true })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(RUN_INPUT_BASE as any, undefined)
    expect(result.ok).toBe(false)
  })

  it("never embeds raw tool output payload — redacts to recall_id", async () => {
    const finishedAssistant = assistantMsg("a1", "tool-calls")
    finishedAssistant.parts.push({
      id: "prt_tool_X",
      messageID: "a1",
      sessionID: "ses_test",
      type: "tool",
      callID: "prt_tool_X",
      tool: "read",
      state: {
        status: "completed",
        input: { file: "auth.ts" },
        output: "SECRET_RAW_PAYLOAD_DO_NOT_LEAK",
        title: "",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as MessageV2.ToolPart)
    stubMessages([userMsg("u1", "go"), finishedAssistant])
    stubTweaks({ enableDialogRedactionAnchor: true })

    const result = await SessionCompaction.__test__.tryLocalRedactedDialog(RUN_INPUT_BASE as any, undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summaryText).not.toContain("SECRET_RAW_PAYLOAD_DO_NOT_LEAK")
    expect(result.summaryText).not.toContain("prt_tool_X")
  })
})

// ─────────────────────────────────────────────────────────────────────
// extractAnchorTextBody helper
// ─────────────────────────────────────────────────────────────────────

describe("extractAnchorTextBody", () => {
  it("joins all text parts with newline", () => {
    const anchor: MessageV2.WithParts = {
      info: { role: "assistant", id: "a", summary: true } as any,
      parts: [
        { id: "p1", messageID: "a", sessionID: "x", type: "text", text: "first", time: { start: 0, end: 0 } } as any,
        { id: "p2", messageID: "a", sessionID: "x", type: "text", text: "second", time: { start: 0, end: 0 } } as any,
      ],
    }
    expect(SessionCompaction.__test__.extractAnchorTextBody(anchor)).toBe("first\nsecond")
  })

  it("ignores non-text parts", () => {
    const anchor: MessageV2.WithParts = {
      info: { role: "assistant", id: "a", summary: true } as any,
      parts: [
        { id: "p1", messageID: "a", sessionID: "x", type: "text", text: "body", time: { start: 0, end: 0 } } as any,
        {
          id: "p2",
          messageID: "a",
          sessionID: "x",
          type: "compaction",
          observed: "manual",
          kind: "narrative",
        } as any,
      ],
    }
    expect(SessionCompaction.__test__.extractAnchorTextBody(anchor)).toBe("body")
  })

  it("empty parts → empty string", () => {
    const anchor: MessageV2.WithParts = {
      info: { role: "assistant", id: "a", summary: true } as any,
      parts: [],
    }
    expect(SessionCompaction.__test__.extractAnchorTextBody(anchor)).toBe("")
  })
})
