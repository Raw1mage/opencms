import { beforeEach, describe, expect, it, mock } from "bun:test"

const state = {
  rateLimits: {} as Record<string, Record<string, { resetTime: number; reason: string; model?: string }>>,
  dailyRateLimitCounts: {} as Record<string, { count: number; lastReset: number }>,
}

describe("RateLimitTracker provider-level cooldowns", () => {
  beforeEach(() => {
    state.rateLimits = {}
    state.dailyRateLimitCounts = {}
    mock.restore()
    mock.module("./state", () => ({
      readUnifiedState: () => state,
      writeUnifiedState: (next: typeof state) => {
        state.rateLimits = structuredClone(next.rateLimits)
        state.dailyRateLimitCounts = structuredClone(next.dailyRateLimitCounts)
      },
    }))
  })

  it("treats provider-level cooldown as blocking every model in that provider", async () => {
    const { RateLimitTracker } = await import("./rate-limit-tracker")
    const tracker = new RateLimitTracker()

    tracker.markRateLimited("acct-1", "github-copilot", "QUOTA_EXHAUSTED", 18_000_000)

    expect(tracker.isRateLimited("acct-1", "github-copilot", "gpt-4o")).toBe(true)
    expect(tracker.getWaitTime("acct-1", "github-copilot", "gpt-4o")).toBeGreaterThan(0)
  })

  it("persists removal of expired model cooldowns when checking availability", async () => {
    const accountId = "claude-cli-subscription-claude-cli-d5002de6"

    state.rateLimits = {
      [accountId]: {
        "claude-cli:claude-opus-4-8": {
          resetTime: Date.now() - 1,
          reason: "MODEL_CAPACITY_EXHAUSTED",
          model: "claude-opus-4-8",
        },
      },
    }

    const { RateLimitTracker } = await import("./rate-limit-tracker")
    const tracker = new RateLimitTracker()

    expect(tracker.isRateLimited(accountId, "claude-cli", "claude-opus-4-8")).toBe(false)
    expect(state.rateLimits).toEqual({})
  })

  it("persists removal of expired cooldowns when reading wait time", async () => {
    const accountId = "claude-cli-subscription-claude-cli-d5002de6"

    state.rateLimits = {
      [accountId]: {
        "claude-cli:claude-opus-4-8": {
          resetTime: Date.now() - 1,
          reason: "MODEL_CAPACITY_EXHAUSTED",
          model: "claude-opus-4-8",
        },
      },
    }

    const { RateLimitTracker } = await import("./rate-limit-tracker")
    const tracker = new RateLimitTracker()

    expect(tracker.getWaitTime(accountId, "claude-cli", "claude-opus-4-8")).toBe(0)
    expect(state.rateLimits).toEqual({})
  })

  it("clearAccount removes all persisted rate limits for a removed account", async () => {
    const accountId = "claude-cli-subscription-claude-cli-d5002de6"
    const survivor = "claude-cli-subscription-claude-cli-keepme"

    state.rateLimits = {
      [accountId]: {
        "claude-cli:claude-opus-4-8": {
          resetTime: Date.now() + 300_000,
          reason: "MODEL_CAPACITY_EXHAUSTED",
          model: "claude-opus-4-8",
        },
      },
      [survivor]: {
        "claude-cli:claude-opus-4-8": {
          resetTime: Date.now() + 300_000,
          reason: "MODEL_CAPACITY_EXHAUSTED",
          model: "claude-opus-4-8",
        },
      },
    }

    const { RateLimitTracker } = await import("./rate-limit-tracker")
    const tracker = new RateLimitTracker()

    tracker.clearAccount(accountId, "claude-cli")

    // The removed account is gone from persisted state; the other survives.
    expect(state.rateLimits[accountId]).toBeUndefined()
    expect(state.rateLimits[survivor]).toBeDefined()
    expect(tracker.isRateLimited(accountId, "claude-cli", "claude-opus-4-8")).toBe(false)
    expect(tracker.isRateLimited(survivor, "claude-cli", "claude-opus-4-8")).toBe(true)
  })
})
