import { describe, expect, it } from "bun:test"

import { shouldPromoteToProviderCooldown } from "./rate-limit-judge"

describe("rate-limit judge provider cooldown promotion", () => {
  it("promotes quota-style exhaustion to provider cooldown", () => {
    expect(shouldPromoteToProviderCooldown("QUOTA_EXHAUSTED", 18_000_000)).toBe(true)
    expect(shouldPromoteToProviderCooldown("RATE_LIMIT_LONG", 18_000_000)).toBe(true)
    expect(shouldPromoteToProviderCooldown("TOKEN_REFRESH_FAILED", 18_000_000)).toBe(true)
  })

  it("only promotes generic rate limits when cooldown is already long", () => {
    expect(shouldPromoteToProviderCooldown("RATE_LIMIT_EXCEEDED", 60_000)).toBe(false)
    expect(shouldPromoteToProviderCooldown("RATE_LIMIT_EXCEEDED", 18_000_000)).toBe(true)
    // UNKNOWN must NOT promote — an unrecognised 429 (e.g. stale token) would
    // otherwise wrongly lock the whole provider and cascade across accounts.
    // (See shouldPromoteToProviderCooldown default branch.)
    expect(shouldPromoteToProviderCooldown("UNKNOWN", 18_000_000)).toBe(false)
    expect(shouldPromoteToProviderCooldown("RATE_LIMIT_SHORT", 18_000_000)).toBe(false)
  })
})
