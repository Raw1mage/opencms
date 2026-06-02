import { describe, expect, it } from "bun:test"
import {
  isClaudeContextProvider,
  shouldSkipClaudeEventCompaction,
  shouldEnrichAnchor,
  CLAUDE_NOOP_OBSERVED,
} from "./claude-context-policy"
import { ToolBudget } from "../tool/budget"

describe("claude-context-policy: provider gate (INV-0)", () => {
  it("recognizes claude-cli as the claude context provider", () => {
    expect(isClaudeContextProvider("claude-cli")).toBe(true)
  })
  it("codex / copilot / local / undefined are NOT claude", () => {
    for (const p of ["codex", "copilot-cli", "local", "openai", "anthropic", undefined]) {
      expect(isClaudeContextProvider(p as any)).toBe(false)
    }
  })
})

describe("claude-context-policy: event-compaction no-op (DD-4)", () => {
  it("claude + chain-rebind observed => skip (no-op)", () => {
    for (const o of ["provider-switched", "rebind", "continuation-invalidated"]) {
      expect(shouldSkipClaudeEventCompaction("claude-cli", o)).toBe(true)
    }
  })

  it("claude + genuine token pressure / manual => still compacts (NOT skipped)", () => {
    for (const o of ["overflow", "idle", "manual", "cache-aware", "empty-response"]) {
      expect(shouldSkipClaudeEventCompaction("claude-cli", o)).toBe(false)
    }
  })

  it("codex + any observed => never skipped (INV-0 — codex path unchanged)", () => {
    for (const o of [...CLAUDE_NOOP_OBSERVED, "overflow", "manual"]) {
      expect(shouldSkipClaudeEventCompaction("codex", o)).toBe(false)
    }
  })

  it("copilot/local/undefined + chain-rebind observed => never skipped (INV-0)", () => {
    for (const p of ["copilot-cli", "local", undefined]) {
      expect(shouldSkipClaudeEventCompaction(p as any, "provider-switched")).toBe(false)
    }
  })
})

describe("claude-context-policy: A-tier enrichment gate (DD-23 P4-2)", () => {
  const claudeFloor = 100_000 // claude-cli aCompactTokens

  it("claude: anchor at/above absolute floor => enrich, regardless of 1M ratio", () => {
    // ses_188bb5576 #6 reality: 160K anchor in a 1M window = 0.16 ratio.
    // Legacy 0.4 ratio gate skipped it; absolute floor must RUN it.
    expect(
      shouldEnrichAnchor({ providerId: "claude-cli", anchorTokens: 160_000, contextLimit: 1_000_000, aFloorTokens: claudeFloor }),
    ).toBe(true)
    expect(
      shouldEnrichAnchor({ providerId: "claude-cli", anchorTokens: 100_000, contextLimit: 1_000_000, aFloorTokens: claudeFloor }),
    ).toBe(true)
  })

  it("claude: anchor below absolute floor => skip (don't recompress a thin anchor)", () => {
    expect(
      shouldEnrichAnchor({ providerId: "claude-cli", anchorTokens: 99_999, contextLimit: 1_000_000, aFloorTokens: claudeFloor }),
    ).toBe(false)
    expect(
      shouldEnrichAnchor({ providerId: "claude-cli", anchorTokens: 30_000, contextLimit: 1_000_000, aFloorTokens: claudeFloor }),
    ).toBe(false)
  })

  it("non-claude keeps the legacy context-ratio gate byte-identical (INV-0)", () => {
    // Large window (>128K) => 0.4 gate. codex aFloorTokens is IGNORED on this path.
    expect(
      shouldEnrichAnchor({ providerId: "codex", anchorTokens: 160_000, contextLimit: 1_000_000, aFloorTokens: 50_000 }),
    ).toBe(false) // 0.16 < 0.4 — unchanged from legacy
    expect(
      shouldEnrichAnchor({ providerId: "codex", anchorTokens: 410_000, contextLimit: 1_000_000, aFloorTokens: 50_000 }),
    ).toBe(true) // 0.41 >= 0.4
    // Small window (≤128K) => 0.25 gate.
    expect(
      shouldEnrichAnchor({ providerId: "copilot-cli", anchorTokens: 40_000, contextLimit: 128_000, aFloorTokens: 50_000 }),
    ).toBe(true) // 0.3125 >= 0.25
    expect(
      shouldEnrichAnchor({ providerId: "copilot-cli", anchorTokens: 30_000, contextLimit: 128_000, aFloorTokens: 50_000 }),
    ).toBe(false) // 0.234 < 0.25
  })
})

describe("A-tier drain gate fed by the shared estimator (anchor-unbounded-growth)", () => {
  const legacyDiv4 = (s: string) => Math.ceil(s.length / 4)

  it("THE FIX: a CJK anchor that chars/4 hid below the 100K floor crosses it via the shared CJK-aware estimator", () => {
    const cjkAnchor = "字".repeat(120_000) // realistic CJK-heavy anchor
    const floor = 100_000
    // OLD inlined chars/4 = 30K → drain gate FALSE → anchor never shrinks (the bug)
    expect(
      shouldEnrichAnchor({ providerId: "claude-cli", anchorTokens: legacyDiv4(cjkAnchor), contextLimit: 1_000_000, aFloorTokens: floor }),
    ).toBe(false)
    // shared ToolBudget.estimateTokens (now CJK-aware) ≈ 120K → gate TRUE → drain fires (the fix)
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: ToolBudget.estimateTokens(cjkAnchor),
        contextLimit: 1_000_000,
        aFloorTokens: floor,
      }),
    ).toBe(true)
  })

  it("ASCII anchor: shared estimator == old chars/4, so gate decision is unchanged (regression)", () => {
    const asciiAnchor = "x".repeat(120_000)
    expect(ToolBudget.estimateTokens(asciiAnchor)).toBe(legacyDiv4(asciiAnchor)) // byte-identical
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: ToolBudget.estimateTokens(asciiAnchor),
        contextLimit: 1_000_000,
        aFloorTokens: 100_000,
      }),
    ).toBe(false) // 30K < 100K, same as before
  })
})
