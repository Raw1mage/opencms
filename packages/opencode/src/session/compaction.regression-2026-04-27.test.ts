import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Memory } from "./memory"
import { Session } from "."
import { Provider } from "@/provider/provider"

/**
 * Regression test: 2026-04-27 runloop rebind-compaction infinite loop.
 *
 * Original event log: docs/events/event_20260427_runloop_rebind_loop.md
 *
 * Symptom (pre-fix):
 *   ses_23a4ed76effev4mhtJ3YhMK0iS produced ~408 messages in ~3 min,
 *   alternating "post-stream account changed" → "loop:rebind_compaction_triggered"
 *   every ~5s with newAccountId always equal to the same yeatsraw account —
 *   the "switch" was a phantom comparison artifact.
 *
 * Root cause: per-round assistant message accountId was initialized from
 * `lastUser.model.accountId` (frozen at user-message time) but streamInput
 * used `effectiveAccountId` (read from session.execution pin). After any
 * rotation those two diverged permanently, so processor.ts:707 mid-stream
 * account-switch detection fired EVERY round, repeatedly calling
 * markRebindCompaction. The next round consumed the flag and ran
 * compactWithSharedContext with auto:true, which injected a synthetic
 * "Continue if you have next steps..." user message — turning a
 * maintenance compaction into autonomous continuation.
 *
 * The compaction-redesign makes this bug class structurally unrepresentable.
 * Two layers of defense:
 *
 *   1. INV-3 / R-6: INJECT_CONTINUE['rebind'] = false (table value, not
 *      conditional code). Even if rebind fires unexpectedly, no Continue
 *      is injected, so there's no autonomous-continuation feedback loop.
 *
 *   2. INV-1 / DD-1: state-driven evaluation reads observable state
 *      (pinned identity vs anchor identity), not flags set by previous
 *      iterations. The phantom-comparison artifact disappears because
 *      anchor identity reflects time-of-write per INV-7.
 *
 * This test asserts both defenses by simulating the original scenario:
 * a real account rotation produces exactly one rebind compaction (one
 * anchor write), no synthetic Continue injection, no infinite loop.
 */

const originalMemoryRead = Memory.read
const originalSessionGet = Session.get
const originalSessionMessages = Session.messages
const originalProviderGetModel = Provider.getModel

afterEach(() => {
  ;(Memory as any).read = originalMemoryRead
  ;(Session as any).get = originalSessionGet
  ;(Session as any).messages = originalSessionMessages
  ;(Provider as any).getModel = originalProviderGetModel
  SessionCompaction.__test__.resetAnchorWriter()
})

describe("regression: 2026-04-27 rebind-compaction infinite loop", () => {
  it("INV-3: rebind run never injects synthetic Continue (no autonomous-continuation amplifier)", async () => {
    // Setup: session with one captured TurnSummary (post-rotation memory state)
    ;(Memory as any).read = mock(async () => ({
      sessionID: "ses_regression_2026_04_27",
      version: 5,
      updatedAt: 1,
      turnSummaries: [
        {
          turnIndex: 0,
          userMessageId: "msg_u1",
          endedAt: 1,
          text: "earlier turn narrative",
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
      execution: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-yeatsraw" },
    }))
    // Phase 13: cooldown reads anchor from messages.
    // dialog-replay-redaction: also synthesize a user/assistant pair so the
    // new tryNarrative path (which serialises Session.messages directly)
    // produces non-empty content matching the legacy turnSummaries.
    ;(Session as any).messages = mock(async () => [
      {
        info: {
          id: "msg_u1",
          sessionID: "ses_regression_2026_04_27",
          role: "user",
          time: { created: 1 },
          agent: "default",
          model: { providerId: "codex", modelID: "gpt-5.5" },
        },
        parts: [
          {
            id: "prt_u1",
            messageID: "msg_u1",
            sessionID: "ses_regression_2026_04_27",
            type: "text",
            text: "earlier user msg",
            time: { start: 0, end: 0 },
          },
        ],
      },
      {
        info: {
          id: "msg_a1",
          sessionID: "ses_regression_2026_04_27",
          role: "assistant",
          parentID: "msg_u1",
          modelID: "gpt-5.5",
          providerId: "codex",
          mode: "primary",
          agent: "default",
          path: { cwd: ".", root: "." },
          summary: false,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [
          {
            id: "prt_a1",
            messageID: "msg_a1",
            sessionID: "ses_regression_2026_04_27",
            type: "text",
            text: "earlier turn narrative",
            time: { start: 0, end: 0 },
          },
        ],
      },
    ])
    ;(Provider as any).getModel = mock(async () => ({
      id: "gpt-5.5",
      providerId: "codex",
      limit: { context: 272_000, input: 272_000, output: 32_000 },
      cost: { input: 1 },
    }))

    // Capture the anchor write call shape
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    // Simulate rebind triggered by post-stream account change
    const result = await SessionCompaction.run({
      sessionID: "ses_regression_2026_04_27",
      observed: "rebind",
      step: 12,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    // R-6 / INV-3: rebind must NOT inject Continue
    expect(writes[0].auto).toBe(false)
  })

  it("INV-2: real rotation produces exactly one rebind anchor (cooldown blocks rapid re-fire)", async () => {
    // Phase 13 REVISED: cooldown reads the most recent anchor message's
    // time.created from Session.messages, not Memory.lastCompactedAt.
    // Simulate the anchor going from "absent" (first compact OK) to "1s ago"
    // (rapid retry throttled) to "31s ago" (cooldown expired).
    ;(Memory as any).read = mock(async () => ({
      sessionID: "ses_regression_cooldown",
      version: 1,
      updatedAt: 1,
      turnSummaries: [
        {
          turnIndex: 0,
          userMessageId: "msg_u1",
          endedAt: 1,
          text: "x",
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
    ;(Provider as any).getModel = mock(async () => ({
      id: "gpt-5.5",
      providerId: "codex",
      limit: { context: 272_000, input: 272_000, output: 32_000 },
      cost: { input: 1 },
    }))

    let anchorTime: number | null = null
    // dialog-replay-redaction: pre-anchor stream needs a user/assistant pair
    // so the new tryNarrative path produces non-empty body. After an anchor
    // gets written (anchorTime non-null), include it as the most recent
    // summary-true assistant — the tail after anchor is empty, body equals
    // anchor body, narrative still succeeds (or chain proceeds correctly).
    const baseMsgs = [
      {
        info: {
          id: "msg_u1",
          sessionID: "ses_regression_cooldown",
          role: "user",
          time: { created: 1 },
          agent: "default",
          model: { providerId: "codex", modelID: "gpt-5.5" },
        },
        parts: [
          {
            id: "prt_u1",
            messageID: "msg_u1",
            sessionID: "ses_regression_cooldown",
            type: "text",
            text: "go",
            time: { start: 0, end: 0 },
          },
        ],
      },
      {
        info: {
          id: "msg_a1",
          sessionID: "ses_regression_cooldown",
          role: "assistant",
          parentID: "msg_u1",
          modelID: "gpt-5.5",
          providerId: "codex",
          mode: "primary",
          agent: "default",
          path: { cwd: ".", root: "." },
          summary: false,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [
          {
            id: "prt_a1",
            messageID: "msg_a1",
            sessionID: "ses_regression_cooldown",
            type: "text",
            text: "x",
            time: { start: 0, end: 0 },
          },
        ],
      },
    ]
    ;(Session as any).messages = mock(async () => {
      if (anchorTime === null) return baseMsgs
      return [
        ...baseMsgs,
        {
          info: {
            id: "msg_anchor",
            role: "assistant",
            sessionID: "ses_regression_cooldown",
            summary: true,
            time: { created: anchorTime },
          },
          parts: [
            {
              id: "prt_anchor",
              messageID: "msg_anchor",
              sessionID: "ses_regression_cooldown",
              type: "text",
              text: "## Round 1\n\n**User**\n\ngo\n\n**Assistant**\n\nx",
              time: { start: 0, end: 0 },
            },
          ],
        },
      ]
    })

    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
      // Anchor would be written into the message stream; simulate by setting time.
      anchorTime = Date.now()
    })

    // First rebind: no anchor yet → cooldown false → succeeds.
    const r1 = await SessionCompaction.run({
      sessionID: "ses_regression_cooldown",
      observed: "rebind",
      step: 10,
    })
    expect(r1).toBe("continue")
    expect(writes).toHaveLength(1)

    // Immediate retry: anchor is ~0ms ago, well within 30s window → throttled.
    const r2 = await SessionCompaction.run({
      sessionID: "ses_regression_cooldown",
      observed: "rebind",
      step: 11,
    })
    expect(r2).toBe("continue")
    expect(writes).toHaveLength(1) // still only one write — second was throttled

    // Simulate 31s passing: shift anchor 31s into the past.
    anchorTime = Date.now() - 31_000
    const r3 = await SessionCompaction.run({
      sessionID: "ses_regression_cooldown",
      observed: "rebind",
      step: 14,
    })
    expect(r3).toBe("continue")
    expect(writes).toHaveLength(2) // cooldown expired → second anchor allowed
  })

  it("structural defense: INJECT_CONTINUE table denies rebind even if a future caller forgets the cooldown", () => {
    // The 2026-04-27 fix had three layered defenses; the redesign collapses
    // them to one: INJECT_CONTINUE is a frozen table literal. There is no
    // code path that takes "rebind" and emits a synthetic Continue. This is
    // the defense of last resort even if cooldown / state-driven evaluation
    // both miss.
    const t = SessionCompaction.__test__.INJECT_CONTINUE
    expect(t["rebind"]).toBe(false)
    expect(t["continuation-invalidated"]).toBe(false)
    expect(t["provider-switched"]).toBe(false)
    expect(t["manual"]).toBe(false)
    // The table is frozen — accidental mutation would TypeError, not silently
    // re-enable the bug
    expect(Object.isFrozen(t)).toBe(true)
  })
})
