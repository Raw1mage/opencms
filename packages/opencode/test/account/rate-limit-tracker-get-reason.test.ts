/**
 * getReason() must surface the *judged* RateLimitReason the tracker stored for
 * a vector, with the same model→provider precedence as isRateLimited(), and
 * undefined once the entry expires or was never set.
 *
 * Regression guard for the rotation-event mislabel: Anthropic overloaded_error
 * (MODEL_CAPACITY_EXHAUSTED) rotations were being reported as the generic
 * RATE_LIMIT_EXCEEDED because the emitter collapsed every rotation to a binary
 * label instead of reading the stored reason.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"

// In-memory unified state so the tracker never touches real runtime files.
let memState: any
mock.module("../../src/account/rotation/state", () => ({
  readUnifiedState: () => memState,
  writeUnifiedState: (s: any) => {
    memState = s
  },
}))

async function freshTracker() {
  memState = { rateLimits: {}, dailyRateLimitCounts: {}, healthScores: {} }
  const { RateLimitTracker } = await import("../../src/account/rotation/rate-limit-tracker")
  return new RateLimitTracker()
}

describe("RateLimitTracker.getReason", () => {
  beforeEach(() => {
    memState = { rateLimits: {}, dailyRateLimitCounts: {}, healthScores: {} }
  })

  test("returns the stored model-specific reason, not a generic label", async () => {
    const t = await freshTracker()
    t.markRateLimited("acc1", "claude-cli", "MODEL_CAPACITY_EXHAUSTED", 300_000, "claude-opus-4-8")

    expect(t.getReason("acc1", "claude-cli", "claude-opus-4-8")).toBe("MODEL_CAPACITY_EXHAUSTED")
  })

  test("returns undefined for a vector that was never rate-limited", async () => {
    const t = await freshTracker()
    expect(t.getReason("acc1", "claude-cli", "claude-opus-4-8")).toBeUndefined()
  })

  test("provider-level entry covers all models for that account", async () => {
    const t = await freshTracker()
    t.markRateLimited("acc1", "claude-cli", "QUOTA_EXHAUSTED", 300_000) // no model => provider-wide

    expect(t.getReason("acc1", "claude-cli", "any-model")).toBe("QUOTA_EXHAUSTED")
  })

  test("expired entry yields undefined", async () => {
    const t = await freshTracker()
    t.markRateLimited("acc1", "claude-cli", "RATE_LIMIT_SHORT", -1_000, "claude-opus-4-8") // already in the past

    expect(t.getReason("acc1", "claude-cli", "claude-opus-4-8")).toBeUndefined()
  })
})
