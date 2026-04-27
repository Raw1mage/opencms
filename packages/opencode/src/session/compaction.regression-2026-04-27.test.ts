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
const originalMemoryMarkCompacted = Memory.markCompacted
const originalSessionGet = Session.get
const originalProviderGetModel = Provider.getModel

afterEach(() => {
  ;(Memory as any).read = originalMemoryRead
  ;(Memory as any).markCompacted = originalMemoryMarkCompacted
  ;(Session as any).get = originalSessionGet
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
    ;(Memory as any).markCompacted = mock(async () => {})
    ;(Session as any).get = mock(async () => ({
      execution: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-yeatsraw" },
    }))
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
    // Setup: session with Memory + lastCompactedAt freshly set (simulates the
    // moment immediately after the first rebind anchor was written)
    let lastCompacted: { round: number; timestamp: number } | null = null
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
      lastCompactedAt: lastCompacted,
      rawTailBudget: 5,
    }))
    ;(Memory as any).markCompacted = mock(async (_sid: string, at: { round: number; timestamp?: number }) => {
      lastCompacted = { round: at.round, timestamp: at.timestamp ?? Date.now() }
    })
    ;(Session as any).get = mock(async () => ({
      execution: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
    }))
    ;(Provider as any).getModel = mock(async () => ({
      id: "gpt-5.5",
      providerId: "codex",
      limit: { context: 272_000, input: 272_000, output: 32_000 },
      cost: { input: 1 },
    }))

    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    // First rebind: succeeds, writes anchor, sets lastCompactedAt
    const r1 = await SessionCompaction.run({
      sessionID: "ses_regression_cooldown",
      observed: "rebind",
      step: 10,
    })
    expect(r1).toBe("continue")
    expect(writes).toHaveLength(1)

    // Now Memory.read returns the updated lastCompactedAt
    ;(Memory as any).read = mock(async () => ({
      sessionID: "ses_regression_cooldown",
      version: 2,
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
      lastCompactedAt: lastCompacted, // = { round: 10, ... }
      rawTailBudget: 5,
    }))

    // Immediate retry (within cooldown 4 rounds): should be throttled
    const r2 = await SessionCompaction.run({
      sessionID: "ses_regression_cooldown",
      observed: "rebind",
      step: 11,
    })
    expect(r2).toBe("continue") // continue, not stop, because cooldown returns
    expect(writes).toHaveLength(1) // still only one write — second was throttled

    // 4 rounds later: cooldown expired, second anchor allowed
    const r3 = await SessionCompaction.run({
      sessionID: "ses_regression_cooldown",
      observed: "rebind",
      step: 14,
    })
    expect(r3).toBe("continue")
    expect(writes).toHaveLength(2) // now two anchors — but each from a real condition past cooldown
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
