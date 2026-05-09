/**
 * post-anchor tail transformer.
 *
 * After `applyStreamAnchorRebind` slices messages from the most recent
 * compaction anchor, this transformer bounds the LLM-visible token cost
 * of the post-anchor stream.
 *
 * 2026-05-08 → 2026-05-10 revision history:
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
 *     amnesia loop because every turn's input collapsed to a constant.
 *     Upstream gets away with this only because `/responses/compact`
 *     produces a compact summary inside anchor; without that, dropping
 *     all assistants leaves the model blind to its own intra-task
 *     reasoning.
 *   v6 (commit c56e5538f) — current-task scope. Keep everything after
 *     the latest user message intact, drop completed assistants before
 *     it. Preserved live-question continuity but still dropped prior-
 *     task content (only-partial fix).
 *   v7 (compaction/dialog-replay-redaction, 2026-05-10) — pass-through
 *     all messages, redact tool-result payloads to recall_id markers in
 *     place. Pairs with the redacted-dialog anchor body produced by
 *     tryNarrative — model retains full text + reasoning + tool args
 *     across compactions; the bulky tool outputs are recallable on
 *     demand via system-manager:recall_toolcall_raw.
 *
 * Decisions (v7):
 *   DD-5 (dialog-replay-redaction) — replace v6 drop logic with redact-
 *          only logic: per-tool-part `state.output` becomes
 *          `[recall_id: <part.id>]`. No message-level drops.
 *   DD-7 (compaction-fix retained) — `compaction` part type is exempt:
 *          those are Mode 1 inline server compaction items, codex chain
 *          state.
 *
 * Safety carve-outs (v7):
 *   - In-flight assistants (any tool part status pending / running) —
 *     pending/running tool parts have no output to redact; skipped.
 *   - Assistant carrying a `compaction` part is exempt regardless of
 *     position — the assistant message keeps all of its parts unchanged.
 *   - Anchor message (`messages[0]`) is never touched.
 *
 * Output schema preserved for callers that read `transformedTurnCount`,
 * `exemptTurnCount`, etc. Under v7 the drop-related fields are vestigial
 * (always 0); a new `redactedToolPartCount` is exposed for telemetry.
 *
 * Feature flag (Tweaks.compactionSync().enableDialogRedactionAnchor,
 * default true): when true, v7 runs; when false, v6 fallback runs
 * (preserves the pre-spec behaviour for emergency rollback).
 */

import type { MessageV2 } from "./message-v2"
import { Tweaks } from "../config/tweaks"

// ─────────────────────────────────────────────────────────────────────────────
// Layer-purity exports (back-compat surface for callers that import the
// constant or class). v7 emits no synthetic text so the assertion path is
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
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v6 retained `recentRawRounds`; v7 ignores it. Kept for ABI stability.
 */
export interface TransformOptions {
  /** @deprecated v6/v7 ignore this field. */
  recentRawRounds?: number
}

export interface TransformResult {
  messages: MessageV2.WithParts[]
  /** v6: count of dropped completed assistant turns. v7: always 0. */
  transformedTurnCount: number
  /** v6/v7: count of carve-out matches (in-flight / compaction-bearing). */
  exemptTurnCount: number
  /** Vestigial under v7. */
  cacheRefHits: number
  /** Vestigial under v7. */
  cacheRefMisses: number
  /** v7-only: count of tool parts whose output was redacted to recall_id. */
  redactedToolPartCount?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Carve-out predicates (shared by v6 + v7)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// v7 — redact-only (active path under enableDialogRedactionAnchor=true)
// ─────────────────────────────────────────────────────────────────────────────

function isRedactableToolPart(part: MessageV2.Part): part is MessageV2.ToolPart {
  if (part.type !== "tool") return false
  const status = (part as MessageV2.ToolPart).state?.status
  if (status !== "completed" && status !== "error") return false
  // Only completed/error states carry an `output` (or `error`) string.
  // pending/running do not.
  return true
}

/**
 * Replace `state.output` with a recall_id reference. Returns a new ToolPart
 * with the output substituted; original is left untouched. Idempotent —
 * already-redacted parts (output already starts with "[recall_id:") are
 * passed through unchanged.
 */
export function redactToolPart(part: MessageV2.ToolPart): MessageV2.ToolPart {
  const state = part.state as { status: string; output?: string }
  if (state.status !== "completed") return part
  const out = state.output
  if (typeof out !== "string") return part
  if (out.startsWith("[recall_id:")) return part
  return {
    ...part,
    state: {
      ...state,
      output: `[recall_id: ${part.id}]`,
    } as MessageV2.ToolPart["state"],
  }
}

function transformPostAnchorTailV7(messages: MessageV2.WithParts[]): TransformResult {
  if (messages.length === 0) {
    return {
      messages,
      transformedTurnCount: 0,
      exemptTurnCount: 0,
      cacheRefHits: 0,
      cacheRefMisses: 0,
      redactedToolPartCount: 0,
    }
  }

  let exemptCount = 0
  let redactedToolPartCount = 0

  const out: MessageV2.WithParts[] = messages.map((msg, idx) => {
    // Anchor at index 0 — pass through untouched.
    if (idx === 0) return msg
    if (msg.info.role !== "assistant") return msg

    if (isInFlightAssistant(msg)) {
      exemptCount++
      return msg
    }
    if (isExemptAssistant(msg)) {
      exemptCount++
      return msg
    }

    let mutated = false
    const newParts = msg.parts.map((p) => {
      if (!isRedactableToolPart(p)) return p
      const redacted = redactToolPart(p)
      if (redacted !== p) {
        mutated = true
        redactedToolPartCount++
      }
      return redacted
    })

    if (!mutated) return msg
    return { ...msg, parts: newParts }
  })

  return {
    messages: out,
    transformedTurnCount: 0,
    exemptTurnCount: exemptCount,
    cacheRefHits: 0,
    cacheRefMisses: 0,
    redactedToolPartCount,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v6 — drop-based fallback (legacy; only reachable with flag off)
// ─────────────────────────────────────────────────────────────────────────────

function transformPostAnchorTailV6(messages: MessageV2.WithParts[]): TransformResult {
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

// ─────────────────────────────────────────────────────────────────────────────
// Public dispatch — chooses v7 or v6 by feature flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transform the post-anchor tail of a sliced message stream.
 *
 * Default (Tweaks.compactionSync().enableDialogRedactionAnchor=true):
 * v7 redacts tool result payloads to `[recall_id: <part.id>]` markers
 * while preserving every message verbatim (including prior-task assistant
 * turns).
 *
 * Legacy (flag off): v6 drops completed assistants whose position is
 * before the most recent user message.
 *
 * Carve-outs in both versions: anchor at index 0, in-flight assistants,
 * compaction-bearing assistants. Returns a NEW array; input is not
 * mutated.
 */
export function transformPostAnchorTail(
  messages: MessageV2.WithParts[],
  _options: TransformOptions = {},
): TransformResult {
  const tweaks = Tweaks.compactionSync()
  const flag = (tweaks as { enableDialogRedactionAnchor?: boolean }).enableDialogRedactionAnchor
  if (flag === false) return transformPostAnchorTailV6(messages)
  return transformPostAnchorTailV7(messages)
}

// Test seam — direct access to v6/v7 implementations for unit tests.
export const __test__ = Object.freeze({
  v6: transformPostAnchorTailV6,
  v7: transformPostAnchorTailV7,
})
