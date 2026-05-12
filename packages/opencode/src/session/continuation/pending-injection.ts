/**
 * Pending fragment-injection marker store.
 *
 * In-memory once-after-chain-break marker. The procedure executor
 * writes a pending injection when a chain-affecting event resolves
 * with `injectsChainInit || injectsAmnesia`; the prompt builder
 * reads + clears it on next outbound build (Phase B-C-E call-site
 * rewires consume this).
 *
 * Phase A is additive: writes happen but no caller reads yet. This
 * lets us land + test the executor without rewiring the prompt
 * builder in the same PR.
 */

import type { CommitmentDigest } from "./commitment-digest"
import type { ContinuationEventKind } from "./continuation-event"

export interface PendingContinuationInjection {
  chainInit: boolean
  amnesia: boolean
  digest: CommitmentDigest | null
  reason: ContinuationEventKind
  anchorId?: string
  ts: number
}

const store = new Map<string, PendingContinuationInjection>()

export const PendingInjectionStore = {
  /** Mark a session for chain-init / amnesia injection on next outbound. */
  mark(sessionID: string, mark: PendingContinuationInjection): void {
    store.set(sessionID, mark)
  },

  /** Read without clearing. Returns `null` if no pending mark. */
  peek(sessionID: string): PendingContinuationInjection | null {
    return store.get(sessionID) ?? null
  },

  /** Read and clear. Used by the prompt builder on consumption. */
  consume(sessionID: string): PendingContinuationInjection | null {
    const mark = store.get(sessionID)
    if (mark) store.delete(sessionID)
    return mark ?? null
  },

  /** Explicit clear. Used by session.deleted and test cleanup. */
  clear(sessionID: string): void {
    store.delete(sessionID)
  },

  /** Test-only — wipe all markers. */
  reset(): void {
    store.clear()
  },

  /** Test-only — snapshot the registry size. */
  size(): number {
    return store.size
  },
}
