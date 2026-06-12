/**
 * Pre-loop identity-change detection for session prompt.
 *
 * Compares the most recent assistant message's (providerId, accountId)
 * against the incoming request's identity to decide whether the codex
 * server-side previous_response_id chain needs to be cut.
 *
 * History:
 * - 2026-04-28 (commit 46c4ceb3e4): comparison moved from
 *   session.execution.* to lastAssistantIdentity.* because TUI's
 *   sanitizeModelIdentity could flip session.execution when only the
 *   picker rotated. The codex server cache key is bound to the ACTUAL
 *   account of the last LLM call, not the pinned account.
 * - 2026-05-26 (warroom session post-mortem): the inline accountChanged
 *   condition had `prevAccount !== nextAccount && !!(prevAccount || nextAccount)`
 *   which fired falsely when prevAccount was undefined (old assistant
 *   messages predating the accountId schema field, or imports). Phantom
 *   switch → Continuation.run({account_switch}) → chain reset, message
 *   count nuked from ~120 to ~4, cache loss, pidgin self-doubt spiral.
 *   Logic extracted to this module + both sides now required to be
 *   defined for a switch to be declared.
 */

export type IdentityChangeKind = "none" | "provider" | "account"

/**
 * Why the helper returned a given kind. Every code path has a distinct
 * reason so the call site can log unambiguously. Critical for catching
 * future phantom-switch regressions: the post-2026-05-26 fix made the
 * "absent accountId" path silent by design, so we tag it explicitly
 * here. If a future bug starts producing undefined accountId on every
 * reload, "skip-absent-prior-account" / "skip-absent-incoming-account"
 * will surface in the log channel and be greppable.
 */
export type IdentityChangeReason =
  | "fresh-session" // no prior assistant message
  | "no-prior-provider" // prior message had no providerId
  | "provider-changed" // provider id differs
  | "import-suppressed" // provider differs but prior is import anchor
  | "anchor-already-rebased" // provider differs from last finished turn, but the head compaction anchor already carries the incoming provider — we already switched
  | "same-account" // both providers and accounts match
  | "account-changed" // same provider, different account
  | "skip-absent-prior-account" // prior accountId undefined; cannot compare
  | "skip-absent-incoming-account" // incoming accountId undefined; cannot compare

export interface IdentityDecision {
  kind: IdentityChangeKind
  reason: IdentityChangeReason
}

export interface PriorIdentity {
  providerId?: string
  accountId?: string
  /**
   * If the prior assistant message was an import / claude-import takeover
   * anchor, its providerId is historical and does not represent a live
   * API chain. Provider-switch detection must skip it so the first
   * post-import prompt does not trigger a compaction.
   */
  isImport?: boolean
  /**
   * providerId of the MOST RECENT compaction anchor (`summary === true`)
   * when that anchor is the head of the assistant stream — i.e. no finished
   * real turn sits after it. A provider-switch compaction stamps its anchor
   * with the NEW provider but writes no `finish`, so the finish-gated scan
   * that produces `providerId` above keeps resolving to the pre-switch
   * finished turn. Without this signal the next prompt re-detects the same
   * switch and re-compacts forever (provider-switch compaction loop,
   * issue_20260612). When this equals the incoming provider we have already
   * rebased and must NOT re-declare a provider switch. Scoped to the provider
   * dimension only — account comparison still uses the finished-turn identity
   * (2026-04-28 / 2026-05-26 codex cache-key RCA must not regress).
   */
  anchorProviderId?: string
}

export interface IncomingIdentity {
  providerId: string
  accountId?: string
}

/**
 * Decide whether the incoming request's identity differs from the prior
 * assistant message's identity in a way that requires server-side chain
 * invalidation.
 *
 * Returns a tagged decision. The call site is expected to log every
 * decision (regardless of kind) so phantom-switch regressions and silent
 * skip paths are both observable.
 */
export function detectIdentityChange(prior: PriorIdentity | undefined, incoming: IncomingIdentity): IdentityDecision {
  // No prior assistant → fresh session, nothing to invalidate.
  if (!prior) return { kind: "none", reason: "fresh-session" }
  if (!prior.providerId) return { kind: "none", reason: "no-prior-provider" }

  if (prior.providerId !== incoming.providerId) {
    if (prior.isImport) return { kind: "none", reason: "import-suppressed" }
    // The head compaction anchor already carries the incoming provider: a
    // prior provider-switch already wrote a (finish-less) anchor for this
    // exact provider, so the cut-over happened. Re-declaring the switch here
    // would re-compact and silently exit on every subsequent prompt, never
    // letting the new provider run (issue_20260612). Provider dimension only.
    if (prior.anchorProviderId === incoming.providerId)
      return { kind: "none", reason: "anchor-already-rebased" }
    return { kind: "provider", reason: "provider-changed" }
  }

  // Same provider. Now check account. Both sides must be defined to
  // declare a switch — absence-of-info is treated as same to avoid
  // phantom resets (2026-05-26 warroom RCA).
  if (!prior.accountId) return { kind: "none", reason: "skip-absent-prior-account" }
  if (!incoming.accountId) return { kind: "none", reason: "skip-absent-incoming-account" }
  if (prior.accountId === incoming.accountId) return { kind: "none", reason: "same-account" }
  return { kind: "account", reason: "account-changed" }
}
