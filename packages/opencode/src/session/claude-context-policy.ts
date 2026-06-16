/**
 * claude-context-policy — DELEGATING SHIM (context/provider-policy-dispatch, Move B).
 *
 * The claude-vs-rest branch moved to `context-policy.ts` (`resolvePolicy`). These
 * exports are preserved byte-identically (INV-0) so existing call sites keep
 * working unchanged; call sites migrate to `resolvePolicy()` directly in P1-3,
 * after which this shim is deleted.
 */

import type { MessageV2 } from "./message-v2"
import {
  resolvePolicy,
  CLAUDE_CONTEXT_PROVIDERS,
  CLAUDE_NOOP_OBSERVED,
  CLAUDE_CACHE_TTL_MS,
  latestRealPromptTokens,
} from "./context-policy"

export { CLAUDE_CONTEXT_PROVIDERS, CLAUDE_NOOP_OBSERVED, CLAUDE_CACHE_TTL_MS, latestRealPromptTokens }

export function isClaudeContextProvider(providerId: string | undefined): boolean {
  return resolvePolicy(providerId).kind === "claude"
}

export function shouldSkipClaudeEventCompaction(providerId: string | undefined, observed: string): boolean {
  return resolvePolicy(providerId).skipEventCompaction(observed)
}

export function shouldEnrichAnchor(input: {
  providerId: string | undefined
  anchorTokens: number
  contextLimit: number
  aFloorTokens: number
}): boolean {
  return resolvePolicy(input.providerId).shouldEnrichAnchor(input)
}

export function gateAnchorTokensForClaude(input: {
  providerId: string | undefined
  estimateTokens: number
  realPromptTokens: number
  systemReserveTokens: number
}): number {
  return resolvePolicy(input.providerId).gateAnchorTokens(input)
}

/**
 * Read-time anchor projection. Historically only ever called on the claude path
 * (caller guards with isClaudeContextProvider), and the function always reframed
 * regardless — so delegate unconditionally to the claude policy's projection to
 * preserve that exact behavior.
 */
export function projectClaudeAnchors(msgs: MessageV2.WithParts[]): MessageV2.WithParts[] {
  return resolvePolicy("claude-cli").projectAnchors(msgs)
}
