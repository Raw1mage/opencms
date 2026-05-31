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

/**
 * Size gate (tokens) for the claude cold-cache compaction trigger
 * (DD-13/14/16/18). A claude turn compacts only when it is BOTH cold (less than
 * half the prompt was served cheaply from cache) AND larger than this gate — so
 * the next turns send a bounded supersede-framed anchor+tail instead of the full
 * 1M array on every cold (>5min TTL) resend. Below the gate, raw full-retransmit
 * is cheaper than carrying an anchor.
 *
 * The gate is a NEGATIVE-feedback trigger: a compaction shrinks the message
 * array below the gate, so the compaction-induced cold turn does NOT re-trigger
 * → structurally cascade-immune. Contrast the codex `cache_read`-drop heuristic,
 * whose old "cliff → compaction" response was positive feedback (compaction →
 * new prefix → cache drops → re-trigger) and produced the 2026-05-19 cascade;
 * codex's cliff path is now chain-reset-only, and claude never adopts that
 * heuristic — it gates on observable context SIZE, never on cache_read/chain.
 * Illustrative / tunable.
 */
export const CLAUDE_COLD_COMPACTION_GATE = 100_000

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
