/**
 * compaction-fix Phase 1 — post-anchor tail transformer (v5, upstream-aligned).
 *
 * After `applyStreamAnchorRebind` slices messages from the most recent
 * compaction anchor, this transformer DROPS every completed assistant
 * turn from the LLM input array. The model sees only:
 *   - the anchor (carrying compacted summary + Phase 2 codex compactedItems)
 *   - all user messages
 *   - the in-flight assistant turn (if any)
 *   - assistant turns carrying a `compaction` part (Mode 1 inline server
 *     compaction state — codex chain bookkeeping, must round-trip)
 *
 * 2026-05-08 revision history:
 *   v1 (commit 6dcd327fa) — collapse each completed turn into a single
 *     `[turn N] tool(args) → ref:xyz` text part on the original
 *     assistant message. Codex regurgitated the format as its own
 *     output (mimicry under autonomous continuation).
 *   v2 (commit 43d400258) — drop completed turns ENTIRELY beyond the N
 *     most-recent. Eliminated regurgitation, introduced amnesia
 *     (when the recent N turns happened to be no-text the model lost
 *     all of its narrative thread).
 *   v3 (commit a2f30dc4c) — text-bearing-aware preservation: keep the
 *     Nth-most-recent text-bearing turn AND everything after. Solved
 *     the no-text adjacency case but still kept stale tool data.
 *   v5 (this revision) — full upstream codex-rs alignment. Drop ALL
 *     completed assistant content. Recall is via the system-manager
 *     `recall_toolcall_*` MCP tools advertised in the post-compaction
 *     manifest, plus Phase 2 anchor-prefix expansion of codex
 *     `/responses/compact` compactedItems. The `recentRawRounds`
 *     parameter is removed — upstream `build_compacted_history`
 *     does not preserve any past assistant content.
 *
 * Decisions:
 *   DD-1 (v5) — completed assistant turns are dropped from LLM input
 *          unconditionally. The model relies on:
 *            (a) anchor summary (Phase 2 expansion when codex provider)
 *            (b) post-compaction provider manifest (count + topic
 *                labels + recall tool names)
 *            (c) `system-manager:recall_toolcall_{index,raw,digest}`
 *                MCP tools for on-demand drill-in
 *   DD-7 — `compaction` part type is exempt: those are Mode 1 inline
 *          server compaction items, codex chain state.
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
// Layer-purity exports (back-compat surface for callers that import the
// constant or class). v5 emits no synthetic text so the assertion path is
// no longer used internally; the symbols remain exported because
// `anchor-prefix-expand.ts` (Phase 2) imports them.
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
// Tail transformation — v5 unconditional drop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v5 retains an empty options object for call-site stability while the
 * `recentRawRounds` field is being removed from config callers. Future
 * cleanup may delete the parameter entirely.
 */
export interface TransformOptions {
  /** @deprecated v5 ignores this field. Drop is unconditional. */
  recentRawRounds?: number
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
 * Drops every completed assistant turn that is not in-flight and not
 * carrying a `compaction` part. Anchor at index 0, all user messages,
 * the in-flight assistant, and exempt assistants are preserved. Returns
 * a NEW array containing references to kept messages — input is not
 * mutated.
 */
export function transformPostAnchorTail(
  messages: MessageV2.WithParts[],
  _options: TransformOptions = {},
): TransformResult {
  if (messages.length === 0) {
    return { messages, transformedTurnCount: 0, exemptTurnCount: 0, cacheRefHits: 0, cacheRefMisses: 0 }
  }

  const dropIndices = new Set<number>()
  let exemptCount = 0
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "assistant") continue
    if (isInFlightAssistant(msg)) {
      exemptCount++
      continue
    }
    if (isExemptAssistant(msg)) {
      exemptCount++
      continue
    }
    dropIndices.add(i)
  }

  if (dropIndices.size === 0) {
    return {
      messages,
      transformedTurnCount: 0,
      exemptTurnCount: exemptCount,
      cacheRefHits: 0,
      cacheRefMisses: 0,
    }
  }

  const out = messages.filter((_, idx) => !dropIndices.has(idx))

  return {
    messages: out,
    transformedTurnCount: dropIndices.size,
    exemptTurnCount: exemptCount,
    cacheRefHits: 0,
    cacheRefMisses: 0,
  }
}
