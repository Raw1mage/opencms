import { describe, expect, test } from "bun:test"
import {
  gateAnchorTokensForClaude,
  latestRealPromptTokens,
  shouldEnrichAnchor,
} from "../../src/session/claude-context-policy"
import type { MessageV2 } from "../../src/session/message-v2"

// compaction_recency-fadeout-tiers DD-9 — guard the claude-gated real-token floor
// on the A-tier enrichment gate. The chars estimate under-counts mixed
// markdown/code anchors ~1.3x, so the aFloor gate under-fired; we floor the gate
// input on the most recent completed turn's REAL reported prompt tokens. The fix
// is additive (only ever fires MORE) and claude-only (codex byte-identical).

function assistant(opts: {
  input?: number
  cacheRead?: number
  cacheWrite?: number
  summary?: boolean
  noTokens?: boolean
}): MessageV2.WithParts {
  const info: any = {
    id: "msg",
    role: "assistant",
    sessionID: "ses",
    time: { created: 0 },
    cost: 0,
  }
  if (opts.summary) info.summary = true
  if (!opts.noTokens) {
    info.tokens = {
      input: opts.input ?? 0,
      output: 0,
      reasoning: 0,
      cache: { read: opts.cacheRead ?? 0, write: opts.cacheWrite ?? 0 },
    }
  }
  return { info, parts: [] } as any
}

function user(): MessageV2.WithParts {
  return {
    info: { id: "u", role: "user", sessionID: "ses", time: { created: 0 } },
    parts: [],
  } as any
}

describe("latestRealPromptTokens", () => {
  test("sums input + cache.read + cache.write of newest completed assistant", () => {
    const msgs = [
      user(),
      assistant({ input: 5_000, cacheRead: 90_000, cacheWrite: 1_000 }),
      user(),
      assistant({ input: 8_000, cacheRead: 130_000, cacheWrite: 8_000 }),
    ]
    expect(latestRealPromptTokens(msgs)).toBe(146_000)
  })

  test("skips compaction-anchor rows (summary === true)", () => {
    const msgs = [
      assistant({ input: 1_000, cacheRead: 99_000 }), // real turn (100K)
      assistant({ summary: true, input: 999_999 }), // anchor — must be ignored
    ]
    expect(latestRealPromptTokens(msgs)).toBe(100_000)
  })

  test("skips rows with no tokens and zero-token rows, scanning older", () => {
    const msgs = [
      assistant({ input: 4_000, cacheRead: 40_000 }), // 44K
      assistant({ noTokens: true }),
      assistant({ input: 0, cacheRead: 0, cacheWrite: 0 }),
    ]
    expect(latestRealPromptTokens(msgs)).toBe(44_000)
  })

  test("returns 0 when no completed assistant turn exists", () => {
    expect(latestRealPromptTokens([user(), user()])).toBe(0)
    expect(latestRealPromptTokens([])).toBe(0)
  })
})

describe("gateAnchorTokensForClaude", () => {
  test("claude: floors the estimate up to (realPrompt - reserve)", () => {
    // estimate under-counts (81K) but real prompt 146K → 146K-40K=106K wins
    expect(
      gateAnchorTokensForClaude({
        providerId: "claude-cli",
        estimateTokens: 81_000,
        realPromptTokens: 146_000,
        systemReserveTokens: 40_000,
      }),
    ).toBe(106_000)
  })

  test("claude: keeps the estimate when it already exceeds the real-derived share", () => {
    expect(
      gateAnchorTokensForClaude({
        providerId: "claude-cli",
        estimateTokens: 120_000,
        realPromptTokens: 100_000,
        systemReserveTokens: 40_000,
      }),
    ).toBe(120_000)
  })

  test("claude: real-token floor of 0 (fresh session) falls back to estimate", () => {
    expect(
      gateAnchorTokensForClaude({
        providerId: "claude-cli",
        estimateTokens: 12_000,
        realPromptTokens: 0,
        systemReserveTokens: 40_000,
      }),
    ).toBe(12_000) // max(12_000, -40_000) === 12_000
  })

  test("non-claude (codex): returns the estimate unchanged regardless of real prompt (INV-0)", () => {
    for (const providerId of ["codex", "openai", undefined]) {
      expect(
        gateAnchorTokensForClaude({
          providerId,
          estimateTokens: 81_000,
          realPromptTokens: 900_000,
          systemReserveTokens: 40_000,
        }),
      ).toBe(81_000)
    }
  })
})

describe("gate integration (Rule 2): claude enrich is total-gated; codex unchanged", () => {
  const aFloorTokens = 100_000 // claude-cli aCompactTokens
  const contextLimit = 1_000_000

  test("claude: total below 225K → no enrich (anchor size irrelevant under Rule 2)", () => {
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: 81_000,
        contextLimit,
        aFloorTokens,
        realPromptTokens: 200_000,
      }),
    ).toBe(false)
  })

  test("claude: total above 225K → enrich, regardless of the anchor/gate-lift (Rule 2)", () => {
    // gateAnchorTokens still computes the CJK/real-token lift (kept for the skip-log
    // / codex), but it no longer drives claude's enrich — the whole prompt does.
    const gated = gateAnchorTokensForClaude({
      providerId: "claude-cli",
      estimateTokens: 81_000,
      realPromptTokens: 146_000,
      systemReserveTokens: 40_000,
    })
    expect(gated).toBe(106_000) // lift still computed
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: gated,
        contextLimit,
        aFloorTokens,
        realPromptTokens: 230_000,
      }),
    ).toBe(true)
  })

  test("codex with the identical numbers stays on the ratio gate (no behavior change)", () => {
    const gated = gateAnchorTokensForClaude({
      providerId: "codex",
      estimateTokens: 81_000,
      realPromptTokens: 146_000,
      systemReserveTokens: 40_000,
    })
    expect(gated).toBe(81_000) // INV-0: estimate untouched
    // 81K / 1M = 0.081 < 0.4 ratio gate → still does not fire (byte-identical to before)
    expect(
      shouldEnrichAnchor({ providerId: "codex", anchorTokens: gated, contextLimit, aFloorTokens, realPromptTokens: 999_999 }),
    ).toBe(false)
  })
})
