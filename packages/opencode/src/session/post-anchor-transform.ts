/**
 * compaction-fix Phase 1 — post-anchor tail transformer.
 *
 * After `applyStreamAnchorRebind` slices messages from the most recent
 * compaction anchor, this transformer DROPS older completed assistant
 * turns from the LLM input array, keeping only the most recent
 * text-bearing N turns plus any no-text (tool-only) turns interleaved
 * with or after them.
 *
 * 2026-05-08 revision history:
 *   v1 (commit 6dcd327fa): collapse each completed turn into a single
 *     `[turn N] tool(args) → ref:xyz` trace marker text part on the
 *     original assistant message. Live observation showed Codex
 *     mimicking the trace-marker format in its own output channel
 *     (regurgitation under autonomous continuation).
 *   v2 (commit 43d400258): drop completed turns ENTIRELY beyond the N
 *     most-recent. Eliminated regurgitation surface but introduced
 *     amnesia loops — when the recent N turns happened to be all
 *     no-text (tool-call-only) the model lost ALL of its own narrative
 *     thread and re-derived from scratch each round. Confirmed in a
 *     live session where 80+ turns alternated text / no-text and
 *     `recentRawRounds=2` selected two adjacent no-text turns.
 *   v3 (this revision): "smart preservation". Walk newest-first to
 *     find the Nth-most-recent text-bearing completed assistant turn;
 *     keep that turn AND everything after (including any no-text turns
 *     interleaved). Drop everything before. The model always sees at
 *     least N turns of its own narrative regardless of tool/no-text
 *     interleaving.
 *
 * Decisions:
 *   DD-1 (v3) — `recentRawRounds` semantic = "include at least N
 *          text-bearing completed assistant turns + everything after
 *          the Nth-most-recent". When fewer than N text-bearing turns
 *          exist, drop nothing.
 *   DD-2 — Default `recentRawRounds=2`. Sized so a typical multi-turn
 *          exploration retains its last 2 reasoning hooks while older
 *          tool-call-heavy turns drop to keep itemCount low.
 *   DD-7 — `compaction` part type is exempt: those are Mode 1 inline
 *          server compaction items, codex chain state that must
 *          round-trip back unchanged.
 *
 * Safety carve-outs:
 *   - In-flight assistant (any tool part status pending / running) is
 *     NEVER dropped.
 *   - Assistant message containing a `compaction` part is exempt.
 *   - Anchor message (`messages[0]`) is never touched.
 *
 * Output schema preserved for callers that read `transformedTurnCount`,
 * `exemptTurnCount`, etc. `cacheRefHits` / `cacheRefMisses` retained as
 * 0 for back-compat (no longer meaningful).
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
 * v3: a turn is "text-bearing" if it contains at least one non-empty,
 * non-synthetic, non-ignored text part. Reasoning parts also count —
 * codex emits reasoning summaries on a separate channel that carries
 * the model's narrative thread when no main-channel text was produced.
 * Tool-call-only turns and turns whose only text parts are runtime
 * synthetic injections do NOT count.
 */
function isTextBearing(msg: MessageV2.WithParts): boolean {
  for (const part of msg.parts) {
    if (part.type === "text") {
      const tp = part as MessageV2.TextPart
      if (tp.synthetic) continue
      if (tp.ignored) continue
      if (typeof tp.text === "string" && tp.text.trim().length > 0) return true
    } else if (part.type === "reasoning") {
      const rp = part as MessageV2.ReasoningPart
      if (typeof rp.text === "string" && rp.text.trim().length > 0) return true
    }
  }
  return false
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

  if (candidateIndices.length === 0) {
    return { messages, transformedTurnCount: 0, exemptTurnCount: 0, cacheRefHits: 0, cacheRefMisses: 0 }
  }

  // v3: find the cutoff = index of the Nth-most-recent text-bearing
  // completed assistant. Keep that index and everything after; drop
  // everything before. If fewer than N text-bearing turns exist among
  // the candidates, drop nothing (model still has limited self-history,
  // so don't make it worse).
  const textBearingIndices = candidateIndices.filter((i) => isTextBearing(messages[i]))

  if (textBearingIndices.length <= recent) {
    return {
      messages,
      transformedTurnCount: 0,
      exemptTurnCount: candidateIndices.length,
      cacheRefHits: 0,
      cacheRefMisses: 0,
    }
  }

  const cutoffIdx = textBearingIndices[textBearingIndices.length - recent]
  const dropIndices = new Set(candidateIndices.filter((i) => i < cutoffIdx))

  if (dropIndices.size === 0) {
    return {
      messages,
      transformedTurnCount: 0,
      exemptTurnCount: candidateIndices.length,
      cacheRefHits: 0,
      cacheRefMisses: 0,
    }
  }

  const out = messages.filter((_, idx) => !dropIndices.has(idx))

  return {
    messages: out,
    transformedTurnCount: dropIndices.size,
    exemptTurnCount: candidateIndices.length - dropIndices.size,
    cacheRefHits: 0,
    cacheRefMisses: 0,
  }
}
