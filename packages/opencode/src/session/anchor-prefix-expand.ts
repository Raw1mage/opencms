/**
 * compaction-fix Phase 2 — anchor-prefix expansion.
 *
 * Replaces the anchor's free-form summary projection with the codex-
 * produced structured `serverCompactedItems` when present and bound to
 * the current execution chain identity. Runs AFTER Phase 1 transformer,
 * BEFORE `MessageV2.toModelMessages`, so the existing pipeline still
 * serializes the resulting messages.
 *
 * Decisions implemented:
 *   DD-8  storage: reads CompactionPart.metadata.serverCompactedItems +
 *         metadata.chainBinding (no new part types).
 *   DD-9  chain identity: only expand when chainBinding matches the
 *         current execution accountId AND modelId. Mismatch ⇒ leave
 *         anchor untouched, fall back to Phase 1 baseline.
 *   DD-10 read path: drop the original anchor message from the
 *         projection, splice in synthetic user-role messages built from
 *         `serverCompactedItems`. Each codex `message` item becomes one
 *         user-role MessageV2 with its concatenated text. Other item
 *         types (function_call, function_call_output, reasoning, …) in
 *         MVP get serialized as JSON inside one wrapper message.
 *   DD-11 layer purity: `serverCompactedItems` content is OPAQUE to us
 *         (codex black-box). The Phase 1 forbidden-key guard is NOT
 *         applied to it. Synthetic labels we add ARE subject to the
 *         guard via the assertions in post-anchor-transform (we delegate
 *         to the same set, see below).
 *   DD-12 failure modes: every degradation path falls back to leaving
 *         `messages` unchanged, returning structured info for logging.
 *   DD-13 feature flag: caller (prompt.ts) gates invocation via
 *         `compaction.phase2Enabled`.
 */

import { Identifier } from "../id/id"
import type { MessageV2 } from "./message-v2"
import { LAYER_PURITY_FORBIDDEN_KEYS, LayerPurityViolation } from "./post-anchor-transform"

const WRAPPER_LABEL = "[compacted prior tool history — codex-issued]"

export interface ExpansionContext {
  sessionID: string
  accountId: string | undefined
  modelID: string
}

export type ExpansionOutcome =
  | { applied: false; reason: "no-anchor" | "no-compaction-part" | "no-server-items" | "no-chain-binding" | "chain-mismatch" | "items-empty" }
  | {
      applied: true
      messages: MessageV2.WithParts[]
      expandedItemCount: number
      messagesAdded: number
      mappableItemCount: number
      unmappableItemCount: number
    }

interface CompactionMetadataView {
  serverCompactedItems?: unknown[]
  chainBinding?: { accountId: string; modelId: string; capturedAt: number }
}

function findAnchorCompactionMetadata(
  anchor: MessageV2.WithParts,
): CompactionMetadataView | null {
  const part = anchor.parts.find((p) => p.type === "compaction")
  if (!part) return null
  const meta = (part as MessageV2.CompactionPart).metadata
  if (!meta) return null
  return meta as CompactionMetadataView
}

function chainBindingMatches(
  binding: { accountId: string; modelId: string },
  ctx: ExpansionContext,
): boolean {
  if (binding.modelId !== ctx.modelID) return false
  // accountId may legitimately be empty string (e.g. no rotation pinning); both
  // sides empty is treated as match. Otherwise must equal exactly.
  const want = ctx.accountId ?? ""
  if ((binding.accountId ?? "") !== want) return false
  return true
}

interface CodexMessageItem {
  type: "message"
  role?: string
  content?: Array<{ type?: string; text?: string }>
}

function isCodexMessageItem(item: unknown): item is CodexMessageItem {
  if (!item || typeof item !== "object") return false
  const obj = item as { type?: unknown }
  return obj.type === "message"
}

function extractMessageText(item: CodexMessageItem): string {
  if (!Array.isArray(item.content)) return ""
  const fragments = item.content.map((c) => (typeof c?.text === "string" ? c.text : ""))
  return fragments.filter((s) => s.length > 0).join("\n")
}

function buildSyntheticUserMessage(input: {
  sessionID: string
  text: string
  modelTemplate: MessageV2.User
}): MessageV2.WithParts {
  const messageID = Identifier.ascending("message")
  const partID = Identifier.ascending("part")
  return {
    info: {
      id: messageID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.modelTemplate.agent,
      model: input.modelTemplate.model,
      variant: input.modelTemplate.variant,
      kind: "context-preface",
    } as MessageV2.User,
    parts: [
      {
        id: partID,
        sessionID: input.sessionID,
        messageID,
        type: "text",
        text: input.text,
        synthetic: true,
        time: { start: Date.now(), end: Date.now() },
      } as MessageV2.TextPart,
    ],
  }
}

function findUserMessageTemplate(messages: MessageV2.WithParts[]): MessageV2.User | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.info.role === "user") return m.info as MessageV2.User
  }
  return undefined
}

function assertWrapperLabelLayerPurity(): void {
  for (const key of LAYER_PURITY_FORBIDDEN_KEYS) {
    if (WRAPPER_LABEL.includes(key)) throw new LayerPurityViolation(key, "wrapper-label")
  }
}

/**
 * Expand the anchor's serverCompactedItems into synthetic user messages.
 *
 * Inputs:
 *   - `messages`: post-Phase-1 messages, sliced from anchor onward. The
 *      anchor lives at `messages[0]`.
 *   - `ctx`: execution context used to validate chainBinding.
 *
 * Outputs (ExpansionOutcome):
 *   - `applied: false` with reason when expansion was not performed —
 *      caller leaves `messages` untouched and falls back to Phase 1.
 *   - `applied: true` with the rewritten messages and counters for
 *      observability.
 */
export function expandAnchorCompactedPrefix(
  messages: MessageV2.WithParts[],
  ctx: ExpansionContext,
): ExpansionOutcome {
  if (messages.length === 0) return { applied: false, reason: "no-anchor" }
  const anchor = messages[0]
  if (anchor.info.role !== "assistant") return { applied: false, reason: "no-anchor" }
  const meta = findAnchorCompactionMetadata(anchor)
  if (!meta) return { applied: false, reason: "no-compaction-part" }
  if (!Array.isArray(meta.serverCompactedItems)) {
    return { applied: false, reason: "no-server-items" }
  }
  if (meta.serverCompactedItems.length === 0) return { applied: false, reason: "items-empty" }
  if (!meta.chainBinding) return { applied: false, reason: "no-chain-binding" }
  if (!chainBindingMatches(meta.chainBinding, ctx)) {
    return { applied: false, reason: "chain-mismatch" }
  }

  // DD-11: layer-purity guard applies to OUR labels but not codex-issued
  // content. Verify wrapper label every call (cheap; future-proofs against
  // accidental rename to a forbidden key).
  assertWrapperLabelLayerPurity()

  const userTemplate = findUserMessageTemplate(messages)
  if (!userTemplate) {
    // No user message anywhere in the slice → can't synthesize valid
    // messages without an agent/model template. Fall back.
    return { applied: false, reason: "no-anchor" }
  }

  const expanded: MessageV2.WithParts[] = []
  const unmappableJsonChunks: string[] = []
  let mappable = 0
  let unmappable = 0
  for (const item of meta.serverCompactedItems) {
    if (isCodexMessageItem(item)) {
      const text = extractMessageText(item)
      if (text.length === 0) {
        unmappable++
        unmappableJsonChunks.push(JSON.stringify(item))
        continue
      }
      mappable++
      expanded.push(
        buildSyntheticUserMessage({
          sessionID: ctx.sessionID,
          text,
          modelTemplate: userTemplate,
        }),
      )
    } else {
      unmappable++
      unmappableJsonChunks.push(JSON.stringify(item))
    }
  }

  if (unmappableJsonChunks.length > 0) {
    const wrapperText = `${WRAPPER_LABEL}\n${unmappableJsonChunks.join("\n")}`
    expanded.push(
      buildSyntheticUserMessage({
        sessionID: ctx.sessionID,
        text: wrapperText,
        modelTemplate: userTemplate,
      }),
    )
  }

  if (expanded.length === 0) return { applied: false, reason: "items-empty" }

  // Drop the original anchor (messages[0]); splice in expanded items.
  const out = [...expanded, ...messages.slice(1)]
  return {
    applied: true,
    messages: out,
    expandedItemCount: meta.serverCompactedItems.length,
    messagesAdded: expanded.length,
    mappableItemCount: mappable,
    unmappableItemCount: unmappable,
  }
}
