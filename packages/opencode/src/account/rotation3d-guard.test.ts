import { beforeEach, describe, expect, it, mock } from "bun:test"

describe("rotation3d same-provider rotate guard", () => {
  beforeEach(() => {
    mock.restore()
    mock.module("./rotation", () => ({
      getRateLimitTracker: () => ({
        isRateLimited: () => false,
        getWaitTime: () => 0,
      }),
      getHealthTracker: () => ({
        getScore: () => 80,
      }),
      getSameProviderRotationGuard: () => ({
        getWaitTime: (providerId: string) => (providerId === "github-copilot" ? 300_000 : 0),
        getProviderWaitTime: (providerId: string) => (providerId === "github-copilot" ? 300_000 : 0),
      }),
    }))
  })

  it("skips same-provider candidates while allowing diff-provider fallback", async () => {
    const { selectBestFallback, DEFAULT_ROTATION3D_CONFIG } = await import("./rotation3d")

    const best = selectBestFallback(
      [
        {
          providerId: "github-copilot",
          accountId: "acct-b",
          modelID: "gpt-4o",
          healthScore: 90,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "same-model-diff-account",
        },
        {
          providerId: "openai",
          accountId: "openai-a",
          modelID: "gpt-5",
          healthScore: 60,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "diff-provider",
        },
      ],
      {
        providerId: "github-copilot",
        accountId: "acct-a",
        modelID: "gpt-4o",
      },
      { ...DEFAULT_ROTATION3D_CONFIG, allowSameProviderFallback: false },
    )

    expect(best?.providerId).toBe("openai")
    expect(best?.accountId).toBe("openai-a")
  })

  it("blocks same-provider different-model fallback when same-provider fallback is disabled", async () => {
    const { selectBestFallback, DEFAULT_ROTATION3D_CONFIG } = await import("./rotation3d")

    const best = selectBestFallback(
      [
        {
          providerId: "github-copilot",
          accountId: "acct-a",
          modelID: "gpt-4.1",
          healthScore: 90,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "diff-model-same-account",
        },
        {
          providerId: "openai",
          accountId: "openai-a",
          modelID: "gpt-5",
          healthScore: 60,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "diff-provider",
        },
      ],
      {
        providerId: "github-copilot",
        accountId: "acct-a",
        modelID: "gpt-4o",
      },
      { ...DEFAULT_ROTATION3D_CONFIG, allowSameProviderFallback: false },
    )

    expect(best?.providerId).toBe("openai")
    expect(best?.modelID).toBe("gpt-5")
  })

  // Regression 2026-05-07: with 30+ codex accounts, a single same-family
  // rotation cooldown was hard-blocking every other codex candidate for 5 min,
  // forcing rate-limit fallback to gemini/anthropic even when healthy codex
  // accounts existed. The provider-wide hard filter is gone; the +1000
  // same-family scoring bonus in scoreCandidateByStrategy now keeps codex
  // sessions on codex.
  it("prefers same-family codex rotation even with armed rotation cooldown", async () => {
    const { selectBestFallback, DEFAULT_ROTATION3D_CONFIG } = await import("./rotation3d")

    const best = selectBestFallback(
      [
        {
          providerId: "codex",
          accountId: "codex-acct-b",
          modelID: "gpt-5.5",
          healthScore: 90,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "same-model-diff-account",
        },
        {
          providerId: "gemini-cli",
          accountId: "gemini-acct-a",
          modelID: "gemini-3-pro",
          healthScore: 90,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "diff-provider",
        },
      ],
      {
        providerId: "codex",
        accountId: "codex-acct-a",
        modelID: "gpt-5.5",
      },
      DEFAULT_ROTATION3D_CONFIG,
    )

    // mock returns 5min cooldown only for github-copilot, so codex pool
    // is unblocked and same-family scoring bonus wins
    expect(best?.providerId).toBe("codex")
    expect(best?.accountId).toBe("codex-acct-b")
  })

  it("still prefers same-family codex even when codex itself has an armed cooldown", async () => {
    mock.restore()
    mock.module("./rotation", () => ({
      getRateLimitTracker: () => ({
        isRateLimited: () => false,
        getWaitTime: () => 0,
      }),
      getHealthTracker: () => ({
        getScore: () => 80,
      }),
      getSameProviderRotationGuard: () => ({
        getWaitTime: () => 300_000,
        // The historical regression: provider-wide cooldown forced cross-family.
        // After the fix, this signal is diagnostic-only and does not filter.
        getProviderWaitTime: (providerId: string) => (providerId === "codex" ? 300_000 : 0),
      }),
    }))

    const { selectBestFallback, DEFAULT_ROTATION3D_CONFIG } = await import("./rotation3d")

    const best = selectBestFallback(
      [
        {
          providerId: "codex",
          accountId: "codex-acct-b",
          modelID: "gpt-5.5",
          healthScore: 90,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "same-model-diff-account",
        },
        {
          providerId: "gemini-cli",
          accountId: "gemini-acct-a",
          modelID: "gemini-3-pro",
          healthScore: 90,
          isRateLimited: false,
          waitTimeMs: 0,
          priority: 0,
          reason: "diff-provider",
        },
      ],
      {
        providerId: "codex",
        accountId: "codex-acct-a",
        modelID: "gpt-5.5",
      },
      DEFAULT_ROTATION3D_CONFIG,
    )

    expect(best?.providerId).toBe("codex")
    expect(best?.accountId).toBe("codex-acct-b")
  })
})
