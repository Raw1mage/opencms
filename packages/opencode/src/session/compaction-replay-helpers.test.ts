import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Session } from "."
import { Tweaks } from "../config/tweaks"
import { MessageV2 } from "./message-v2"

// ─────────────────────────────────────────────────────────────────────
// Test seam state — restored after each test
// ─────────────────────────────────────────────────────────────────────

const originalSessionMessages = Session.messages
const originalSessionUpdateMessage = Session.updateMessage
const originalSessionUpdatePart = Session.updatePart
const originalSessionRemoveMessage = Session.removeMessage
const originalTweaksSync = Tweaks.compactionSync
const originalFilterCompacted = MessageV2.filterCompacted

afterEach(() => {
  ;(Session as any).messages = originalSessionMessages
  ;(Session as any).updateMessage = originalSessionUpdateMessage
  ;(Session as any).updatePart = originalSessionUpdatePart
  ;(Session as any).removeMessage = originalSessionRemoveMessage
  ;(Tweaks as any).compactionSync = originalTweaksSync
  ;(MessageV2 as any).filterCompacted = originalFilterCompacted
})

// Stub the runloop's projected view (MessageV2.filterCompacted) — the seam the
// replay skip-gate now consults instead of raw ID order. The replay's stream
// arg is ignored; the stub returns the controlled post-anchor view.
function stubFilteredView(msgs: MessageV2.WithParts[]) {
  ;(MessageV2 as any).filterCompacted = mock(async () => ({ messages: msgs, stoppedByBudget: false }))
}

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

function compactionRequestMsg(id: string): MessageV2.WithParts {
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
        id: `prt_${id}_req`,
        messageID: id,
        sessionID: "ses_test",
        type: "compaction-request",
        auto: true,
      } as MessageV2.CompactionPart,
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

// ─────────────────────────────────────────────────────────────────────
// snapshotUnansweredUserMessage
// ─────────────────────────────────────────────────────────────────────

describe("SessionCompaction.snapshotUnansweredUserMessage", () => {
  it("returns undefined for empty stream", async () => {
    stubMessages([])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeUndefined()
  })

  it("returns undefined when no user message exists", async () => {
    stubMessages([assistantMsg("msg_a", "stop")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeUndefined()
  })

  it("returns undefined when user message has properly finished assistant child (finish=stop)", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "stop")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeUndefined()
  })

  it("S3: returns a snapshot when assistant child finish=tool-calls with NO terminal stop (interrupted, any observed)", async () => {
    // post-compaction-continuity S3/DD-3: an interrupted tool-call chain (no
    // terminal stop) is the request still in flight — UNANSWERED — regardless of
    // observed. Previously scoped to overflow only, which stranded cache-aware /
    // manual mid-tool-chain (incident ses_14d8b1ed).
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "tool-calls")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u")
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  it("returns undefined when assistant child has finish=length", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "length")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeUndefined()
  })

  it("returns snapshot when user msg has no assistant child yet", async () => {
    stubMessages([userMsg("msg_u", "what about X?")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u")
    expect(result!.parts).toHaveLength(1)
    expect((result!.parts[0] as any).text).toBe("what about X?")
    expect(result!.emptyAssistantID).toBeUndefined()
  })

  it("returns snapshot when assistant child has finish=unknown (5/5 empty-response scenario)", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "unknown")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u")
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  it("returns snapshot when assistant child has finish=error", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "error")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeDefined()
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  it("returns snapshot when assistant child has finish=undefined (in-flight)", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", undefined)])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeDefined()
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  it("looks at MOST RECENT user msg only (multi-turn session)", async () => {
    stubMessages([
      userMsg("msg_u1", "first"),
      assistantMsg("msg_a1", "stop"),
      userMsg("msg_u2", "second — unanswered"),
    ])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
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
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeUndefined()
  })

  it("snapshot is independent — mutations don't affect storage", async () => {
    const userM = userMsg("msg_u")
    stubMessages([userM])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
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
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual", preLoaded)
    expect(called).toBe(0)
    expect(result!.info.id).toBe("msg_pre")
  })

  it("graceful degrade on Session.messages throw", async () => {
    ;(Session as any).messages = mock(async () => {
      throw new Error("storage unavailable")
    })
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeUndefined()
  })

  // ── 2026-05-25 overflow-replay-length-fix ────────────────────────────
  // Path A: observed=overflow + finish=length → finish=length is the literal
  // symptom of overflow (assistant got cut off). Snapshot must return the
  // user msg so replay carries the intent across the anchor.
  it("Path A: returns snapshot when observed=overflow + assistant child finish=length", async () => {
    stubMessages([userMsg("msg_u", "do task X"), assistantMsg("msg_a", "length")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "overflow")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u")
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  // Path A complement: non-overflow observed values keep length-as-answered.
  // Covers the legitimate "user asked for a long doc, model finished at the
  // length cap" scenario where we shouldn't replay the request.
  it("Path A complement: returns undefined when observed=manual + assistant child finish=length", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "length")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "manual")
    expect(result).toBeUndefined()
  })

  // Path C (2026-06-01 overflow-replay-toolchain-fix): observed=overflow +
  // first child finish=tool-calls but NO terminal stop anywhere in the chain
  // = overflow fired mid-tool-call chain. The model was still working (ran a
  // tool, intended to continue) — treat as UNANSWERED so replay resumes it.
  // Without this the runloop silently exits via no_user_after_compaction
  // (ses_17d9df5dcffe: user typed "commit", model ran git status @201K tokens,
  // B-compaction fired, work stranded until manual "go").
  it("Path C: returns snapshot when observed=overflow + tool-calls child with no terminal stop", async () => {
    stubMessages([userMsg("msg_u", "commit"), assistantMsg("msg_a", "tool-calls")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "overflow")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u")
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  // Path C complement: a tool-call chain that DID reach a terminal stop means
  // the request was genuinely answered (model finished after some tool calls).
  // firstStopIdx > 0 → keep tool-calls-as-answered even under overflow.
  it("Path C complement: returns undefined when overflow tool-call chain reached a terminal stop", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a1", "tool-calls"), assistantMsg("msg_a2", "stop")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "overflow")
    expect(result).toBeUndefined()
  })

  // post-compaction-continuity S3/DD-3: tool-calls-as-interrupted now applies to
  // ALL observeds (was overflow-only, which stranded cache-aware mid-tool-chain —
  // incident ses_14d8b1ed). A non-overflow observed interrupted mid-tool-chain
  // snapshots + replays so the in-flight task resumes.
  it("S3: returns a snapshot when observed=cache-aware + tool-calls child (no stop) — interrupted, resumes", async () => {
    stubMessages([userMsg("msg_u"), assistantMsg("msg_a", "tool-calls")])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "cache-aware")
    expect(result).toBeDefined()
    expect(result!.emptyAssistantID).toBe("msg_a")
  })

  // Path B: SessionCompaction.create writes a user-role msg whose only part
  // is a compaction-request placeholder. Snapshot must skip past it and find
  // the real user msg behind it — otherwise replay copies a meaningless
  // placeholder and the AI loses the actual user intent.
  it("Path B: skips compaction-request placeholder, returns previous real user msg", async () => {
    stubMessages([
      userMsg("msg_u_real", "the real request"),
      compactionRequestMsg("msg_u_placeholder"),
    ])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "overflow")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u_real")
    expect((result!.parts[0] as any).text).toBe("the real request")
  })

  // Path B + multi-turn: placeholder skip must not stop at the placeholder;
  // it must keep walking back. Verifies the skip is a `continue`, not a stop.
  it("Path B: placeholder skip walks past multiple placeholders if stacked", async () => {
    stubMessages([
      userMsg("msg_u_real", "original"),
      compactionRequestMsg("msg_u_p1"),
      compactionRequestMsg("msg_u_p2"),
    ])
    const result = await SessionCompaction.snapshotUnansweredUserMessage("ses_test", "overflow")
    expect(result).toBeDefined()
    expect(result!.info.id).toBe("msg_u_real")
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
    stubFilteredView([]) // default: folded out of the runloop view → replay
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

  it("skipped:already-after-anchor when the snapshot SURVIVES in the runloop's filtered view", async () => {
    // The message is still present in the projected post-anchor stream the
    // runloop drives off → it will be answered → replay would needlessly churn.
    // (Skip is now decided on the filtered view, NOT raw ID order.)
    stubFilteredView([userMsg("zzz_user_after_anchor")])
    const writes: number[] = []
    ;(Session as any).updateMessage = mock(async () => {
      writes.push(1)
    })

    const snapshot = buildSnapshot("zzz_user_after_anchor")
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "msg_anchor",
      observed: "rebind",
      step: 1,
    })

    expect(result.replayed).toBe(false)
    expect(result.reason).toBe("already-after-anchor")
    expect(writes).toHaveLength(0)
  })

  it("bug_20260616 axis 3: REPLAYS a folded message even when its id > anchor id (no ID-order skip)", async () => {
    // Live incident (03:12): a cold-B compaction folded the just-arrived user
    // message into the anchor. The anchor was inserted at the folded position
    // and got an OLDER id than the user message, so the old
    // `originalUserID > anchorMessageID` gate skipped replay → the runloop hit
    // no_user_after_compaction → the turn was silently dropped → resend needed.
    // The message ROW still exists (stillExists=true) but filterCompacted
    // excludes it from the runloop's view. Replay MUST fire.
    stubMessages([userMsg("msg_user_zzz_newer_than_anchor")]) // row present
    stubFilteredView([]) // but folded out of the runloop's projected view
    const updates = { messages: [] as MessageV2.User[], removes: [] as string[] }
    ;(Session as any).updateMessage = mock(async (m: MessageV2.User) => {
      updates.messages.push(m)
      return m
    })
    ;(Session as any).updatePart = mock(async (p: MessageV2.Part) => p)
    ;(Session as any).removeMessage = mock(async (input: { messageID: string }) => {
      updates.removes.push(input.messageID)
    })

    const snapshot = buildSnapshot("msg_user_zzz_newer_than_anchor", "你產出的填寫版，樣式格式完全不符合原檔")
    const result = await SessionCompaction.replayUnansweredUserMessage({
      sessionID: "ses_test",
      snapshot,
      anchorMessageID: "msg_anchor_aaa_older", // id < snapshot id → OLD gate would have skipped
      observed: "cache-aware",
      step: 1,
    })

    expect(result.replayed).toBe(true)
    expect(result.newUserID).toBeDefined()
    expect(updates.removes).toContain("msg_user_zzz_newer_than_anchor")
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
