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

describe("claude-context-policy: A-tier enrichment gate (DD-23 P4-2, enrichment-ai-first DD-8)", () => {
  const claudeFloor = 128_000 // claude-cli aCompactTokens (DD-8: unified 128K floor)

  it("claude: anchor at/above absolute floor => enrich, regardless of 1M ratio", () => {
    // ses_188bb5576 #6 reality: a fat anchor in a 1M window has a tiny ratio.
    // Legacy 0.4 ratio gate skipped it; absolute floor must RUN it.
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: 160_000,
        contextLimit: 1_000_000,
        aFloorTokens: claudeFloor,
      }),
    ).toBe(true)
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: 128_000,
        contextLimit: 1_000_000,
        aFloorTokens: claudeFloor,
      }),
    ).toBe(true)
  })

  it("claude: anchor below absolute floor => skip (don't recompress a thin anchor)", () => {
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: 127_999,
        contextLimit: 1_000_000,
        aFloorTokens: claudeFloor,
      }),
    ).toBe(false)
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: 30_000,
        contextLimit: 1_000_000,
        aFloorTokens: claudeFloor,
      }),
    ).toBe(false)
  })

  it("non-claude uses the SAME absolute floor (DD-3/DD-8: ratio gate retired, no ratio path exists)", () => {
    // codex 272K window: anchor below 128K floor => skip, regardless of any ratio.
    expect(
      shouldEnrichAnchor({ providerId: "codex", anchorTokens: 127_999, contextLimit: 272_000, aFloorTokens: 128_000 }),
    ).toBe(false)
    // codex: anchor at floor => enrich. Old 0.4 ratio gate would need 108.8K(0.4×272K);
    // the point is the trigger is the FLOOR, not any window proportion.
    expect(
      shouldEnrichAnchor({ providerId: "codex", anchorTokens: 128_000, contextLimit: 272_000, aFloorTokens: 128_000 }),
    ).toBe(true)
    // 1M-window general provider: 160K anchor (0.16 ratio — legacy 0.4 gate said skip)
    // now enriches because it crosses the absolute floor.
    expect(
      shouldEnrichAnchor({
        providerId: "copilot-cli",
        anchorTokens: 160_000,
        contextLimit: 1_000_000,
        aFloorTokens: 128_000,
      }),
    ).toBe(true)
    // Tiny anchor in any window: below floor => skip.
    expect(
      shouldEnrichAnchor({
        providerId: "copilot-cli",
        anchorTokens: 40_000,
        contextLimit: 272_000,
        aFloorTokens: 128_000,
      }),
    ).toBe(false)
  })
})

describe("A-tier drain gate fed by the shared estimator (anchor-unbounded-growth)", () => {
  const legacyDiv4 = (s: string) => Math.ceil(s.length / 4)

  it("THE FIX: a CJK anchor that chars/4 hid below the 100K floor crosses it via the shared CJK-aware estimator", () => {
    const cjkAnchor = "字".repeat(120_000) // realistic CJK-heavy anchor
    const floor = 100_000
    // OLD inlined chars/4 = 30K → drain gate FALSE → anchor never shrinks (the bug)
    expect(
      shouldEnrichAnchor({
        providerId: "claude-cli",
        anchorTokens: legacyDiv4(cjkAnchor),
        contextLimit: 1_000_000,
        aFloorTokens: floor,
      }),
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
