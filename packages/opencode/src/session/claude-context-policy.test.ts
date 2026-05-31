import { describe, expect, it } from "bun:test"
import {
  isClaudeContextProvider,
  shouldSkipClaudeEventCompaction,
  CLAUDE_NOOP_OBSERVED,
} from "./claude-context-policy"

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
