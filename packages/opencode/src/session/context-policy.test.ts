import { afterEach, describe, expect, it } from "bun:test"
import { resolvePolicy } from "./context-policy"
import { Tweaks } from "../config/tweaks"
// The shim still exposes the pre-split inline-branch helpers. These tests pin
// that the resolved policy object's methods are byte-identical to the old
// helpers across providers (context/provider-policy-dispatch Move B, P1-4).
import {
  isClaudeContextProvider,
  shouldSkipClaudeEventCompaction,
  shouldEnrichAnchor as shimShouldEnrichAnchor,
  gateAnchorTokensForClaude as shimGateAnchorTokens,
} from "./claude-context-policy"

const PROVIDERS = ["claude-cli", "codex", "copilot-cli", "local", "openai", undefined] as const

describe("resolvePolicy: single dispatch (Move B)", () => {
  it("claude-cli resolves to the claude policy", () => {
    expect(resolvePolicy("claude-cli").kind).toBe("claude")
  })
  it("codex / copilot / local / openai / undefined resolve to the general policy", () => {
    for (const p of ["codex", "copilot-cli", "local", "openai", undefined]) {
      expect(resolvePolicy(p as any).kind).toBe("general")
    }
  })
  it("policy.kind === 'claude' is equivalent to the old isClaudeContextProvider", () => {
    for (const p of PROVIDERS) {
      expect(resolvePolicy(p).kind === "claude").toBe(isClaudeContextProvider(p))
    }
  })
})

describe("coldCacheBGate: equivalence to old `isClaudeContextProvider && promptTotal > bCompactTokens` (prompt.ts:595)", () => {
  const bCompactTokens = 100_000
  const cases = [50_000, 99_999, 100_000, 100_001, 250_000]
  it("matches the old inline B-gate branch for every provider × promptTotal", () => {
    for (const p of PROVIDERS) {
      for (const promptTotal of cases) {
        const oldBranch = isClaudeContextProvider(p) && promptTotal > bCompactTokens
        expect(resolvePolicy(p).coldCacheBGate({ promptTotal, bCompactTokens })).toBe(oldBranch)
      }
    }
  })
  it("general policy never opens the cold-cache B gate (INV-0)", () => {
    expect(resolvePolicy("codex").coldCacheBGate({ promptTotal: 10_000_000, bCompactTokens: 1 })).toBe(false)
  })
})

describe("itemOverflowTrigger: provider-specific tweak thresholds", () => {
  const originalCompactionSync = Tweaks.compactionSync

  afterEach(() => {
    ;(Tweaks as any).compactionSync = originalCompactionSync
  })

  it("uses the codex/general threshold for non-claude providers", () => {
    ;(Tweaks as any).compactionSync = () => ({
      ...originalCompactionSync(),
      codexItemOverflowThreshold: 400,
      claudeItemOverflowThreshold: 10_000,
    })
    for (const p of ["codex", "copilot-cli", "local", "openai", undefined] as const) {
      expect(resolvePolicy(p).itemOverflowThreshold()).toBe(400)
      expect(resolvePolicy(p).itemOverflowTrigger(400)).toBe(false)
      expect(resolvePolicy(p).itemOverflowTrigger(401)).toBe(true)
    }
  })

  it("uses the claude threshold for claude-cli", () => {
    ;(Tweaks as any).compactionSync = () => ({
      ...originalCompactionSync(),
      codexItemOverflowThreshold: 400,
      claudeItemOverflowThreshold: 1200,
    })
    expect(resolvePolicy("claude-cli").itemOverflowThreshold()).toBe(1200)
    expect(resolvePolicy("claude-cli").itemOverflowTrigger(401)).toBe(false)
    expect(resolvePolicy("claude-cli").itemOverflowTrigger(1200)).toBe(false)
    expect(resolvePolicy("claude-cli").itemOverflowTrigger(1201)).toBe(true)
  })
})

describe("Move B method equivalence to the pre-split shim helpers", () => {
  it("shouldEnrichAnchor matches the shim across providers (A-tier gate@1810)", () => {
    const inputs = [
      { anchorTokens: 160_000, contextLimit: 1_000_000, aFloorTokens: 100_000 },
      { anchorTokens: 99_999, contextLimit: 1_000_000, aFloorTokens: 100_000 },
      { anchorTokens: 40_000, contextLimit: 128_000, aFloorTokens: 50_000 },
      { anchorTokens: 30_000, contextLimit: 128_000, aFloorTokens: 50_000 },
    ]
    for (const p of PROVIDERS) {
      for (const i of inputs) {
        expect(resolvePolicy(p).shouldEnrichAnchor(i)).toBe(shimShouldEnrichAnchor({ providerId: p, ...i }))
      }
    }
  })

  it("gateAnchorTokens matches the shim across providers (gate floor@1804)", () => {
    const inputs = [
      { estimateTokens: 81_000, realPromptTokens: 106_000, systemReserveTokens: 40_000 },
      { estimateTokens: 120_000, realPromptTokens: 50_000, systemReserveTokens: 40_000 },
    ]
    for (const p of PROVIDERS) {
      for (const i of inputs) {
        expect(resolvePolicy(p).gateAnchorTokens(i)).toBe(shimGateAnchorTokens({ providerId: p, ...i }))
      }
    }
  })

  it("skipEventCompaction matches the shim across providers (event no-op@2436)", () => {
    for (const p of PROVIDERS) {
      for (const o of ["provider-switched", "rebind", "continuation-invalidated", "overflow", "manual", "idle"]) {
        expect(resolvePolicy(p).skipEventCompaction(o)).toBe(shouldSkipClaudeEventCompaction(p, o))
      }
    }
  })

  it("projectAnchors reframes only on the claude path; general passes through by reference", () => {
    const anchorMsg = {
      info: { role: "assistant" },
      parts: [{ type: "compaction" }, { type: "text", text: "earlier work" }],
    } as any
    // general: identity passthrough (same array reference)
    const general = resolvePolicy("codex").projectAnchors([anchorMsg])
    expect(general[0]).toBe(anchorMsg)
    // claude: reframed (new object, text body changed)
    const claude = resolvePolicy("claude-cli").projectAnchors([anchorMsg])
    expect(claude[0]).not.toBe(anchorMsg)
    const claudeText = (claude[0].parts.find((p: any) => p.type === "text") as any).text
    expect(claudeText).not.toBe("earlier work")
  })
})
