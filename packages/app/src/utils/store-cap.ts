// mobile-tail-first-simplification Phase 10: global LRU rotation.
// The client store holds messages across potentially many sessions. Instead
// of per-session caps + session-unmount clearing, we enforce a SINGLE global
// cap: sum of message counts across all sessions <= cap. Oldest message
// across the whole store is evicted first, regardless of which session it
// belongs to.
//
// This means flipping between sessions never loses state just because you
// switched; you only lose the oldest messages once total exceeds cap.

import type { Message } from "@opencode-ai/sdk/v2/client"
import { frontendTweaks } from "@/context/frontend-tweaks"

export function isMobile(): boolean {
  if (typeof window === "undefined") return true
  const w = window.innerWidth || document.documentElement?.clientWidth || 0
  if (w > 0) return w < 768
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua)
}

export function platformStoreCap(): number {
  const cfg = frontendTweaks()
  return isMobile() ? cfg.session_store_cap_mobile : cfg.session_store_cap_desktop
}

export type MessagesBySession = Readonly<{ [sessionID: string]: Message[] }>

export type EvictDecision = {
  sessionID: string
  messageID: string
}

/**
 * Compute which messages to evict globally. Returns a list of
 * `{sessionID, messageID}` pairs the reducer should remove — alongside
 * `delete store.part[messageID]` for each.
 *
 * Contract:
 * - Total message count across ALL sessions is bounded to `cap`.
 * - Oldest message IDs evict first (lex compare — message ids encode
 *   creation time as a prefix, so lex order = chronological order).
 * - Messages in `liveStreamingIds` are NEVER evicted; if cap is breached
 *   but all overage are live, we return fewer than `overage` evictions
 *   and the store temporarily exceeds cap (acceptable per spec).
 */
export function computeGlobalEvictions(
  messagesBySession: MessagesBySession,
  cap: number,
  liveStreamingIds: ReadonlySet<string>,
): EvictDecision[] {
  // Gather all (sessionID, messageID) pairs, keyed by id for global sort.
  const all: { sessionID: string; id: string }[] = []
  for (const sessionID of Object.keys(messagesBySession)) {
    const list = messagesBySession[sessionID]
    if (!list) continue
    for (const msg of list) {
      if (msg?.id) all.push({ sessionID, id: msg.id })
    }
  }
  if (all.length <= cap) return []

  const overage = all.length - cap
  // id prefix encodes creation time; lexicographic sort = oldest first.
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const decisions: EvictDecision[] = []
  for (let i = 0; i < all.length && decisions.length < overage; i++) {
    const candidate = all[i]
    if (!candidate) continue
    if (liveStreamingIds.has(candidate.id)) continue
    decisions.push({ sessionID: candidate.sessionID, messageID: candidate.id })
  }
  return decisions
}

/**
 * Track which messages are currently streaming. An assistant message with
 * no `time.completed` is in-flight; once completed it becomes LRU-eligible.
 */
export function isMessageLive(msg: Message | undefined): boolean {
  if (!msg) return false
  if (msg.role !== "assistant") return false
  const completed = msg.time?.completed
  return completed === undefined || completed === null
}
