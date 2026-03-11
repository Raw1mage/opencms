import { beforeEach, describe, expect, it, mock } from "bun:test"

const state = {
  version: 1,
  accountHealth: {},
  rateLimits: {},
  dailyRateLimitCounts: {},
  sameProviderRotationCooldowns: {} as Record<
    string,
    { until: number; rotatedAt: number; fromAccountId: string; toAccountId: string; modelID: string }
  >,
}

describe("SameProviderRotationGuard", () => {
  beforeEach(() => {
    state.sameProviderRotationCooldowns = {}
    mock.restore()
    mock.module("./state", () => ({
      readUnifiedState: () => state,
      writeUnifiedState: (next: typeof state) => {
        state.sameProviderRotationCooldowns = structuredClone(next.sameProviderRotationCooldowns)
      },
    }))
  })

  it("records a provider+account cooldown after same-provider rotation", async () => {
    const { SameProviderRotationGuard } = await import("./same-provider-rotation-guard")
    const guard = new SameProviderRotationGuard()

    guard.mark("github-copilot", "acct-a", "acct-b", "gpt-4o", 300_000)

    expect(guard.isCoolingDown("github-copilot", "acct-a")).toBe(true)
    expect(guard.isCoolingDown("github-copilot", "acct-b")).toBe(false)
    expect(guard.getWaitTime("github-copilot", "acct-a")).toBeGreaterThan(0)
    expect(state.sameProviderRotationCooldowns["github-copilot:acct-a"]?.fromAccountId).toBe("acct-a")
    expect(state.sameProviderRotationCooldowns["github-copilot:acct-a"]?.toAccountId).toBe("acct-b")
  })
})
