/**
 * context-policy — single per-provider context-management strategy.
 *
 * context/provider-policy-dispatch (Move B): the claude-vs-rest branch that was
 * inlined inside every helper (`if (isClaudeContextProvider) … else …`) is
 * resolved ONCE here via `resolvePolicy(providerId)`. Each policy object holds
 * its own arm of the former if/else, so call sites carry no provider
 * conditional. Byte-identical to the pre-split `claude-context-policy` helpers
 * (INV-0): claude → ClaudePolicy arm, everything else → GeneralPolicy arm.
 *
 * The shared token estimator (ToolBudget.estimateTokens) is NEVER forked here —
 * it is passed in by callers (DD-3); these policies only decide, they do not count.
 */

import type { MessageV2 } from "./message-v2"
import { reframeAnchorBodyForClaude } from "./anchor-sanitizer"
import { Tweaks } from "../config/tweaks"

/** Providers that get the claude (stateless / 1M / full-retransmit) context path. */
export const CLAUDE_CONTEXT_PROVIDERS: ReadonlySet<string> = new Set(["claude-cli"])

/**
 * Observed conditions that are codex server-chain-rebind artifacts (DD-4):
 * stateless claude has no chain to rebind, so these must be a no-op on the
 * claude path. Genuine token pressure (`overflow`, `idle`) and `manual` are NOT
 * here — those still apply to claude.
 */
export const CLAUDE_NOOP_OBSERVED: ReadonlySet<string> = new Set([
  "provider-switched",
  "rebind",
  "continuation-invalidated",
])

/**
 * Anthropic ephemeral prompt-cache TTL (ms). After this much idle the cache is
 * gone → the next request is a guaranteed cold full-prefill. 1h (extended-cache-ttl).
 */
export const CLAUDE_CACHE_TTL_MS = 60 * 60 * 1000

/**
 * a-tier-gate-floor DD-1/DD-2: bounded undercount compensation cap for the
 * A-tier enrichment gate. The chars estimator undercounts mixed markdown/code
 * anchors by ~1.3x (recency-fadeout-tiers DD-9); the real-prompt signal may
 * lift the estimate by at most this ratio. Without the cap, `real - reserve`
 * (an UNBOUNDED whole-prompt size) structurally wins max() at cache-aware
 * high-watermark and short-circuits the gate to always-true — anchor size
 * stops participating entirely. Physical estimation-error constant, not an
 * ops tunable (deliberately NOT in tweaks).
 */
export const UNDERCOUNT_CAP_RATIO = 1.5

// compaction-rules (claude-only, size-based, UNCONDITIONAL of cache temperature).
// Rule 1: C→B narrative fires when the raw un-anchored tail C exceeds
// CLAUDE_C_NARRATIVE_TOKENS. Rule 2: B→A ai_paid fires when the whole prompt
// exceeds CLAUDE_TOTAL_AIPAID_TOKENS (ClaudePolicy.shouldEnrichAnchor). Replaces
// the cold-cache B-gate + the 128K anchor A-floor for claude only — a
// rotation/rebind-induced FAKE cold does not change context SIZE, so size gates
// are immune to that cascade (issues/bug_20260616_cold_bgate...). codex/general
// keep their existing gates (INV-0).
export const CLAUDE_C_NARRATIVE_TOKENS = 150_000
export const CLAUDE_TOTAL_AIPAID_TOKENS = 225_000
// System+preface reserve subtracted from the real promptTotal to isolate C.
// Mirrors compaction.ts REAL_SYSTEM_RESERVE; the live finalSystemTokens is not
// available at compaction-decision time (computed later, in prompt assembly).
export const CLAUDE_SYSTEM_RESERVE_TOKENS = 40_000

/**
 * Most recent COMPLETED assistant turn's total prompt tokens (input + cache.read
 * + cache.write), newest→oldest, skipping compaction-anchor rows (summary===true)
 * and rows without recorded tokens. REAL provider-reported size, not an estimate.
 * Pure + provider-agnostic (callers decide whether to use it).
 */
export function latestRealPromptTokens(msgs: MessageV2.WithParts[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i]?.info
    if (!info || info.role !== "assistant") continue
    if ((info as MessageV2.Assistant).summary === true) continue
    const tk = (info as MessageV2.Assistant).tokens
    if (!tk) continue
    const total = (tk.input ?? 0) + (tk.cache?.read ?? 0) + (tk.cache?.write ?? 0)
    if (total > 0) return total
  }
  return 0
}

export interface ContextPolicy {
  readonly kind: "claude" | "general"

  /**
   * B-tier cold-cache compaction SIZE trigger (the claude DD-23 absolute-token
   * gate). claude: true when promptTotal exceeds the per-provider bCompactTokens
   * floor (the caller still applies the cold-cache / idle-resume sub-conditions).
   * general: always false — only the claude path runs the cold-resend B gate
   * (INV-0: prompt.ts:595 was `isClaudeContextProvider && promptTotal > bCompactTokens`).
   */
  coldCacheBGate(input: { promptTotal: number; bCompactTokens: number }): boolean

  /** Transport item-count overflow trigger, using provider-specific tweak thresholds. */
  itemOverflowTrigger(itemCount: number): boolean

  /** Provider-specific transport item-count overflow threshold. */
  itemOverflowThreshold(): number

  /**
   * A-tier (background ai_paid) enrichment gate — should B→A fire?
   * - general (INV-0): absolute aFloorTokens on the anchor size (anchorTokens ≥
   *   aFloorTokens; the legacy ratio gate is retired).
   * - claude (compaction-rules Rule 2): UNCONDITIONAL on the WHOLE prompt size
   *   (realPromptTokens > CLAUDE_TOTAL_AIPAID_TOKENS), independent of the
   *   anchor's own size, so a bloated total deep-compresses even when the
   *   narrative anchor alone is below the old 128K floor.
   */
  shouldEnrichAnchor(input: {
    anchorTokens: number
    contextLimit: number
    aFloorTokens: number
    realPromptTokens: number
  }): boolean

  /**
   * Gate-input floor for shouldEnrichAnchor. claude floors the chars-estimate on
   * the REAL reported prompt tokens (DD-9, fights the ~1.3x markdown/code
   * undercount). general: estimate passthrough (INV-0).
   */
  gateAnchorTokens(input: { estimateTokens: number; realPromptTokens: number; systemReserveTokens: number }): number

  /**
   * READ-TIME anchor projection. claude re-frames each anchor body with the
   * supersede frame (DD-21, stateless re-send). general: passthrough by reference.
   */
  projectAnchors(msgs: MessageV2.WithParts[]): MessageV2.WithParts[]

  /**
   * Should a compaction trigger be a no-op? claude: true for codex-ism rebind
   * artifacts (CLAUDE_NOOP_OBSERVED). general: always false (INV-0).
   */
  skipEventCompaction(observed: string): boolean
}

class GeneralPolicy implements ContextPolicy {
  readonly kind = "general" as const

  coldCacheBGate(_input: { promptTotal: number; bCompactTokens: number }): boolean {
    return false
  }

  itemOverflowTrigger(itemCount: number): boolean {
    return itemCount > this.itemOverflowThreshold()
  }

  itemOverflowThreshold(): number {
    return Tweaks.compactionSync().codexItemOverflowThreshold
  }

  shouldEnrichAnchor(input: {
    anchorTokens: number
    contextLimit: number
    aFloorTokens: number
    realPromptTokens: number
  }): boolean {
    // INV-0: general/codex keep the absolute anchor floor (realPromptTokens is
    // accepted but ignored here — only claude uses the whole-prompt gate).
    return input.anchorTokens >= input.aFloorTokens
  }

  gateAnchorTokens(input: { estimateTokens: number; realPromptTokens: number; systemReserveTokens: number }): number {
    return input.estimateTokens
  }

  projectAnchors(msgs: MessageV2.WithParts[]): MessageV2.WithParts[] {
    return msgs
  }

  skipEventCompaction(_observed: string): boolean {
    return false
  }
}

class ClaudePolicy implements ContextPolicy {
  readonly kind = "claude" as const

  coldCacheBGate(input: { promptTotal: number; bCompactTokens: number }): boolean {
    return input.promptTotal > input.bCompactTokens
  }

  itemOverflowTrigger(itemCount: number): boolean {
    return itemCount > this.itemOverflowThreshold()
  }

  itemOverflowThreshold(): number {
    return Tweaks.compactionSync().claudeItemOverflowThreshold
  }

  shouldEnrichAnchor(input: {
    anchorTokens: number
    contextLimit: number
    aFloorTokens: number
    realPromptTokens: number
  }): boolean {
    // compaction-rules Rule 2 (claude-only): B→A ai_paid fires UNCONDITIONALLY
    // when the WHOLE prompt exceeds CLAUDE_TOTAL_AIPAID_TOKENS, regardless of the
    // anchor's own size. Replaces the 128K anchor floor — that floor created a
    // dead zone where a ~60K narrative anchor caused dense compaction (total
    // pinned ~207K) yet was too small to ever trigger B→A, so the total never
    // shrank (issues/bug_20260616_cold_bgate...). Gating on the total fixes that.
    return input.realPromptTokens > CLAUDE_TOTAL_AIPAID_TOKENS
  }

  gateAnchorTokens(input: { estimateTokens: number; realPromptTokens: number; systemReserveTokens: number }): number {
    // a-tier-gate-floor DD-1: bounded undercount compensation. The real-prompt
    // floor (recency-fadeout-tiers DD-9) compensates the chars estimator's
    // ~1.3x undercount, but realPromptTokens measures the WHOLE prompt (system
    // + tail + anchor), not the anchor — unbounded relative to anchor size. At
    // cache-aware high-watermark `real - reserve` always exceeded aFloorTokens,
    // so max() alone made the gate structurally true. Cap the lift at 1.5x the
    // estimate so the bounded estimation error is covered without letting
    // prompt size impersonate anchor size.
    return Math.min(
      Math.max(input.estimateTokens, input.realPromptTokens - input.systemReserveTokens),
      Math.ceil(input.estimateTokens * UNDERCOUNT_CAP_RATIO),
    )
  }

  projectAnchors(msgs: MessageV2.WithParts[]): MessageV2.WithParts[] {
    return msgs.map((msg) => {
      const isAnchor = msg.parts.some((p: any) => p.type === "compaction")
      if (!isAnchor) return msg
      const parts = msg.parts.map((p: any) =>
        p.type === "text" && typeof p.text === "string" ? { ...p, text: reframeAnchorBodyForClaude(p.text) } : p,
      )
      return { ...msg, parts }
    })
  }

  skipEventCompaction(observed: string): boolean {
    return CLAUDE_NOOP_OBSERVED.has(observed)
  }
}

const GENERAL_POLICY = new GeneralPolicy()
const CLAUDE_POLICY = new ClaudePolicy()

/** Resolve the context-management policy for a provider — the single dispatch point. */
export function resolvePolicy(providerId: string | undefined): ContextPolicy {
  return providerId != null && CLAUDE_CONTEXT_PROVIDERS.has(providerId) ? CLAUDE_POLICY : GENERAL_POLICY
}
