import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Memory } from "./memory"
import { Session } from "."
import { Config } from "@/config/config"

const originalConfigGet = Config.get
const originalMemoryRead = Memory.read

afterEach(() => {
  ;(Config as any).get = originalConfigGet
  ;(Memory as any).read = originalMemoryRead
})

describe("SessionCompaction.isOverflow (token-pressure predicate)", () => {
  // Phase 13.1: isOverflow's internal round-based cooldown was removed —
  // cooldown is now decided once upstream via `Cooldown.shouldThrottle` (anchor
  // recency, 30s window). isOverflow returns the raw token-comparison verdict.

  it("triggers when tokens cross the usable budget (high context fill)", async () => {
    ;(Config as any).get = mock(async () => ({
      compaction: { auto: true, reserved: 20_000 },
    }))
    const model = {
      id: "gpt-5.4",
      providerId: "openai",
      limit: { context: 272_000, input: 272_000, output: 32_000 },
      cost: { input: 1 },
    } as any
    const tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 260_000,
    }
    await expect(
      SessionCompaction.isOverflow({
        tokens,
        model,
        sessionID: "ses_overflow_high",
        currentRound: 5,
      }),
    ).resolves.toBe(true)
  })

  it("triggers at the emergency ceiling regardless of any prior compaction", async () => {
    ;(Config as any).get = mock(async () => ({
      compaction: { auto: true, reserved: 20_000 },
    }))
    const model = {
      id: "gpt-5.4",
      providerId: "openai",
      limit: { context: 272_000, input: 272_000, output: 32_000 },
      cost: { input: 1 },
    } as any
    const tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 270_500,
    }
    await expect(
      SessionCompaction.isOverflow({
        tokens,
        model,
        sessionID: "ses_overflow_emergency",
        currentRound: 11,
      }),
    ).resolves.toBe(true)
  })

  it("truncates compaction history for small-context models before overflowing the prompt window", () => {
    const model = {
      id: "small-model",
      providerId: "openai",
      limit: {
        context: 32_000,
        input: 32_000,
        output: 8_000,
      },
      cost: {
        input: 1,
      },
    } as any

    const messages = Array.from({ length: 20 }, (_, index) => ({
      info: {
        id: `msg_${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        providerId: "openai",
        modelID: "small-model",
      },
      parts: [
        {
          id: `part_${index}`,
          type: "text",
          text: `message-${index} ` + "x".repeat(10_000),
        },
      ],
    })) as any

    const result = SessionCompaction.truncateModelMessagesForSmallContext({
      messages,
      model,
      sessionID: "ses_small_context_test",
    })

    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result.messages).length).toBeLessThanOrEqual(result.safeCharBudget)
    expect(result.messages.length).toBeGreaterThan(0)
  })

  // Phase 13.2-B: rebind checkpoint disk-file tests deleted.
  // - "applies a safe rebind checkpoint only after a non-tool boundary"
  // - "rebuilds replay as checkpoint prefix plus raw tail steps"
  // - "persists rebind checkpoint metadata including lastMessageId"
  // - "prunes stale rebind checkpoints"
  // - "phase 8: applyRebindCheckpoint locates boundary via summary anchor"
  // - "phase 8: applyRebindCheckpoint with no anchor + no lastMessageId"
  //
  // The disk-file recovery surface no longer exists. Equivalent stream-anchor
  // recovery behaviour (INV-2 single-anchor-on-rotation, INV-3 no-Continue,
  // boundary safety on tool calls) is covered by:
  // - compaction.regression-2026-04-27.test.ts (INV-2, INV-3)
  // - compaction-run.test.ts (cooldown gate + anchor message handling)
  // - prompt.applyStreamAnchorRebind.test.ts (boundary safety; added below)

  // event_2026-04-27_runloop_rebind_loop regression coverage migrated
  // to compaction.regression-2026-04-27.test.ts after phase 7 deleted
  // markRebindCompaction / consumeRebindCompaction. The new tests use
  // run({observed: "rebind"}) which exercises the same defenses
  // (INV-3 no-Continue, INV-2 single-anchor-with-cooldown) on the new
  // state-driven path.

  // ── Phase 11+ : overflowThreshold config ───────────────────────────

  it("phase 11+: overflowThreshold=0.9 fires overflow at 90% of context (overrides legacy reserved-based)", async () => {
    ;(Config as any).get = mock(async () => ({
      compaction: {
        auto: true,
        cooldownRounds: 4,
        reserved: 80_000,
        overflowThreshold: 0.9,
      },
    }))

    const model = {
      id: "gpt-5.5",
      providerId: "codex",
      limit: { context: 272_000, input: 272_000, output: 32_000 },
      cost: { input: 1 },
    } as any

    const sessionID = `ses_overflow_threshold_${Date.now()}`
    ;(Memory as any).read = mock(async () => ({
      sessionID,
      version: 1,
      updatedAt: 1,
      turnSummaries: [],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null, // no cooldown
      rawTailBudget: 5,
    }))

    // Below 90% (191K of 272K ≈ 70%) — should NOT fire under threshold mode
    // (note: legacy reserved-based usable would fire here at 192K)
    await expect(
      SessionCompaction.isOverflow({
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 191_000 },
        model,
        sessionID,
        currentRound: 1,
      }),
    ).resolves.toBe(false)

    // At 91% (247K) — SHOULD fire under threshold-based usable
    await expect(
      SessionCompaction.isOverflow({
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 247_000 },
        model,
        sessionID,
        currentRound: 1,
      }),
    ).resolves.toBe(true)
  })

  it("phase 11+: overflowThreshold undefined keeps legacy reserved-based behaviour", async () => {
    ;(Config as any).get = mock(async () => ({
      compaction: {
        auto: true,
        cooldownRounds: 4,
        reserved: 80_000,
        // overflowThreshold intentionally absent
      },
    }))

    const model = {
      id: "gpt-5.5",
      providerId: "codex",
      limit: { context: 272_000, input: 272_000, output: 32_000 },
      cost: { input: 1 },
    } as any

    const sessionID = `ses_overflow_legacy_${Date.now()}`
    ;(Memory as any).read = mock(async () => ({
      sessionID,
      version: 1,
      updatedAt: 1,
      turnSummaries: [],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }))

    // 200K with reserved=80K → usable=192K → SHOULD fire (legacy)
    await expect(
      SessionCompaction.isOverflow({
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 200_000 },
        model,
        sessionID,
        currentRound: 1,
      }),
    ).resolves.toBe(true)
  })

  // Phase 8 anchor-scan tests deleted in Phase 13.2-B — `applyRebindCheckpoint`
  // is gone. Equivalent stream-anchor recovery is exercised in
  // prompt.applyStreamAnchorRebind.test.ts.

  // Phase 11+ smart prune retired 2026-04-28 (cache-hostile, marginal
  // utility — prune broke the codex prefix cache from 80% to 90% while
  // only delaying compaction by ~10%). The two prune tests
  // ("skips when context utilization is below floor" and "respects
  // TurnSummary safety") were deleted along with `SessionCompaction.prune`.
  // Single 90%-overflow gate (`run({observed: "overflow"})`) is now the
  // only context-management path.
})
