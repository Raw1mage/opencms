import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Session } from "."
import { Tweaks } from "../config/tweaks"
import type { MessageV2 } from "./message-v2"

// ─────────────────────────────────────────────────────────────────────
// Test seam state — restored after each test
// ─────────────────────────────────────────────────────────────────────

const originalSessionMessages = Session.messages
const originalSessionUpdateMessage = Session.updateMessage
const originalSessionUpdatePart = Session.updatePart
const originalSessionRemoveMessage = Session.removeMessage
const originalTweaksSync = Tweaks.compactionSync

afterEach(() => {
  ;(Session as any).messages = originalSessionMessages
  ;(Session as any).updateMessage = originalSessionUpdateMessage
  ;(Session as any).updatePart = originalSessionUpdatePart
  ;(Session as any).removeMessage = originalSessionRemoveMessage
  ;(Tweaks as any).compactionSync = originalTweaksSync
})

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers — compose minimal MessageV2.WithParts shapes
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
      format: { type: "text" },
      variant: "default",
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

function assistantMsg(
  id: string,
  finish: MessageV2.Assistant["finish"],
): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "ses_test",
      parentID: "msg_user_x",
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
    parts: [],
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

// ─────────────────────────────────────────────────────────────────────
// snapshotUnansweredUserMessage
// ─────────────────────────────────────────────────────────────────────

describe("SessionCompaction.snapshotUnansweredUserMessage", () => {
  it("returns undefined for empty stream", async () => {
    stubMessages([])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeUndefined()
  })

  it("returns undefined when no user message exists", async () => {
    stubMessages([assistantMsg("msg_a", "stop")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeUndefined()
  })

  it("returns undefined when user message has properly finished assistant child (finish=stop)", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "stop")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeUndefined()
  })

  it("returns undefined when assistant child has finish=tool-calls", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "tool-calls")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeUndefined()
  })

  it("returns undefined when assistant child has finish=length", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "length")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeUndefined()
  })

  it("returns snapshot when user msg has no assistant child yet", async () => {
    stubMessages([userMsg("msg_u", "what about X?")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u")
    expect(result!.parts).toHaveLength(1)
    expect((result!.parts[0] as any).text).toBe("what about X?")
    expect(result!.emptyAssistantID).toBeUndefined()
  })

  it("returns snapshot when assistant child has finish=unknown (5/5 empty-response scenario)", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "unknown")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u")
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  it("returns snapshot when assistant child has finish=error", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "error")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeDefined()
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  it("returns snapshot when assistant child has finish=undefined (in-flight)", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", undefined)])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeDefined()
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  it("looks at MOST RECENT user msg only (multi-turn session)", async () => {
    stubMessages([
      userMsg("msg_u1", "first"),
      assistantMsg("msg_a1", "stop"),
      userMsg("msg_u2", "second — unanswered"),
    ])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u2")
    expect((result!.parts[0] as any).text).toBe("second — unanswered")
  })

  it("returns undefined when most recent user msg is answered (multi-turn)", async () => {
    stubMessages([
      userMsg("msg_u1", "first — unanswered"),
      userMsg("msg_u2", "second"),
      assistantMsg("msg_a", "stop"),
    ])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeUndefined()
  })

  it("snapshot is independent — mutations don't affect storage", async () => {
    const userM = userMsg("msg_u")
    stubMessages([userM])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeDefined()
    ;(result!.info as any).id = "tampered"
    expect(userM.info.id).toBe("msg_u") // original untouched
  })

  it("accepts pre-loaded messages array (no second fetch)", async () => {
    let called = 0
    ;(Session as any).messages = mock(async () => {
      called++
      return [userMsg("msg_u")]
    })
    const preLoaded = [userMsg("msg_pre", "explicit input")]
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", preLoaded)
    expect(called).toBe(0)
    expect(result!.info.id).toBe("msg_pre")
  })

  it("graceful degrade on Session.messages throw", async () => {
    ;(Session as any).messages = mock(async () => {
      throw new Error("storage unavailable")
    })
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test")
    expect(result).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// replayUnansweredUserMessage
// ─────────────────────────────────────────────────────────────────────

function buildSnapshot(
  id: string = "msg_user_x",
  text: string = "the question",
  emptyAssistantID?: string,
): SessionCompaction.UserMessageSnapshot {
  return {
    info: {
      id,
      role: "user",
      sessionID: "ses_test",
      time: { created: 1 },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
      format: { type: "text" },
      variant: "default",
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
    emptyAssistantID,
  }
}

describe("SessionCompaction.replayUnansweredUserMessage", () => {
  beforeEach(() => {
    stubTweaks() // default: enableUserMsgReplay undefined → not false → proceed
    stubMessages([userMsg("msg_user_x")]) // snapshot still in stream by default
  })

  it("happy path: writes new user msg with id > anchor, copies parts, removes original", async () => {
    const updates: { messages: MessageV2.User[]; parts: MessageV2.Part[]; removes: string[] } = {
      messages: [],
      parts: [],
      removes: [],
    }
    ;(Session as any).updateMessage = mock(async (m: MessageV2.User) => {
      updates.messages.push(m)
      return m
    })
    ;(Session as any).updatePart = mock(async (p: MessageV2.Part) => {
      updates.parts.push(p)
      return p
    })
    ;(Session as any).removeMessage = mock(async (input: { messageID: string }) => {
      updates.removes.push(input.messageID)
    })

    const snapshot = buildSnapshot("msg_user_x", "what about X?")
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "zzz_anchor_id_above_user", // ULID-comparison: alphabetic > "msg_user_x"
      observed: "rebind",
      step: 1,
    })

    expect(result.replayed).toBe(true)
    expect(result.newUserID).toBeDefined()
    expect(result.newUserID).not.toBe("msg_user_x")
    expect(updates.messages).toHaveLength(1)
    expect(updates.messages[0].id).toBe(result.newUserID)
    expect(updates.parts).toHaveLength(1)
    expect((updates.parts[0] as any).messageID).toBe(result.newUserID)
    expect(updates.removes).toContain("msg_user_x")
  })

  it("removes empty assistant child when emptyAssistantID provided (5/5 scenario)", async () => {
    const removes: string[] = []
    ;(Session as any).updateMessage = mock(async (m: MessageV2.User) => m)
    ;(Session as any).updatePart = mock(async (p: MessageV2.Part) => p)
    ;(Session as any).removeMessage = mock(async (input: { messageID: string }) => {
      removes.push(input.messageID)
    })

    const snapshot = buildSnapshot("msg_user_x", "Q", "msg_empty_assistant")
    await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "zzz_anchor",
      observed: "empty-response",
      step: 1,
    })

    expect(removes).toContain("msg_empty_assistant")
    expect(removes).toContain("msg_user_x")
  })

  it("skipped:flag-off when enableUserMsgReplay=false", async () => {
    stubTweaks({ enableUserMsgReplay: false })
    const writes: number[] = []
    ;(Session as any).updateMessage = mock(async () => {
      writes.push(1)
    })

    const snapshot = buildSnapshot()
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "zzz_anchor",
      observed: "rebind",
      step: 1,
    })

    expect(result.replayed).toBe(false)
    expect(result.reason).toBe("feature-flag-disabled")
    expect(writes).toHaveLength(0) // no storage writes
  })

  it("skipped:already-after-anchor when snapshot.id > anchor.id", async () => {
    const writes: number[] = []
    ;(Session as any).updateMessage = mock(async () => {
      writes.push(1)
    })

    const snapshot = buildSnapshot("zzz_user_after_anchor")
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "msg_anchor", // alphabetic < "zzz_user..."
      observed: "rebind",
      step: 1,
    })

    expect(result.replayed).toBe(false)
    expect(result.reason).toBe("already-after-anchor")
    expect(writes).toHaveLength(0)
  })

  it("idempotent: skipped:no-unanswered when snapshot already removed from stream", async () => {
    stubMessages([]) // empty stream — original snapshot already consumed
    const writes: number[] = []
    ;(Session as any).updateMessage = mock(async () => {
      writes.push(1)
    })

    const snapshot = buildSnapshot("msg_user_x")
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "zzz_anchor",
      observed: "rebind",
      step: 1,
    })

    expect(result.replayed).toBe(false)
    expect(result.reason).toBe("snapshot-already-consumed")
    expect(writes).toHaveLength(0)
  })

  it("graceful degrade: returns reason=exception on Session.updateMessage throw", async () => {
    ;(Session as any).updateMessage = mock(async () => {
      throw new Error("SQLITE_BUSY")
    })
    ;(Session as any).updatePart = mock(async (p: MessageV2.Part) => p)
    ;(Session as any).removeMessage = mock(async () => {})

    const snapshot = buildSnapshot()
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "zzz_anchor",
      observed: "rebind",
      step: 1,
    })

    expect(result.replayed).toBe(false)
    expect(result.reason).toBe("exception")
    // Helper does not re-throw
  })

  it("graceful degrade: never throws even when ALL storage operations fail", async () => {
    ;(Session as any).updateMessage = mock(async () => {
      throw new Error("write-fail")
    })
    ;(Session as any).updatePart = mock(async () => {
      throw new Error("part-fail")
    })
    ;(Session as any).removeMessage = mock(async () => {
      throw new Error("remove-fail")
    })

    const snapshot = buildSnapshot()
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "zzz_anchor",
      observed: "rebind",
      step: 1,
    })

    expect(result.replayed).toBe(false)
    expect(result.reason).toBe("exception")
  })

  it("preserves snapshot info shape (model, agent, variant, format)", async () => {
    let written: MessageV2.User | undefined
    ;(Session as any).updateMessage = mock(async (m: MessageV2.User) => {
      written = m
      return m
    })
    ;(Session as any).updatePart = mock(async (p: MessageV2.Part) => p)
    ;(Session as any).removeMessage = mock(async () => {})

    const snapshot: SessionCompaction.UserMessageSnapshot = {
      info: {
        id: "msg_user_x",
        role: "user",
        sessionID: "ses_test",
        time: { created: 1 },
        agent: "build",
        model: { providerId: "claude", modelID: "claude-sonnet-4-6", accountId: "acc-X" },
        format: { type: "text" },
        variant: "main",
      } as MessageV2.User,
      parts: [],
    }

    await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "zzz_anchor",
      observed: "rebind",
      step: 1,
    })

    expect(written).toBeDefined()
    expect(written!.agent).toBe("build")
    expect(written!.model.providerId).toBe("claude")
    expect(written!.model.modelID).toBe("claude-sonnet-4-6")
    expect(written!.model.accountId).toBe("acc-X")
    expect(written!.variant).toBe("main")
    expect(written!.format).toEqual({ type: "text" })
  })

  it("test seam: __test__.setReplayHelper / resetReplayHelper toggles indirection", async () => {
    let captured: any = null
    SessionCompaction.__test__.setReplayHelper(async (input) => {
      captured = input
      return { replayed: true, newUserID: "msg_mocked" }
    })
    // Note: this test verifies the test seam itself; production callers
    // (defaultWriteAnchor, etc.) use _replayHelper which the seam swaps.
    // The exported replayUnansweredUserMessage is unaffected by setReplayHelper.
    expect(captured).toBeNull()
    SessionCompaction.__test__.resetReplayHelper()
  })
})
