/**
 * compaction-fix Phase 1 — post-anchor tail transformer (v6, current-task scope).
 *
 * After `applyStreamAnchorRebind` slices messages from the most recent
 * compaction anchor, this transformer drops completed assistant turns
 * that belong to PRIOR user tasks (turns before the most recent user
 * message). Within the current task — all turns since the latest user
 * message — every assistant message stays intact so the model retains
 * full continuity of its own reasoning and tool history.
 *
 * 2026-05-08 revision history:
 *   v1 (commit 6dcd327fa) — collapse each completed turn into a single
 *     `[turn N] tool(args) → ref:xyz` text part. Codex regurgitated the
 *     format as its own output (mimicry).
 *   v2 (commit 43d400258) — drop completed turns beyond `recentRawRounds`
 *     most-recent. Eliminated regurgitation, introduced amnesia when the
 *     recent N turns were all no-text.
 *   v3 (commit a2f30dc4c) — text-bearing-aware preservation. Solved the
 *     no-text-adjacency case but still kept stale tool data.
 *   v5 (commit ac2b34a0b) — full upstream codex-rs alignment, drop ALL
 *     completed assistants. Live observation: model entered tight
 *     amnesia loop because every turn's input collapsed to a constant
 *     (~332 tokens, anchor + user msgs only) and the model re-derived
 *     the same tool call sequence each iteration with no awareness of
 *     what it had just done. Upstream gets away with this because
 *     `/responses/compact` produces a compact summary inside anchor;
 *     our anchor without Phase 2 codex compactedItems carries no
 *     intra-task continuity, so dropping all assistants leaves the
 *     model blind.
 *   v6 (this revision) — current-task scope. Keep everything after the
 *     latest user message intact (full assistant + tool continuity for
 *     the live question). Drop completed assistants before the latest
 *     user message (prior tasks the model finished and can move on
 *     from). Recall is via:
 *       - anchor summary (Phase 2 expansion when codex provider supplies
 *         `/responses/compact` compactedItems)
 *       - post-compaction provider manifest (count + topic labels +
 *         recall tool advertising)
 *       - `system-manager:recall_toolcall_{index,raw,digest}` MCP tools
 *
 * Decisions:
 *   DD-1 (v6) — drop completed assistant turns whose index in the
 *          message stream is BEFORE the last user message. Keep all
 *          turns at or after the last user message regardless of role.
 *          When no user message exists in the post-anchor slice, drop
 *          nothing (rare; means anchor + assistants only, e.g. fresh
 *          rebind from compaction).
 *   DD-7 — `compaction` part type is exempt: those are Mode 1 inline
 *          server compaction items, codex chain state.
 *
 * Safety carve-outs:
 *   - In-flight assistant (any tool part status pending / running) is
 *     NEVER dropped (always after the last user message anyway).
 *   - Assistant carrying a `compaction` part is exempt regardless of
 *     position.
 *   - Anchor message (`messages[0]`) is never touched.
 *
 * Output schema preserved for callers that read `transformedTurnCount`,
 * `exemptTurnCount`, etc. `cacheRefHits` / `cacheRefMisses` retained as
 * 0 for back-compat (no longer meaningful).
 */

import type { MessageV2 } from "./message-v2"

// ─────────────────────────────────────────────────────────────────────────────
// Layer-purity exports (back-compat surface for callers that import the
// constant or class). v6 emits no synthetic text so the assertion path is
// not used internally; the symbols remain exported because
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
// Tail transformation — v6 current-task scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v6 retains an empty options object for call-site stability. The
 * deprecated `recentRawRounds` field is ignored.
 */
export interface TransformOptions {
  /** @deprecated v6 ignores this field. Drop scope is "before last user message". */
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
 * Drops completed assistant turns whose position is before the most
 * recent user message in the post-anchor slice. Anchor at index 0,
 * all messages from the last user message onward, in-flight assistant,
 * and exempt assistants are preserved. Returns a NEW array containing
 * references to kept messages — input is not mutated.
 */
export function transformPostAnchorTail(
  messages: MessageV2.WithParts[],
  _options: TransformOptions = {},
): TransformResult {
  if (messages.length === 0) {
    return { messages, transformedTurnCount: 0, exemptTurnCount: 0, cacheRefHits: 0, cacheRefMisses: 0 }
  }

  // Locate the most recent user message index. Skip the anchor at index 0.
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].info.role === "user") {
      lastUserIdx = i
      break
    }
  }

  // No user message in post-anchor stream → conservative: drop nothing.
  // This happens immediately after compaction when the runloop emits
  // anchor + assistant turns without a fresh user (the synthetic
  // continue message lives there).
  if (lastUserIdx === -1) {
    return { messages, transformedTurnCount: 0, exemptTurnCount: 0, cacheRefHits: 0, cacheRefMisses: 0 }
  }

  const dropIndices = new Set<number>()
  let exemptCount = 0
  for (let i = 1; i < lastUserIdx; i++) {
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
