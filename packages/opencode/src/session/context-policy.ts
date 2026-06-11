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
   * A-tier (background ai_paid) enrichment gate — is a just-written narrative B
   * anchor big enough to be worth recompressing into the smaller A-tier?
   * Both policies: absolute aFloorTokens (compaction_enrichment-ai-first DD-3/DD-8:
   * the legacy general ratio gate (≤128K→25%, else 40%) is retired — per-provider
   * aCompactTokens is the single trigger, unified at 128K).
   */
  shouldEnrichAnchor(input: { anchorTokens: number; contextLimit: number; aFloorTokens: number }): boolean

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

  shouldEnrichAnchor(input: { anchorTokens: number; contextLimit: number; aFloorTokens: number }): boolean {
    // compaction_enrichment-ai-first DD-3: absolute floor, same shape as ClaudePolicy.
    // The legacy ratio gate (≤128K window → 25%, else 40%) is retired — it ignored
    // the per-provider aCompactTokens config entirely (dead config since inception).
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

  shouldEnrichAnchor(input: { anchorTokens: number; contextLimit: number; aFloorTokens: number }): boolean {
    return input.anchorTokens >= input.aFloorTokens
  }

  gateAnchorTokens(input: { estimateTokens: number; realPromptTokens: number; systemReserveTokens: number }): number {
    return Math.max(input.estimateTokens, input.realPromptTokens - input.systemReserveTokens)
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
