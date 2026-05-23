/**
 * Per-session encrypted compacted items store.
 *
 * prompt.ts Phase 2 writes items here after validating chain binding.
 * CodexLanguageModel.doStream reads + clears them (consume-once) and
 * prepends to the Responses API input[].
 *
 * Process-scoped Map — items do not survive daemon restart, which is
 * correct: encrypted blobs are session-transient (tied to server-side
 * state that may not survive restart either).
 */

import type { ResponseItem } from "./types.js"

const store = new Map<string, ResponseItem[]>()

/**
 * Store compacted items for a session. Called by prompt builder Phase 2
 * when anchor has valid serverCompactedItems + matching chain binding.
 * Overwrites any previous entry for the same session.
 */
export function setCompactedItemsPrefix(sessionID: string, items: unknown[]): void {
  store.set(sessionID, items as ResponseItem[])
}

/**
 * Consume compacted items for a session. Returns the items and clears
 * the entry. Consume-once: next doStream without a fresh set() gets [].
 */
export function consumeCompactedItemsPrefix(sessionID: string): ResponseItem[] {
  const items = store.get(sessionID)
  store.delete(sessionID)
  return items ?? []
}

/**
 * Check if a session has compacted items ready (without consuming).
 */
export function hasCompactedItemsPrefix(sessionID: string): boolean {
  return store.has(sessionID)
}
