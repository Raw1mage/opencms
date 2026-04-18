/**
 * codex-quota-candidate-filter.test.ts — Phase 2 of plans/codex-rotation-hotfix.
 *
 * Before: `buildFallbackCandidates` marked a candidate `isQuotaLimited`
 * only when `vector.providerId === "openai"`; codex candidates passed the
 * filter even when their 5H window was already drained.
 *
 * After: `evaluateWhamUsageQuota` returns `exhausted: true` for both
 * openai and codex families whenever `hourlyRemaining <= 0` or
 * `weeklyRemaining <= 0`. This file tests the extracted pure helper
 * directly so the integration remains lightweight and deterministic.
 */
import { describe, expect, test } from "bun:test"

import { WHAM_USAGE_FAMILIES, evaluateWhamUsageQuota } from "../../src/account/rotation3d"

describe("WHAM_USAGE_FAMILIES", () => {
  test("covers openai and codex only", () => {
    expect(WHAM_USAGE_FAMILIES.has("openai")).toBe(true)
    expect(WHAM_USAGE_FAMILIES.has("codex")).toBe(true)
    expect(WHAM_USAGE_FAMILIES.has("gemini-cli")).toBe(false)
    expect(WHAM_USAGE_FAMILIES.has("anthropic")).toBe(false)
    expect(WHAM_USAGE_FAMILIES.has("opencode")).toBe(false)
  })
})

describe("evaluateWhamUsageQuota", () => {
  const quotas = {
    "codex-subscription-alpha": { hourlyRemaining: 100, weeklyRemaining: 100 },
    "codex-subscription-beta": { hourlyRemaining: 0, weeklyRemaining: 100 },
    "codex-subscription-gamma": { hourlyRemaining: 42, weeklyRemaining: 0 },
    "codex-subscription-null": null,
    "openai-subscription-delta": { hourlyRemaining: 0, weeklyRemaining: 0 },
  }

  test("healthy codex account is not exhausted", () => {
    const result = evaluateWhamUsageQuota("codex", "codex-subscription-alpha", quotas)
    expect(result.exhausted).toBe(false)
    expect(result.hourlyRemaining).toBe(100)
  })

  test("codex account with hourly exhausted is flagged", () => {
    const result = evaluateWhamUsageQuota("codex", "codex-subscription-beta", quotas)
    expect(result.exhausted).toBe(true)
    expect(result.hourlyRemaining).toBe(0)
    expect(result.weeklyRemaining).toBe(100)
  })

  test("codex account with weekly exhausted is flagged even when hourly has headroom", () => {
    const result = evaluateWhamUsageQuota("codex", "codex-subscription-gamma", quotas)
    expect(result.exhausted).toBe(true)
    expect(result.hourlyRemaining).toBe(42)
    expect(result.weeklyRemaining).toBe(0)
  })

  test("openai account exhausted is still flagged (unchanged behaviour)", () => {
    const result = evaluateWhamUsageQuota("openai", "openai-subscription-delta", quotas)
    expect(result.exhausted).toBe(true)
  })

  test("missing quota entry is treated as healthy (trust rate-limit tracker for this account)", () => {
    const result = evaluateWhamUsageQuota("codex", "codex-subscription-unknown", quotas)
    expect(result.exhausted).toBe(false)
  })

  test("null quota entry is treated as healthy (quota not yet fetched)", () => {
    const result = evaluateWhamUsageQuota("codex", "codex-subscription-null", quotas)
    expect(result.exhausted).toBe(false)
  })

  test("non-whamusage families always return not exhausted regardless of quota dict", () => {
    const r1 = evaluateWhamUsageQuota("anthropic", "claude-cli-subscription-x", {
      ...quotas,
      "claude-cli-subscription-x": { hourlyRemaining: 0, weeklyRemaining: 0 },
    } as any)
    expect(r1.exhausted).toBe(false)

    const r2 = evaluateWhamUsageQuota("gemini-cli", "gemini-cli-api-y", quotas)
    expect(r2.exhausted).toBe(false)
  })
})

describe("Phase 2 regression — 3 codex candidates filter", () => {
  test("only the exhausted candidate is flagged", () => {
    const quotas = {
      "codex-subscription-a": { hourlyRemaining: 10, weeklyRemaining: 100 },
      "codex-subscription-b": { hourlyRemaining: 0, weeklyRemaining: 100 },
      "codex-subscription-c": { hourlyRemaining: 20, weeklyRemaining: 50 },
    }
    const candidates = Object.keys(quotas).map((id) => ({
      id,
      result: evaluateWhamUsageQuota("codex", id, quotas),
    }))
    const exhausted = candidates.filter((c) => c.result.exhausted)
    const healthy = candidates.filter((c) => !c.result.exhausted)
    expect(exhausted.map((c) => c.id)).toEqual(["codex-subscription-b"])
    expect(healthy.map((c) => c.id).sort()).toEqual(["codex-subscription-a", "codex-subscription-c"])
  })
})
