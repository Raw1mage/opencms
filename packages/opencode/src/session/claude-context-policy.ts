/**
 * claude-context-policy — provider-gated context-assembly policy for the
 * claude path (context/claude-refactor). Extracted (like stream-watchdog.ts)
 * so the gates are pure + unit-testable, and so the claude-vs-rest split lives
 * in ONE auditable place (DD-1 chokepoint seed). This is the firefight surface;
 * the full ContextProjector strategy formalizes around it later.
 *
 * INV-0: every helper returns the codex/other-provider answer = "no change".
 * Only `claude-cli` diverges. Non-claude turns exercise zero new behavior.
 */

import type { MessageV2 } from "./message-v2"
import { reframeAnchorBodyForClaude } from "./anchor-sanitizer"

/** Providers that get the claude (stateless / 1M / full-retransmit) context path. */
export const CLAUDE_CONTEXT_PROVIDERS: ReadonlySet<string> = new Set(["claude-cli"])

export function isClaudeContextProvider(providerId: string | undefined): boolean {
  return providerId != null && CLAUDE_CONTEXT_PROVIDERS.has(providerId)
}

/**
 * Observed conditions that are codex server-chain-rebind artifacts (DD-4).
 * Stateless claude has no chain to rebind, so these must NOT trigger
 * compaction on the claude path. Genuine token-pressure (`overflow`,
 * `idle`) and user `manual` are NOT here — those still apply to claude.
 */
export const CLAUDE_NOOP_OBSERVED: ReadonlySet<string> = new Set([
  "provider-switched",
  "rebind",
  "continuation-invalidated",
])

/**
 * True when a compaction trigger should be a no-op for claude: the active
 * provider is claude AND the observed condition is a codex-ism (chain rebind),
 * not real token pressure. codex/other providers always get `false` (INV-0).
 */
export function shouldSkipClaudeEventCompaction(
  providerId: string | undefined,
  observed: string,
): boolean {
  return isClaudeContextProvider(providerId) && CLAUDE_NOOP_OBSERVED.has(observed)
}

// B-compaction size gate moved to per-provider tweak config
// (context/claude-refactor DD-23): `Tweaks.contextThresholdsSync(providerId).bCompactTokens`
// — absolute tokens, tunable, claude-cli default 100K. See config/tweaks.ts
// ContextThresholdProfile. The gate gates on observable context SIZE (never on
// cache_read/chain), so it stays structurally cascade-immune.

/**
 * Anthropic ephemeral prompt-cache TTL (ms). After this much idle the cache is
 * GONE, so the next request is a guaranteed cold full-prefill regardless of what
 * the previous turn's recorded cache split was. context/claude-refactor DD-16
 * (session_resume): on resume/rebind after a long gap, the cold-compaction gate
 * must fire on the IDLE-GAP signal — "we are resuming now, cache is dead" — not
 * only on the previous turn's stale cache_read fraction. Otherwise a session
 * whose last turn happened to be warm would full-prefill its whole array on the
 * first cold resume, unbounded. Aligned to the claude provider's prompt-cache
 * TTL (provider-claude CLAUDE_CACHE_TTL): now 1h, so a resume within 1h is still
 * cache-warm and must NOT be treated as a cold gap. (Was 5 min = Anthropic's
 * default ephemeral; raised with the move to extended-cache-ttl 1h.)
 */
export const CLAUDE_CACHE_TTL_MS = 60 * 60 * 1000

/**
 * READ-TIME anchor projection for the claude path (context/claude-refactor
 * DD-21). Anchors are stored NEUTRAL (base `<prior_context source="kind">`
 * wrapper, no supersede framing); ANY provider's anchor — incl. inherited
 * codex-era and pre-DD-21 legacy ones — reads the same core. On the stateless
 * claude path the anchor is re-sent every turn against a newer verbatim tail,
 * so each anchor message's body is re-framed with the supersede frame at
 * projection (read) time. Pure: returns a shallow-cloned msg list with anchor
 * text bodies re-framed; non-anchor messages pass through by reference.
 * codex/other providers never call this → they see the neutral stored body
 * (INV-0). Replaces the old framed/unframed `filterCompacted` discriminator,
 * which broke every legacy session (all legacy anchors are unframed).
 */
export function projectClaudeAnchors(msgs: MessageV2.WithParts[]): MessageV2.WithParts[] {
  return msgs.map((msg) => {
    const isAnchor = msg.parts.some((p: any) => p.type === "compaction")
    if (!isAnchor) return msg
    const parts = msg.parts.map((p: any) =>
      p.type === "text" && typeof p.text === "string"
        ? { ...p, text: reframeAnchorBodyForClaude(p.text) }
        : p,
    )
    return { ...msg, parts }
  })
}
