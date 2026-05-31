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
