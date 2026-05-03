// Cache miss diagnostic (DD-10 of specs/prompt-cache-and-compaction-hardening).
//
// Track the last N sha256 hashes of the assembled system block per session.
// `shouldCacheAwareCompact` consults the diagnostic before triggering: if the
// hashes vary, the cache miss is likely "system-prefix-churn" (AGENTS.md /
// SYSTEM.md / model / account changed mid-session) and compacting the
// conversation will not help — return false. If hashes are stable AND the
// conversation tail is large, real "conversation-growth" → return true.
//
// In-memory only; no schema change. Cleared on session.deleted via Bus.

import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Identifier } from "../id/id"
import z from "zod"
import { createHash } from "crypto"

const WINDOW_SIZE = 3
const hashes = new Map<string, string[]>()

const SessionDeletedEvent = BusEvent.define(
  "session.deleted",
  z.object({
    info: z.object({
      id: Identifier.schema("session"),
    }),
  }),
)

let _subscribed = false
function ensureSubscribed() {
  if (_subscribed) return
  _subscribed = true
  Bus.subscribe(SessionDeletedEvent, (evt) => {
    hashes.delete(evt.properties.info.id)
  })
}

export type CacheMissDiagnosisKind = "system-prefix-churn" | "conversation-growth" | "neither"

export interface CacheMissDiagnosis {
  kind: CacheMissDiagnosisKind
  shouldCompact: boolean
  lastSystemHashes: string[]
  conversationTailTokens: number
}

/**
 * Push the latest system block hash. Call this right after llm.ts finishes
 * assembling system[0] and before the request goes out. Trimmed FIFO at
 * WINDOW_SIZE.
 */
export function recordSystemBlockHash(sessionID: string, systemBlockText: string): string {
  ensureSubscribed()
  const hash = createHash("sha256").update(systemBlockText).digest("hex")
  const arr = hashes.get(sessionID) ?? []
  arr.push(hash)
  while (arr.length > WINDOW_SIZE) arr.shift()
  hashes.set(sessionID, arr)
  return hash
}

/** Read the rolling window without mutating it. */
export function readSystemBlockHashes(sessionID: string): string[] {
  return hashes.get(sessionID)?.slice() ?? []
}

/**
 * Classify a cache-aware compaction predicate's likely root cause.
 *
 * Rules (per DD-10):
 * - Fewer than 2 hashes recorded → kind="neither", shouldCompact=false
 *   (insufficient evidence to commit).
 * - Hashes vary (any pair differs) → kind="system-prefix-churn", shouldCompact=false.
 * - Hashes all equal AND conversationTailTokens > minTailTokens (default 40K) →
 *   kind="conversation-growth", shouldCompact=true.
 * - Hashes all equal AND tail below threshold → kind="neither", shouldCompact=false.
 */
export function diagnoseCacheMiss(input: {
  sessionID: string
  conversationTailTokens: number
  minTailTokens?: number
}): CacheMissDiagnosis {
  const lastSystemHashes = readSystemBlockHashes(input.sessionID)
  const minTail = input.minTailTokens ?? 40000
  if (lastSystemHashes.length < 2) {
    return {
      kind: "neither",
      shouldCompact: false,
      lastSystemHashes,
      conversationTailTokens: input.conversationTailTokens,
    }
  }
  const allEqual = lastSystemHashes.every((h) => h === lastSystemHashes[0])
  if (!allEqual) {
    return {
      kind: "system-prefix-churn",
      shouldCompact: false,
      lastSystemHashes,
      conversationTailTokens: input.conversationTailTokens,
    }
  }
  if (input.conversationTailTokens > minTail) {
    return {
      kind: "conversation-growth",
      shouldCompact: true,
      lastSystemHashes,
      conversationTailTokens: input.conversationTailTokens,
    }
  }
  return {
    kind: "neither",
    shouldCompact: false,
    lastSystemHashes,
    conversationTailTokens: input.conversationTailTokens,
  }
}

/** Test-only: clear all rolling state. */
export function _resetCacheMissDiagnostic(): void {
  hashes.clear()
}
