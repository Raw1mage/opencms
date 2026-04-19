import type { QuestionRequest } from "@opencode-ai/sdk/v2"

/**
 * Canonical JSON: keys sorted recursively so identical content always
 * serialises identically, regardless of original key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]"
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}"
}

/**
 * FNV-1a 32-bit hash, hex-encoded. Not cryptographic — purpose is a stable,
 * collision-resistant-enough key for a UI cache scoped to a single session.
 * Sync so it can be used inside SolidJS `createStore` initial state.
 *
 * We used FNV-1a rather than SubtleCrypto SHA-1 (see DD-2 [SUPERSEDED]) to
 * avoid async cache restoration races at component mount — user typing
 * before the async hash resolves would overwrite the restored input.
 */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Build the QuestionDock cache key.
 *
 * Format: `<sessionID>:<fnv1a32(canonicalJson(questions))>`
 *
 * - `sessionID` prefix prevents cross-session leakage.
 * - `questions` hash is stable across AI re-asks of the same question
 *   (different `request.id`, identical content) so the user's typed draft
 *   is restored automatically.
 */
export function questionCacheKey(request: Pick<QuestionRequest, "sessionID" | "questions">): string {
  return `${request.sessionID}:${fnv1a32(canonicalJson(request.questions))}`
}
