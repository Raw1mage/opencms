/**
 * compaction-fix Phase 1 — post-anchor tail transformer.
 *
 * After `applyStreamAnchorRebind` slices messages from the most recent
 * compaction anchor, this transformer DROPS completed assistant turns
 * (beyond the most recent N rounds) entirely from the LLM input array.
 *
 * 2026-05-08 revision: previous implementation collapsed each completed
 * turn into a single `[turn N] tool(args) → ref:xyz` trace marker text
 * part, kept on the original assistant message. Live observation showed
 * Codex regurgitating the trace marker format in its own output text
 * channel — model attended to the runtime-injected pattern and mimicked
 * it as if it were its own continuation. Per upstream codex-rs
 * `build_compacted_history` (refs/codex/codex-rs/core/src/compact.rs),
 * the safest design is to NOT show the model its own past assistant
 * output at all. Working cache (`packages/opencode/src/session/working-cache.ts`)
 * preserves what would otherwise be lost; the model can recall via
 * `recall_toolcall_*` tools when needed.
 *
 * Decisions:
 *   DD-1 (2026-05-08, revised) — completed assistant turns beyond
 *          `recentRawRounds` are removed from the LLM input array
 *          entirely. No trace marker, no synthetic content, no role
 *          swap. Drives `inputItemCount` down to the same low region
 *          upstream achieves and removes the regurgitation surface.
 *   DD-2 — `recentRawRounds` (default 2) most recent completed assistant
 *          turns are left in place so the model retains short-term
 *          memory of its own most recent reasoning.
 *   DD-7 — `compaction` part type is exempt: those are Mode 1 inline
 *          server compaction items, codex chain state that must
 *          round-trip back unchanged.
 *
 * Safety carve-outs:
 *   - In-flight assistant message (any tool part with status pending /
 *     running) is NEVER dropped.
 *   - Assistant message containing a `compaction` part type is exempt.
 *   - The anchor message (`messages[0]`) is never touched.
 *
 * Output schema preserved for callers that read `transformedTurnCount`,
 * `exemptTurnCount`, etc. `cacheRefHits` / `cacheRefMisses` are retained
 * as 0 for back-compat (no longer meaningful).
 */

import type { MessageV2 } from "./message-v2"

// ─────────────────────────────────────────────────────────────────────────────
// Layer purity (DD-7) — preserved as exported API for downstream consumers
// that import the constant. No longer used internally because no synthetic
// text is emitted.
// ─────────────────────────────────────────────────────────────────────────────

export const LAYER_PURITY_FORBIDDEN_KEYS = [
  "accountId",
  "providerId",
  "wsSessionId",
  "previous_response_id",
  "conversation_id",
  "credentials",
  "access_token",
  "refresh_token",
] as const

export class LayerPurityViolation extends Error {
  constructor(public readonly forbiddenKey: string, public readonly context: string) {
    super(`compaction-fix layer purity violated: trace marker contains "${forbiddenKey}" (${context})`)
    this.name = "LayerPurityViolation"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tail transformation
// ─────────────────────────────────────────────────────────────────────────────

export interface TransformOptions {
  recentRawRounds: number
}

export interface TransformResult {
  messages: MessageV2.WithParts[]
  transformedTurnCount: number
  exemptTurnCount: number
  cacheRefHits: number
  cacheRefMisses: number
}

function isInFlightAssistant(msg: MessageV2.WithParts): boolean {
  if (msg.info.role !== "assistant") return false
  return msg.parts.some((p) => {
    if (p.type !== "tool") return false
    const status = (p as MessageV2.ToolPart).state?.status
    return status === "pending" || status === "running"
  })
}

function isExemptAssistant(msg: MessageV2.WithParts): boolean {
  if (msg.info.role !== "assistant") return false
  return msg.parts.some((p) => p.type === "compaction")
}

/**
 * Transform the post-anchor tail of a sliced message stream.
 *
 * Drops completed assistant turns beyond `recentRawRounds`. Anchor at
 * index 0, all user messages, in-flight assistant, and compaction-bearing
 * assistants are preserved.
 *
 * The returned array is a NEW array containing references to the kept
 * messages — no message is mutated.
 */
export function transformPostAnchorTail(
  messages: MessageV2.WithParts[],
  options: TransformOptions,
): TransformResult {
  if (messages.length === 0) {
    return { messages, transformedTurnCount: 0, exemptTurnCount: 0, cacheRefHits: 0, cacheRefMisses: 0 }
  }
  const recent = Math.max(0, options.recentRawRounds)

  // Identify completed assistant turns (candidates for dropping).
  const candidateIndices: number[] = []
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "assistant") continue
    if (isInFlightAssistant(msg)) continue
    if (isExemptAssistant(msg)) continue
    candidateIndices.push(i)
  }

  if (candidateIndices.length <= recent) {
    return {
      messages,
      transformedTurnCount: 0,
      exemptTurnCount: candidateIndices.length,
      cacheRefHits: 0,
      cacheRefMisses: 0,
    }
  }

  const dropIndices = new Set(candidateIndices.slice(0, candidateIndices.length - recent))
  const out = messages.filter((_, idx) => !dropIndices.has(idx))

  return {
    messages: out,
    transformedTurnCount: dropIndices.size,
    exemptTurnCount: candidateIndices.length - dropIndices.size,
    cacheRefHits: 0,
    cacheRefMisses: 0,
  }
}
