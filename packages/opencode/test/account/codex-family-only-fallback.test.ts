/**
 * codex-family-only-fallback.test.ts — Phase 3 of plans/codex-rotation-hotfix.
 *
 * These tests cover the pure gate `enforceCodexFamilyOnly`:
 *
 *   - when current vector is codex, only codex candidates survive;
 *   - when current vector is NOT codex, the list is returned untouched
 *     (no cross-provider regression — anthropic/gemini still rotate
 *     across providers as before);
 *   - the empty-pool case (all codex candidates filtered out by prior
 *     quota/rate-limit gates) is visible to callers, so
 *     handleRateLimitFallback can raise CodexFamilyExhausted instead of
 *     silently returning null.
 */
import { describe, expect, test } from "bun:test"

import {
  enforceCodexFamilyOnly,
  type FallbackCandidate,
  type ModelVector,
} from "../../src/account/rotation3d"

function candidate(
  providerId: string,
  accountId: string,
  modelID: string,
  overrides: Partial<FallbackCandidate> = {},
): FallbackCandidate {
  return {
    providerId,
    accountId,
    modelID,
    healthScore: 100,
    isRateLimited: false,
    waitTimeMs: 0,
    priority: 10,
    reason: "same-model-diff-account",
    ...overrides,
  }
}

describe("enforceCodexFamilyOnly", () => {
  const codexCurrent: ModelVector = {
    providerId: "codex",
    accountId: "codex-subscription-a",
    modelID: "gpt-5.4",
  }

  test("codex current drops non-codex candidates", () => {
    const kept = enforceCodexFamilyOnly(codexCurrent, [
      candidate("codex", "codex-subscription-b", "gpt-5.4"),
      candidate("anthropic", "claude-cli-subscription-y", "claude-opus-4-7"),
      candidate("codex", "codex-subscription-c", "gpt-5.4"),
      candidate("gemini-cli", "gemini-cli-subscription-z", "gemini-2.5-pro"),
    ])

    expect(kept.map((c) => c.providerId)).toEqual(["codex", "codex"])
    expect(kept.map((c) => c.accountId).sort()).toEqual(["codex-subscription-b", "codex-subscription-c"])
  })

  test("codex current with only non-codex candidates returns empty pool (triggers CodexFamilyExhausted upstream)", () => {
    const kept = enforceCodexFamilyOnly(codexCurrent, [
      candidate("anthropic", "claude-cli-subscription-y", "claude-opus-4-7"),
      candidate("opencode", "opencode-oauth-x", "claude-sonnet-4-6"),
    ])

    expect(kept).toHaveLength(0)
  })

  test("non-codex current passes candidates through untouched", () => {
    const anthropicCurrent: ModelVector = {
      providerId: "anthropic",
      accountId: "claude-cli-subscription-y",
      modelID: "claude-opus-4-7",
    }
    const candidates = [
      candidate("anthropic", "claude-cli-subscription-z", "claude-opus-4-7"),
      candidate("codex", "codex-subscription-a", "gpt-5.4"),
      candidate("gemini-cli", "gemini-cli-subscription-z", "gemini-2.5-pro"),
    ]
    const kept = enforceCodexFamilyOnly(anthropicCurrent, candidates)

    expect(kept).toEqual(candidates)
  })

  test("codex current with mixed pool where non-codex is highest priority still drops non-codex", () => {
    // Regression guard: even if the non-codex candidate would be scored first,
    // we must not silently pick it — this is the whole point of the gate.
    const kept = enforceCodexFamilyOnly(codexCurrent, [
      candidate("anthropic", "claude-cli-subscription-y", "claude-opus-4-7", { priority: 999, healthScore: 100 }),
      candidate("codex", "codex-subscription-b", "gpt-5.4", { priority: 1, healthScore: 50 }),
    ])

    expect(kept.map((c) => c.providerId)).toEqual(["codex"])
    expect(kept.map((c) => c.accountId)).toEqual(["codex-subscription-b"])
  })
})

describe("CodexFamilyExhausted error class", () => {
  test("raises with the hotfix-defined data shape", async () => {
    const { CodexFamilyExhausted } = await import("../../src/account/rate-limit-judge")

    const err = new CodexFamilyExhausted({
      providerId: "codex",
      accountId: "codex-subscription-a",
      modelId: "gpt-5.4",
      triedCount: 3,
      message: "All codex accounts drained",
    })

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("CodexFamilyExhausted")
    expect(err.data.providerId).toBe("codex")
    expect(err.data.triedCount).toBe(3)
    expect(CodexFamilyExhausted.isInstance(err)).toBe(true)
  })

  test("isInstance returns false for unrelated errors", async () => {
    const { CodexFamilyExhausted } = await import("../../src/account/rate-limit-judge")
    expect(CodexFamilyExhausted.isInstance(new Error("boom"))).toBe(false)
    expect(CodexFamilyExhausted.isInstance({ name: "OtherError" })).toBe(false)
    expect(CodexFamilyExhausted.isInstance(undefined)).toBe(false)
  })
})
