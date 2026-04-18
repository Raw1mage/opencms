/**
 * codex-cockpit-backoff.test.ts — Phase 1 of plans/codex-rotation-hotfix.
 *
 * Before: `fetchCockpitBackoff` only ran for providerId === "openai", so a
 * codex subscription account could sit on an exhausted 5H window and the
 * daemon would only learn about it after the stream stalled / errored.
 *
 * After: codex shares the openai cockpit path (wham/usage endpoint + bearer
 * format are identical). This test mocks the quota fetcher and verifies the
 * cockpit decisions via the public `RateLimitJudge.markRateLimited` surface
 * (which internally calls `fetchCockpitBackoff` for cockpit-strategy
 * providers). We don't export `fetchCockpitBackoff`, but its behaviour is
 * observable via the backoff fields recorded on the RateLimitTracker.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"

import { getBackoffStrategy } from "../../src/account/rate-limit-judge"

describe("getBackoffStrategy (Phase 1 gate)", () => {
  test("openai → cockpit", () => {
    expect(getBackoffStrategy("openai")).toBe("cockpit")
  })

  test("codex → cockpit (hotfix)", () => {
    expect(getBackoffStrategy("codex")).toBe("cockpit")
  })

  test("gemini-cli and google-api → counter (unchanged)", () => {
    expect(getBackoffStrategy("gemini-cli")).toBe("counter")
    expect(getBackoffStrategy("google-api")).toBe("counter")
  })

  test("unknown provider → passive (unchanged)", () => {
    expect(getBackoffStrategy("anthropic")).toBe("passive")
    expect(getBackoffStrategy("opencode")).toBe("passive")
    expect(getBackoffStrategy("nvidia")).toBe("passive")
  })
})

describe("cockpit fetch delegates to getOpenAIQuota for codex accounts", () => {
  beforeEach(() => {
    mock.restore()
  })

  test("codex family uses the openai quota endpoint via shared fetcher", async () => {
    // Spy-replace getOpenAIQuota so we can assert it's called for codex.
    let calledWith: { accountId?: string; opts?: unknown } = {}
    mock.module("../../src/account/quota/openai", () => ({
      getOpenAIQuota: async (accountId: string, opts?: unknown) => {
        calledWith = { accountId, opts }
        return { hourlyRemaining: 0, weeklyRemaining: 42, hasHourlyWindow: true }
      },
      // Keep the rest of the module reachable for imports.
      getOpenAIQuotaForDisplay: async () => null,
      CODEX_USAGE_URL: "https://chatgpt.com/backend-api/wham/usage",
    }))

    // Reimport the module under test so the mock takes effect.
    const { fetchCockpitBackoffForTest } = await import(
      "./fixture/cockpit-helpers"
    )

    const result = await fetchCockpitBackoffForTest("codex", "codex-subscription-test", "gpt-5.4", 1_000)

    expect(calledWith.accountId).toBe("codex-subscription-test")
    expect(result.fromCockpit).toBe(true)
    // hourly exhausted → at least 5h backoff
    expect(result.backoffMs).toBeGreaterThanOrEqual(5 * 60 * 60 * 1000)
  })

  test("non-cockpit provider (anthropic) short-circuits without quota call", async () => {
    let called = 0
    mock.module("../../src/account/quota/openai", () => ({
      getOpenAIQuota: async () => {
        called++
        return null
      },
      getOpenAIQuotaForDisplay: async () => null,
      CODEX_USAGE_URL: "https://chatgpt.com/backend-api/wham/usage",
    }))

    const { fetchCockpitBackoffForTest } = await import(
      "./fixture/cockpit-helpers"
    )
    const result = await fetchCockpitBackoffForTest("anthropic", "anthropic-test", "claude-opus-4-5", 2_500)

    expect(called).toBe(0)
    expect(result.fromCockpit).toBe(false)
    expect(result.backoffMs).toBe(2_500)
  })

  test("cockpit fetch failure falls through to passive (fail-open on the fallback ms)", async () => {
    mock.module("../../src/account/quota/openai", () => ({
      getOpenAIQuota: async () => {
        throw new Error("simulated wham/usage outage")
      },
      getOpenAIQuotaForDisplay: async () => null,
      CODEX_USAGE_URL: "https://chatgpt.com/backend-api/wham/usage",
    }))

    const { fetchCockpitBackoffForTest } = await import(
      "./fixture/cockpit-helpers"
    )
    const result = await fetchCockpitBackoffForTest("codex", "codex-subscription-a", "gpt-5.4", 7_777)

    expect(result.fromCockpit).toBe(false)
    expect(result.backoffMs).toBe(7_777)
  })
})
