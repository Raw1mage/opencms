import { describe, expect, it } from "bun:test"

import { calculateBackoffMs, parseRateLimitReason } from "./backoff"

describe("rotation backoff guardrails", () => {
  it("gives quota exhausted vectors at least five hours of cooldown", () => {
    expect(calculateBackoffMs("QUOTA_EXHAUSTED", 0)).toBeGreaterThanOrEqual(18_000_000)
  })

  it("extends repeated same-day generic rate limits to five hours", () => {
    expect(calculateBackoffMs("RATE_LIMIT_EXCEEDED", 0, undefined, 2)).toBeGreaterThanOrEqual(18_000_000)
    expect(calculateBackoffMs("UNKNOWN", 0, undefined, 2)).toBeGreaterThanOrEqual(18_000_000)
  })

  it("treats OpenAI usage_limit_reached as quota exhaustion", () => {
    expect(parseRateLimitReason("usage_limit_reached", "The usage limit has been reached", 429)).toBe(
      "QUOTA_EXHAUSTED",
    )
  })

  // @plans/codex-rotation-hotfix Phase 4 — passive classification belt-and-suspenders
  // When cockpit is unreachable, codex 5H / weekly messages still classify as
  // QUOTA_EXHAUSTED so the account does not get stuck on the short RPM path.
  describe("codex 5H / weekly window pattern matches (Phase 4)", () => {
    it.each([
      "You have reached the 5 hour limit for this model.",
      "Quota window: 5-hour limit.",
      "The five hour limit has been reached.",
      "response_time_window_exhausted",
      "response time window exhausted for this account",
      "Usage limit reached",
      "The usage limit has been reached for this billing period",
      "Usage limit exceeded",
      "Weekly limit hit",
      "Weekly usage cap exceeded",
    ])("classifies codex drain message %p as QUOTA_EXHAUSTED", (msg) => {
      expect(parseRateLimitReason(undefined, msg, 429)).toBe("QUOTA_EXHAUSTED")
    })

    it("non-matching codex-style messages fall through to prior classification", () => {
      // "rate limit" still wins over the codex patterns when both could match
      expect(parseRateLimitReason(undefined, "rate limit: too many requests per minute", 429)).toBe("RATE_LIMIT_SHORT")
      // a benign 429 message with none of the codex keywords remains UNKNOWN
      expect(parseRateLimitReason(undefined, "something else happened", 429)).toBe("UNKNOWN")
    })
  })
})
