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
})
