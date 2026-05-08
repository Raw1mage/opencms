/**
 * compaction-fix Phase 1 — post-anchor tail transformer.
 *
 * After `applyStreamAnchorRebind` slices messages from the most recent
 * compaction anchor, this transformer folds completed assistant turns
 * (beyond the most recent N rounds) so each turn contributes ONE part
 * instead of 7–10 parts. Drives `inputItemCount` down to avoid Codex
 * backend's hidden array-length sensitivity (>~300 items failure region
 * documented in fix-empty-response-rca).
 *
 * Decisions implemented:
 *   DD-1 — single-line trace marker `[turn N] tool_a(args_brief) → ref;
 *          tool_b(args_brief); <reasoning_summary>`.
 *          Implementation note: trace marker lives as the SOLE text part
 *          on the existing assistant message; we keep assistant role
 *          (DD-1's user-role wording was overcautious — assistant-role
 *          history is what Codex naturally consumes; collapsing parts
 *          achieves the same prompt-shape goal without fabricating
 *          synthetic user messages).
 *   DD-2 — `recentRawRounds` (default 2) most recent completed assistant
 *          turns are left untouched so model retains short-term memory.
 *   DD-3 — WorkingCache writes happen at tool completion (existing path);
 *          transformer only reads ledger pointers via Session.messages
 *          on the caller side, so no synchronous WC write here.
 *   DD-4 — safety net handled by caller (prompt.ts); transformer just
 *          reports the transformed count.
 *   DD-5 — caller skips invocation for subagent path; transformer is
 *          unaware of subagent context.
 *   DD-7 — layer purity guard: trace marker text rejects connection-state
 *          keys at format time. Throws `LayerPurityViolation` if it sees
 *          anything in `LAYER_PURITY_FORBIDDEN_KEYS`.
 *
 * Safety carve-outs:
 *   - In-flight assistant message (last assistant with any pending tool
 *     state) is NEVER transformed.
 *   - Assistant message containing a `compaction` part type (Mode 1
 *     inline server compaction product) is exempt — codex chain state.
 */

import type { MessageV2 } from "./message-v2"
import { Identifier } from "../id/id"

// ─────────────────────────────────────────────────────────────────────────────
// Layer purity (DD-7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokens that must NOT appear in any trace marker text. Compaction payload is
 * L2 (working memory); these belong to L4 (connection state) maintained by
 * the codex transport layer. Mixing layers makes traces poisonous after
 * rotation / rebind. Mirrored from data-schema.json LayerPurityForbiddenKeys.
 */
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

function assertLayerPurity(text: string, context: string): void {
  for (const key of LAYER_PURITY_FORBIDDEN_KEYS) {
    if (text.includes(key)) throw new LayerPurityViolation(key, context)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace marker formatting (DD-1)
// ─────────────────────────────────────────────────────────────────────────────

const ARGS_TRUNC = 80
const REASONING_TRUNC = 50
const TRACE_MAX = 1024

interface TraceFragment {
  toolName: string
  argsBrief: string
  callID: string
  hasResult: boolean
}

function briefArgs(input: unknown): string {
  if (typeof input === "string") {
    return truncate(input, ARGS_TRUNC)
  }
  if (input == null) return ""
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    serialized = String(input)
  }
  return truncate(serialized, ARGS_TRUNC)
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

/**
 * Format the trace marker line for a single completed assistant turn.
 * Returns null if the turn carries nothing worth tracing (no tool calls,
 * no reasoning) — caller may keep or drop accordingly.
 */
export function formatTraceMarker(input: {
  turnIndex: number
  toolFragments: TraceFragment[]
  reasoningSummary: string | null
}): string {
  const { turnIndex, toolFragments, reasoningSummary } = input
  const segments: string[] = []
  for (const frag of toolFragments) {
    const argsPart = frag.argsBrief ? `(${frag.argsBrief})` : "()"
    const refPart = frag.hasResult ? ` → ref:${frag.callID.slice(0, 12)}` : ""
    segments.push(`${frag.toolName}${argsPart}${refPart}`)
  }
  if (reasoningSummary) {
    segments.push(truncate(reasoningSummary.replace(/\s+/g, " ").trim(), REASONING_TRUNC))
  }
  const body = segments.length > 0 ? segments.join("; ") : "(no traced parts)"
  const line = truncate(`[turn ${turnIndex}] ${body}`, TRACE_MAX)
  assertLayerPurity(line, `trace marker turn=${turnIndex}`)
  return line
}

// ─────────────────────────────────────────────────────────────────────────────
// Tail transformation (DD-2 + carve-outs)
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

const TRANSFORM_PRESERVED_PART_TYPES = new Set<MessageV2.Part["type"]>([
  "compaction",
  "step-start",
  "step-finish",
])

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
  // DD-7 carve-out — Mode 1 inline server compaction items must round-trip
  // back to codex unchanged.
  return msg.parts.some((p) => p.type === "compaction")
}

function collectTraceFragments(parts: MessageV2.Part[]): TraceFragment[] {
  const fragments: TraceFragment[] = []
  for (const part of parts) {
    if (part.type !== "tool") continue
    const tp = part as MessageV2.ToolPart
    const inputCandidate = (tp.state as any)?.input ?? {}
    fragments.push({
      toolName: tp.tool,
      argsBrief: briefArgs(inputCandidate),
      callID: tp.callID,
      hasResult: tp.state?.status === "completed",
    })
  }
  return fragments
}

function collectReasoningSummary(parts: MessageV2.Part[]): string | null {
  for (const part of parts) {
    if (part.type !== "reasoning") continue
    const text = (part as MessageV2.ReasoningPart).text
    if (typeof text === "string" && text.trim().length > 0) return text
  }
  return null
}

/**
 * Build the replacement parts array for a transformed assistant turn.
 * Returns one synthetic text part holding the trace marker, plus any
 * preserved parts (compaction, step-start, step-finish) carried through.
 */
function buildTransformedParts(input: {
  original: MessageV2.WithParts
  turnIndex: number
}): { parts: MessageV2.Part[]; cacheHit: boolean; cacheMiss: boolean } {
  const { original, turnIndex } = input
  const fragments = collectTraceFragments(original.parts)
  const reasoning = collectReasoningSummary(original.parts)
  const text = formatTraceMarker({
    turnIndex,
    toolFragments: fragments,
    reasoningSummary: reasoning,
  })

  // Preserve protocol-relevant parts (step boundaries + compaction markers).
  const preserved = original.parts.filter((p) => TRANSFORM_PRESERVED_PART_TYPES.has(p.type))

  const tracePart: MessageV2.TextPart = {
    id: Identifier.ascending("part"),
    sessionID: original.info.sessionID,
    messageID: original.info.id,
    type: "text",
    text,
    synthetic: true,
    time: { start: Date.now(), end: Date.now() },
  } as MessageV2.TextPart

  const cacheHit = fragments.some((f) => f.hasResult)
  const cacheMiss = fragments.some((f) => !f.hasResult)
  return { parts: [...preserved, tracePart], cacheHit, cacheMiss }
}

/**
 * Transform the post-anchor tail of a sliced message stream.
 *
 * Inputs:
 *   - `messages`: sliced from anchor onward (anchor is `messages[0]`).
 *   - `recentRawRounds`: keep this many most-recent completed assistant
 *      turns untouched.
 *
 * Outputs (TransformResult):
 *   - `messages`: same length as input. Position-preserving — anchor and
 *      user/in-flight/exempt items unchanged; transformed assistant
 *      messages have their `parts` replaced.
 *   - counters for observability.
 */
export function transformPostAnchorTail(
  messages: MessageV2.WithParts[],
  options: TransformOptions,
): TransformResult {
  if (messages.length === 0) {
    return { messages, transformedTurnCount: 0, exemptTurnCount: 0, cacheRefHits: 0, cacheRefMisses: 0 }
  }
  const recent = Math.max(0, options.recentRawRounds)

  // Identify completed assistant turns (skip in-flight, skip exempt).
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

  const transformIndices = candidateIndices.slice(0, candidateIndices.length - recent)

  const out = messages.slice()
  let transformedCount = 0
  let cacheHits = 0
  let cacheMisses = 0
  for (const idx of transformIndices) {
    const original = out[idx]
    const built = buildTransformedParts({ original, turnIndex: idx })
    out[idx] = { ...original, parts: built.parts }
    transformedCount++
    if (built.cacheHit) cacheHits++
    if (built.cacheMiss) cacheMisses++
  }

  return {
    messages: out,
    transformedTurnCount: transformedCount,
    exemptTurnCount: candidateIndices.length - transformedCount,
    cacheRefHits: cacheHits,
    cacheRefMisses: cacheMisses,
  }
}
