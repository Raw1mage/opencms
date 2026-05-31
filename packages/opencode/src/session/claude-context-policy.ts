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
 * Marker embedded in a claude-authored (supersede-framed) anchor body by
 * anchor-sanitizer.ts (`claudeSupersede`). `filterCompacted` uses it to tell a
 * claude-authored anchor — a real boundary it should USE as [anchor + tail] —
 * from an inherited codex-era anchor, which is unframed and which claude must
 * IGNORE, keeping the raw history instead (INV-1). Kept in lockstep with the
 * attribute emitted by `sanitizeAnchorToString`.
 */
export const CLAUDE_SUPERSEDE_MARKER = 'superseded_by_recent="true"'

/** True if an anchor body text was authored by the claude supersede path. */
export function isClaudeFramedAnchorText(text: string | undefined): boolean {
  return text != null && text.includes(CLAUDE_SUPERSEDE_MARKER)
}
