import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Memory } from "./memory"
import { Session } from "."
import { Provider } from "@/provider/provider"
import { Tweaks } from "../config/tweaks"
import { Bus } from "@/bus"
import { PostCompaction } from "./post-compaction"
import { MessageV2 } from "./message-v2"

/**
 * Deep integration tests that DO NOT mock the anchor writer.
 *
 * Where M6 (compaction-replay-integration.test.ts) intercepts via
 * setAnchorWriter and asserts the WriteAnchorInput shape, this file
 * lets defaultWriteAnchor run all the way through compactWithSharedContext
 * (heavily mocked at the storage layer) and verifies the FULL flow:
 *
 *   1. Snapshot is taken once at run() start
 *   2. defaultWriteAnchor calls compactWithSharedContext (anchor written)
 *   3. defaultWriteAnchor invokes _replayHelper with the snapshot when one
 *      exists (Spec 1 DD-3)
 *   4. shouldInjectContinue runtime gate decides Continue injection (DD-4)
 *   5. publishCompactedAndResetChain emits with proper observed value (DD-5)
 *
 * Storage operations are captured (not really persisted). The test
 * doesn't replay against real SQLite — that's the fetch-back step.
 */

const originals = {
  memoryRead: Memory.read,
  sessionGet: Session.get,
  sessionMessages: Session.messages,
  sessionUpdateMessage: Session.updateMessage,
  sessionUpdatePart: Session.updatePart,
  sessionRemoveMessage: Session.removeMessage,
  sessionAppendRecentEvent: Session.appendRecentEvent,
  sessionSetActiveImageRefs: Session.setActiveImageRefs,
  providerGetModel: Provider.getModel,
  tweaksSync: Tweaks.compactionSync,
  busPublish: Bus.publish,
  postCompactionGather: PostCompaction.gather,
  postCompactionBuildSummary: PostCompaction.buildSummaryAddendum,
  postCompactionBuildContinue: PostCompaction.buildContinueText,
}

afterEach(() => {
  ;(Memory as any).read = originals.memoryRead
  ;(Session as any).get = originals.sessionGet
  ;(Session as any).messages = originals.sessionMessages
  ;(Session as any).updateMessage = originals.sessionUpdateMessage
  ;(Session as any).updatePart = originals.sessionUpdatePart
  ;(Session as any).removeMessage = originals.sessionRemoveMessage
  ;(Session as any).appendRecentEvent = originals.sessionAppendRecentEvent
  ;(Session as any).setActiveImageRefs = originals.sessionSetActiveImageRefs
  ;(Provider as any).getModel = originals.providerGetModel
  ;(Tweaks as any).compactionSync = originals.tweaksSync
  ;(Bus as any).publish = originals.busPublish
  ;(PostCompaction as any).gather = originals.postCompactionGather
  ;(PostCompaction as any).buildSummaryAddendum = originals.postCompactionBuildSummary
  ;(PostCompaction as any).buildContinueText = originals.postCompactionBuildContinue
  SessionCompaction.__test__.resetAnchorWriter()
  SessionCompaction.__test__.resetReplayHelper()
})

interface CapturedWrites {
  messages: any[]
  parts: any[]
  removes: string[]
  appendRecentEvents: any[]
  busEvents: any[]
  setActiveImageRefs: string[][]
  live: MessageV2.WithParts[]
}

function setupDeepMocks(sid: string, initialMessages: MessageV2.WithParts[]): CapturedWrites {
  // Stream state: starts as initial, mutates as test writes
  const live: MessageV2.WithParts[] = [...initialMessages]
  const captured: CapturedWrites = {
    messages: [],
    parts: [],
    removes: [],
    appendRecentEvents: [],
    busEvents: [],
    setActiveImageRefs: [],
    live,
  }

  ;(Memory as any).read = mock(async () => ({
    sessionID: sid,
    version: 1,
    updatedAt: 1,
    turnSummaries: [
      {
        turnIndex: 0,
        userMessageId: "msg_user_x",
        endedAt: 1,
        text: "narrative text",
        modelID: "gpt-5.5",
        providerId: "codex",
      },
    ],
    fileIndex: [],
    actionLog: [],
    lastCompactedAt: null,
    rawTailBudget: 5,
  }))
  ;(Session as any).get = mock(async () => ({
    execution: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
  }))
  ;(Session as any).messages = mock(async () => live)
  ;(Session as any).updateMessage = mock(async (m: any) => {
    captured.messages.push(m)
    // Reflect into live stream so subsequent reads see it
    const existingIdx = live.findIndex((x) => x.info.id === m.id)
    if (existingIdx >= 0) {
      live[existingIdx] = { info: m, parts: live[existingIdx].parts }
    } else {
      live.push({ info: m, parts: [] })
    }
    return m
  })
  ;(Session as any).updatePart = mock(async (p: any) => {
    captured.parts.push(p)
    const msgIdx = live.findIndex((x) => x.info.id === p.messageID)
    if (msgIdx >= 0) {
      live[msgIdx].parts = [...live[msgIdx].parts, p]
    }
    return p
  })
  ;(Session as any).removeMessage = mock(async (input: { messageID: string }) => {
    captured.removes.push(input.messageID)
    const idx = live.findIndex((x) => x.info.id === input.messageID)
    if (idx >= 0) live.splice(idx, 1)
  })
  ;(Session as any).appendRecentEvent = mock(async (_sid: string, evt: any) => {
    captured.appendRecentEvents.push(evt)
  })
  ;(Session as any).setActiveImageRefs = mock(async (_sid: string, refs: string[]) => {
    captured.setActiveImageRefs.push(refs)
  })
  ;(Provider as any).getModel = mock(
    async () =>
      ({
        id: "gpt-5.5",
        providerId: "codex",
        limit: { context: 272_000, input: 272_000, output: 32_000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      }) as any,
  )
  ;(Tweaks as any).compactionSync = mock(() => ({
    ...originals.tweaksSync(),
    enableUserMsgReplay: true,
  }))
  ;(Bus as any).publish = mock((event: any, payload: any) => {
    captured.busEvents.push({ event, payload })
  })
  ;(PostCompaction as any).gather = mock(async () => [])
  ;(PostCompaction as any).buildSummaryAddendum = mock(() => "")
  ;(PostCompaction as any).buildContinueText = mock(() => "Continue placeholder.")

  return captured
}

function userMsgWP(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "user",
      sessionID: "ses_deep",
      time: { created: 1 },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
      format: { type: "text" },
      variant: "default",
    } as MessageV2.User,
    parts: [
      {
        id: `prt_${id}`,
        messageID: id,
        sessionID: "ses_deep",
        type: "text",
        text,
        time: { start: 1, end: 2 },
      } as MessageV2.TextPart,
    ],
  }
}

// A completed (answered) turn: a user message followed by an assistant that
// ran to a clean `stop` with real text. Narrative compaction excludes the
// trailing *unanswered* user message, so a session must contain at least one
// such completed round for tryLocalRedactedDialog to emit a non-empty body
// (the `messagesEmitted === 0 && prevBody === ""` guard added 2026-05-10 in
// 545d16ea2). Tests that assert the anchor-write + replay wiring therefore
// seed one of these BEFORE the unanswered user message they snapshot.
function asstMsgWP(id: string, parentID: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "ses_deep",
      parentID,
      modelID: "gpt-5.5",
      providerId: "codex",
      mode: "primary",
      agent: "default",
      path: { cwd: ".", root: "." },
      summary: false,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      time: { created: 2, completed: 3 },
    } as MessageV2.Assistant,
    parts: [
      {
        id: `prt_${id}`,
        messageID: id,
        sessionID: "ses_deep",
        type: "text",
        text,
        time: { start: 2, end: 3 },
      } as MessageV2.TextPart,
    ],
  }
}

describe("DEEP integration: defaultWriteAnchor → _replayHelper wiring", () => {
  it("observed=rebind: defaultWriteAnchor invokes _replayHelper with snapshot", async () => {
    const captured = setupDeepMocks("ses_deep", [
      userMsgWP("msg_u_prior", "earlier question"),
      asstMsgWP("msg_a_prior", "msg_u_prior", "earlier answer"),
      userMsgWP("msg_user_x", "the question"),
    ])

    const replayCalls: any[] = []
    SessionCompaction.__test__.setReplayHelper(async (input) => {
      replayCalls.push(input)
      return { replayed: true, newUserID: "msg_replayed_y" }
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_deep",
      observed: "rebind",
      step: 1,
    })

    expect(result).toBe("continue")
    // The deep path: defaultWriteAnchor (running) → compactWithSharedContext
    // (heavily mocked) → _replayHelper. Verify _replayHelper got invoked
    // exactly once with the right shape.
    expect(replayCalls).toHaveLength(1)
    expect(replayCalls[0].observed).toBe("rebind")
    expect(replayCalls[0].step).toBe(1)
    expect(replayCalls[0].snapshot.info.id).toBe("msg_user_x")
    expect((replayCalls[0].snapshot.parts[0] as any).text).toBe("the question")
    // anchorMessageID is the freshly written summary anchor's id
    expect(replayCalls[0].anchorMessageID).toBeDefined()
    expect(replayCalls[0].anchorMessageID.length).toBeGreaterThan(4)
  })

  it("observed=rebind: default replay keeps first post-rebind user visible after anchor", async () => {
    const captured = setupDeepMocks("ses_deep", [
      userMsgWP("msg_u_prior", "earlier question"),
      asstMsgWP("msg_a_prior", "msg_u_prior", "earlier answer"),
      userMsgWP("msg_a_user_x", "修"),
    ])

    const result = await SessionCompaction.run({
      sessionID: "ses_deep",
      observed: "rebind",
      step: 1,
    })

    expect(result).toBe("continue")
    expect(captured.removes).toContain("msg_a_user_x")
    const replayedPart = captured.parts.find((part) => part.type === "text" && part.text === "修") as
      | MessageV2.TextPart
      | undefined
    expect(replayedPart?.metadata?.compactionReplay).toBe(true)

    async function* newestFirst() {
      for (const message of [...captured.live].reverse()) yield message
    }
    const projected = await MessageV2.filterCompacted(newestFirst())
    expect(projected.messages.map((message) => message.info.role)).toEqual(["assistant", "user"])
    expect(projected.messages[1].parts.some((part) => part.type === "text" && part.text === "修")).toBe(true)
  })

  it("observed=manual + no-unanswered: _replayHelper NOT called (snapshot empty)", async () => {
    const captured = setupDeepMocks("ses_deep", [
      userMsgWP("msg_u_old", "old question"),
      {
        info: {
          id: "msg_a_old",
          role: "assistant",
          sessionID: "ses_deep",
          parentID: "msg_u_old",
          modelID: "gpt-5.5",
          providerId: "codex",
          mode: "primary",
          agent: "default",
          path: { cwd: ".", root: "." },
          summary: false,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: 2, completed: 3 },
        } as MessageV2.Assistant,
        parts: [],
      },
    ])

    const replayCalls: any[] = []
    SessionCompaction.__test__.setReplayHelper(async (input) => {
      replayCalls.push(input)
      return { replayed: false, reason: "no-unanswered" }
    })

    await SessionCompaction.run({
      sessionID: "ses_deep",
      observed: "manual",
      step: 0,
    })

    // No unanswered user msg → snapshot returns undefined → replay not invoked
    expect(replayCalls).toHaveLength(0)
  })

  it("observed=empty-response with empty assistant child: replay called with emptyAssistantID", async () => {
    setupDeepMocks("ses_deep", [
      userMsgWP("msg_u_prior", "earlier question"),
      asstMsgWP("msg_a_prior", "msg_u_prior", "earlier answer"),
      userMsgWP("msg_user_empty", "asked but got blank"),
      {
        info: {
          id: "msg_a_blank",
          role: "assistant",
          sessionID: "ses_deep",
          parentID: "msg_user_empty",
          modelID: "gpt-5.5",
          providerId: "codex",
          mode: "primary",
          agent: "default",
          path: { cwd: ".", root: "." },
          summary: false,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "unknown" as MessageV2.Assistant["finish"],
          time: { created: 2, completed: 3 },
        } as MessageV2.Assistant,
        parts: [],
      },
    ])

    const replayCalls: any[] = []
    SessionCompaction.__test__.setReplayHelper(async (input) => {
      replayCalls.push(input)
      return { replayed: true, newUserID: "msg_replayed" }
    })

    await SessionCompaction.run({
      sessionID: "ses_deep",
      observed: "empty-response",
      step: 5,
    })

    expect(replayCalls).toHaveLength(1)
    expect(replayCalls[0].snapshot.emptyAssistantID).toBe("msg_a_blank")
    expect(replayCalls[0].observed).toBe("empty-response")
  })

  it("observed=overflow: publishCompactedAndResetChain receives observed (DD-5 cosmetic side-fix)", async () => {
    const captured = setupDeepMocks("ses_deep", [userMsgWP("msg_user_x", "Q")])
    SessionCompaction.__test__.setReplayHelper(async () => ({
      replayed: true,
      newUserID: "msg_y",
    }))

    await SessionCompaction.run({
      sessionID: "ses_deep",
      observed: "overflow",
      step: 2,
    })

    // appendRecentEvent should record the compaction with observed:"overflow"
    // (not "unknown"). publishCompactedAndResetChain inside
    // compactWithSharedContext threads the observed through to appendRecentEvent.
    const compactionEvents = captured.appendRecentEvents.filter((e) => e.kind === "compaction")
    expect(compactionEvents.length).toBeGreaterThan(0)
    // At least one event should record observed === "overflow"
    const observed = compactionEvents.map((e) => e.compaction?.observed)
    expect(observed).toContain("overflow")
    // Importantly: NO event should record "unknown" from prod path
    expect(observed).not.toContain("unknown")
  })

  it("BR stale-attachment: drains activeImageRefs at the compaction boundary", async () => {
    // issue_20260611_stale-attachment-persists-across-turns: a pre-compaction
    // screenshot survived identity rotation and re-inlined every post-compaction
    // turn, looping the agent. publishCompactedAndResetChain must drain the
    // visual working-set at the compaction boundary.
    const captured = setupDeepMocks("ses_deep", [userMsgWP("msg_user_x", "Q")])
    SessionCompaction.__test__.setReplayHelper(async () => ({
      replayed: true,
      newUserID: "msg_y",
    }))

    await SessionCompaction.run({
      sessionID: "ses_deep",
      observed: "overflow",
      step: 2,
    })

    // setActiveImageRefs should have been called with an empty array (drain).
    expect(captured.setActiveImageRefs.length).toBeGreaterThan(0)
    expect(captured.setActiveImageRefs).toContainEqual([])
  })

  it("flag disabled: snapshot path bypassed, INJECT_CONTINUE legacy path drives auto", async () => {
    const captured = setupDeepMocks("ses_deep", [userMsgWP("msg_user_x", "Q")])
    ;(Tweaks as any).compactionSync = mock(() => ({
      ...originals.tweaksSync(),
      enableUserMsgReplay: false,
    }))

    const replayCalls: any[] = []
    SessionCompaction.__test__.setReplayHelper(async (input) => {
      replayCalls.push(input)
      return { replayed: true }
    })

    await SessionCompaction.run({
      sessionID: "ses_deep",
      observed: "overflow",
      step: 1,
    })

    // Flag off → snapshot phase short-circuited → replay helper NEVER invoked
    expect(replayCalls).toHaveLength(0)
  })
})
