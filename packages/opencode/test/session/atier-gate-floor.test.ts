import { describe, expect, test } from "bun:test"
import { resolvePolicy, UNDERCOUNT_CAP_RATIO } from "../../src/session/context-policy"

// a-tier-gate-floor DD-1/DD-2 validation — test vectors TV-1..TV-6 from
// plans/compaction_a-tier-gate-floor/test-vectors.json.
// The real-prompt floor (recency-fadeout-tiers DD-9) must be bounded by the
// undercount cap so whole-prompt size cannot impersonate anchor size.

const claude = resolvePolicy("claude-cli")
const general = resolvePolicy("codex")
const reserve = 40_000
const aFloorTokens = 128_000
const contextLimit = 1_000_000

function gate(policy: ReturnType<typeof resolvePolicy>, estimateTokens: number, realPromptTokens: number) {
  return policy.gateAnchorTokens({ estimateTokens, realPromptTokens, systemReserveTokens: reserve })
}

function enrich(policy: ReturnType<typeof resolvePolicy>, anchorTokens: number) {
  return policy.shouldEnrichAnchor({ anchorTokens, contextLimit, aFloorTokens })
}

describe("a-tier-gate-floor: ClaudePolicy.gateAnchorTokens bounded compensation", () => {
  test("TV-1: small anchor + high real prompt → cap clips → below floor (incident reproduction)", () => {
    // 78K anchor at cache-aware high watermark (250K prompt). Pre-fix:
    // max(78K, 210K) = 210K → gate always true. Post-fix: capped at 117K < 128K.
    const result = gate(claude, 78_000, 250_000)
    expect(result).toBe(117_000)
    expect(result).toBe(Math.ceil(78_000 * UNDERCOUNT_CAP_RATIO))
    expect(enrich(claude, result)).toBe(false)
  })

  test("TV-2: genuinely fat anchor → passes gate", () => {
    // estimate 130K already over floor; real lift to 220K but min() picks 195K cap.
    const result = gate(claude, 130_000, 260_000)
    expect(result).toBe(195_000)
    expect(enrich(claude, result)).toBe(true)
  })

  test("TV-3: bounded compensation fires without touching cap (DD-9 intent preserved)", () => {
    // 110K markdown anchor undercounted; real 175K → 135K compensated, cap 165K not hit.
    const result = gate(claude, 110_000, 175_000)
    expect(result).toBe(135_000)
    expect(result).toBeLessThan(Math.ceil(110_000 * UNDERCOUNT_CAP_RATIO))
    expect(enrich(claude, result)).toBe(true)
  })

  test("TV-4: real below estimate → estimate wins (max branch preserved)", () => {
    const result = gate(claude, 90_000, 100_000)
    expect(result).toBe(90_000)
    expect(enrich(claude, result)).toBe(false)
  })

  test("TV-6: cap boundary — estimate 85.4K × 1.5 = 128.1K just clears floor", () => {
    const result = gate(claude, 85_400, 300_000)
    expect(result).toBe(128_100)
    expect(enrich(claude, result)).toBe(true)
  })
})

describe("a-tier-gate-floor: GeneralPolicy passthrough regression (INV-0)", () => {
  test("TV-5: general policy ignores real prompt signal entirely", () => {
    const result = gate(general, 78_000, 250_000)
    expect(result).toBe(78_000)
    expect(enrich(general, result)).toBe(false)
  })
})
