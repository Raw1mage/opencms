/**
 * Per-session dedup for recurring continuation dispatch.
 *
 * Background: prompt.ts:460 / prompt.ts:1208 detect chain-affecting
 * events by comparing the latest compaction anchor's
 * (providerId, accountId) against the session's current pinned
 * (providerId, accountId). The anchor only refreshes on compaction,
 * so between compactions the detection re-fires every prompt build
 * — pre-Phase B/C this was harmless because the side effect was
 * just invalidateContinuationFamily (idempotent no-op once chain
 * was already invalidated). Post-Phase B/C the side effect is
 * Continuation.run, which writes a fresh chain_init_notice into
 * PendingInjectionStore on every dispatch. Result: chain_init_notice
 * gets injected into the user bundle on every turn until a new
 * compaction anchor lands, wasting prompt tokens and potentially
 * confusing the AI.
 *
 * Live evidence (2026-05-12 20:55, ses_1e56ed3f9ffeb*): six
 * consecutive llm.prompt.telemetry events all showing
 * chain_init_notice in bundle_user fragmentIds, all dispatched with
 * the same (prev=raw → next=humanresource) account pair.
 *
 * Fix: dedup at the Continuation.run entry. Build a stable key from
 * the event kind + relevant identifier transition, remember it per
 * session for a short TTL, and short-circuit re-dispatch if the same
 * key recurs inside the TTL window.
 *
 * Only event kinds that can recur due to stale-anchor detection are
 * deduped:
 *   - account_switch       (anchor accountId vs current accountId)
 *   - account_rotate       (same, automatic)
 *   - provider_switch      (anchor providerId vs current providerId)
 *   - model_switch_*       (anchor modelID vs current modelID)
 *
 * One-shot kinds (empty_response_recovery, compaction_*,
 * backend_failure_forced_resend, session_resume_after_daemon_restart,
 * user_clear, subagent_spawn, ws_reconnect, …) bypass dedup — each
 * trigger is a real event in its own right, not stale-anchor noise.
 */

import type { ContinuationEvent } from "./continuation-event"

interface DedupEntry {
  key: string
  ts: number
}

const store = new Map<string, DedupEntry>()

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes — covers a single
                                     // conversation burst of duplicate
                                     // detections; resets cleanly across
                                     // longer idle gaps where a genuine
                                     // re-switch becomes plausible.

/**
 * Derive a dedup key for an event, or `null` if the event kind is
 * one-shot (no dedup applied).
 */
export function dedupKeyFor(event: ContinuationEvent): string | null {
  switch (event.kind) {
    case "account_switch":
    case "account_rotate":
      return `${event.kind}:${event.previousAccountId}→${event.accountId}`
    case "provider_switch":
      return `${event.kind}:${event.previousProviderId}→${event.providerId}`
    case "model_switch_same_family":
    case "model_switch_cross_family":
      return `${event.kind}:${event.previousModelId}→${event.modelId}`
    default:
      return null
  }
}

export const DispatchDedup = {
  /**
   * Returns true when Continuation.run SHOULD proceed. False when the
   * same key was already dispatched for this session within the TTL.
   */
  shouldDispatch(sessionID: string, key: string | null, now: number = Date.now(), ttlMs: number = DEFAULT_TTL_MS): boolean {
    if (key === null) return true
    const entry = store.get(sessionID)
    if (!entry) return true
    if (entry.key !== key) return true
    if (now - entry.ts >= ttlMs) return true
    return false
  },

  /**
   * Record a successful dispatch. Called after Continuation.run has
   * proceeded; subsequent shouldDispatch calls with the same key
   * within TTL will return false.
   */
  record(sessionID: string, key: string | null, now: number = Date.now()): void {
    if (key === null) return
    store.set(sessionID, { key, ts: now })
  },

  /**
   * Explicit reset for a session. Used by session.deleted bus and by
   * tests.
   */
  clear(sessionID: string): void {
    store.delete(sessionID)
  },

  /** Test seam — wipe entire store. */
  reset(): void {
    store.clear()
  },

  /** Test seam — peek raw entry for assertions. */
  peek(sessionID: string): DedupEntry | undefined {
    return store.get(sessionID)
  },

  /** Test seam — count active entries. */
  size(): number {
    return store.size
  },
}
