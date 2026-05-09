# Design: dialog-replay-redaction

## Context

Local compaction's two-tier design (extend + recompress) is already represented in the codebase. Eleven of fifteen relevant pieces are correct as-is; four pieces diverged from the formal model `anchor[n+1] = anchor[n] + serialize_redacted(tail)` during the v1→v6 evolution on `post-anchor-transform.ts` (commits `6dcd327fa` → `c56e5538f`, all 2026-05-08).

The divergence has two roots:

1. **Wrong drop target** — v5 (`ac2b34a0b`) misread upstream codex-rs's `build_compacted_history` and made the post-anchor transformer drop completed assistants instead of redacting tool result payloads. v6 (`c56e5538f`) partially recovered but kept the wrong drop target.
2. **Wrong body source** — `tryNarrative` derives anchor body from `Memory.renderForLLMSync(mem)`, which uses `lastTextPartText` to pull only the last text part from each finished assistant turn — discarding reasoning channel, tool args, and intermediate text. This produces a lossy anchor that doesn't match the formal model's `anchor[n] + serialize_redacted(tail)`.

Production evidence (2026-05-09 session `ses_1f47aa711ffehMSKNf54ZCHFTF`): a rebind compaction with 440 input items at 735617 bytes = ~1671 bytes/item average. Pure dialogue (user msg + assistant text + reasoning + tool args) is ~10-20% of that bulk; tool result payloads are the rest. Redacting payloads recovers the same item-count savings as v6's drop without the amnesia regression.

This spec is a refit. No new mechanisms; four targeted patches restore the formal model.

## Goals / Non-Goals

### Goals

- Restore `anchor[n+1] = anchor[n] + serialize_redacted(tail)` as the extend semantics for the `narrative` kind.
- Restore size-triggered, provider-aware recompress (50K ceiling; codex → server-side, else → llm-agent).
- Replace `post-anchor-transform.ts` v6 drop logic with v7 redact-only logic.
- Fix the `lastTextPartText` reasoning-blind correctness bug.
- Coordinate with Spec `user-msg-replay-unification` so unanswered user msgs appear exactly once in the model's view (post-anchor stream), not duplicated in the anchor body.
- Provide a feature flag (`enableDialogRedactionAnchor`) for emergency rollback to legacy behaviour.

### Non-Goals

- Not restructuring the kind chain (narrative / replay-tail / low-cost-server / llm-agent stay).
- Not modifying the codex `/responses/compact` plugin or `Hybrid.runHybridLlm` body.
- Not changing `anchor-prefix-expand.ts` Phase 2 (codex serverCompactedItems path stays orthogonal).
- Not changing `working-cache` ledger derivation (already correct; redaction's `recall_id` maps to existing `part.id` linkage).
- Not changing schema (MessageV2, CompactionPart, Anchor message shape all unchanged).
- Not making recompress synchronous — it stays background-fire-and-forget like today.

## Decisions

### DD-1 — `serializeRedactedDialog` lives in a new pure-function module

New file `packages/opencode/src/session/dialog-serializer.ts`.

```ts
export function serializeRedactedDialog(
  messages: MessageV2.WithParts[],
  options?: {
    /** Round number to start counting from. Default 1. */
    startRound?: number
    /** Exclude this user message id from serialisation (Spec 1 synergy). */
    excludeUserMessageID?: string
  },
): { text: string; lastRound: number; messagesEmitted: number }
```

**Why a new module**: keeps the serialiser pure-functional, testable in isolation, and reusable by both `tryNarrative` and any future caller (e.g. UI debug dumps).

### DD-2 — Markdown serialisation grammar

```
## Round {N}
                                                    (one blank line)
**User**
                                                    (one blank line)
{user message text content}
                                                    (one blank line)
**Reasoning**                                       (only if reasoning part exists)
                                                    
{reasoning content}

**Assistant**                                       (only if text part with content exists)

{assistant text content}

**Tool**: `{tool_name}({tool_args_json})` → `recall_id: {part.id}`
                                                    (one line per tool part, completed status only)
```

A round is `[user_message, ...subsequent_assistant_messages until next user_message_or_end]`. Round numbering is monotonic across an entire anchor body's history (not reset per extend). The `startRound` parameter lets `tryNarrative` continue numbering from where the previous anchor left off.

**Why markdown**: tokenizer-efficient (`##` ≈ 1 token, `**...**` is well-trained), self-documenting, renders cleanly if surfaced in UI. Per user direction "我非常偏好md檔製作。這是省overhead最好的solution".

**Tool args serialisation**: JSON-stringify `state.input` (capped at 500 chars; truncate with `…`). Exact tool args matter — the model uses them to understand "what did I try last time".

**Tool output redaction**: replace `state.output` with the literal `recall_id: <part.id>` reference. The `part.id` is already what `working-cache.deriveLedger` uses as `messageRef`/`toolCallID`, so `recall_toolcall_raw(<part.id>)` resolves correctly.

### DD-3 — `tryNarrative` rewrite

Current ([compaction.ts:959-975](packages/opencode/src/session/compaction.ts#L959-L975)):

```ts
async function tryNarrative(input, model): Promise<KindAttempt> {
  const mem = await Memory.read(input.sessionID)
  // ...uses Memory.renderForLLMSync(mem)...
}
```

New behaviour:

```ts
async function tryNarrative(input, model): Promise<KindAttempt> {
  const tweaks = Tweaks.compactionSync()
  if (!tweaks.enableDialogRedactionAnchor) {
    // Legacy fallback path — exact prior behaviour.
    return tryNarrativeLegacy(input, model)
  }

  const messages = await Session.messages({ sessionID: input.sessionID })
  const prevAnchor = await Memory.Hybrid.getAnchorMessage(input.sessionID, messages)
  const prevAnchorIdx = prevAnchor
    ? messages.findIndex((m) => m.info.id === prevAnchor.info.id)
    : -1
  const prevBody = prevAnchor ? textPartsJoined(prevAnchor.parts) : ""
  const prevLastRound = parsePrevLastRound(prevBody) // scan for last "## Round N" header
  
  // Spec 1 synergy: identify the unanswered user msg to skip
  const unansweredId = findUnansweredUserMessageId(messages, prevAnchorIdx)
  
  const tail = messages.slice(prevAnchorIdx + 1)
  const { text: tailText, lastRound, messagesEmitted } = serializeRedactedDialog(tail, {
    startRound: prevLastRound + 1,
    excludeUserMessageID: unansweredId,
  })

  if (messagesEmitted === 0 && prevBody === "") {
    return { ok: false, reason: "memory empty" }
  }

  const body = prevBody ? `${prevBody}\n\n${tailText}` : tailText
  const truncated = false  // size-triggered recompress handles oversize, not truncation here

  return { ok: true, summaryText: body, kind: "narrative", truncated }
}
```

`parsePrevLastRound` is a small regex-based scan (`/^## Round (\d+)$/m` in the prev body, returning the highest match or 0).

`findUnansweredUserMessageId` is the same logic Spec 1 uses for `snapshotUnansweredUserMessage` — walks tail from end, finds most-recent user msg whose nearest assistant child has `finish ∉ {stop, tool-calls, length}`.

### DD-4 — `scheduleHybridEnrichment` patches

Current behaviour ([compaction.ts:1454-1660](packages/opencode/src/session/compaction.ts#L1454-L1660)):
- Skips if `!enableHybridLlm`
- Skips if observed not in {overflow, cache-aware, manual}
- Skips if anchor < 5K tokens
- Always uses `Hybrid.runHybridLlm` (LLM body)

New behaviour:

```ts
function scheduleHybridEnrichment(sessionID, observed, model) {
  if (!model) return
  const tweaks = Tweaks.compactionSync()
  if (!tweaks.enableHybridLlm) return
  if (hybridEnrichInFlight.has(sessionID)) return
  
  // Removed: observed-gate (was line 1470)
  
  // Compute size first
  const messages = await Session.messages({ sessionID })
  const anchorMsg = await Memory.Hybrid.getAnchorMessage(sessionID, messages)
  if (!anchorMsg) return
  const anchorContent = textPartsJoined(anchorMsg.parts)
  const anchorTokens = Math.ceil(anchorContent.length / 4)
  
  const ceiling = tweaks.anchorRecompressCeilingTokens // default 50_000
  const floor = 5_000  // unchanged
  
  if (anchorTokens < floor) return  // skip floor preserved
  
  // NEW: dispatch by provider when ceiling exceeded
  const isCodex = model.providerId === "codex"
  
  if (anchorTokens > ceiling || /* legacy enrich-when-large policy */) {
    if (isCodex) {
      void runCodexServerSideRecompress(sessionID, anchorMsg, model)
    } else {
      void runHybridLlmRecompress(sessionID, anchorMsg, model, observed)
    }
  }
}
```

`runCodexServerSideRecompress` is a new wrapper around `tryLowCostServer`-style invocation, but treating the anchor body as the input (single-message conversationItem) rather than the full session stream. On success, in-place update of anchor msg's text part (mirrors STEP 3 logic at compaction.ts:1546-1660).

`runHybridLlmRecompress` keeps the existing 1546-1660 flow (already correct for non-codex case).

### DD-5 — `post-anchor-transform.ts` v6 → v7

v6's `transformPostAnchorTail` drops completed assistants. v7 replaces it with:

```ts
export function transformPostAnchorTail(
  messages: MessageV2.WithParts[],
  options?: TransformOptions,
): TransformResult {
  const tweaks = Tweaks.compactionSync()
  if (!tweaks.enableDialogRedactionAnchor) {
    return transformPostAnchorTailV6(messages, options) // legacy fallback
  }
  
  // v7: pass-through messages, redact tool result payloads in place
  const transformedMessages = messages.map((msg) => {
    if (msg.info.role !== "assistant") return msg
    const transformedParts = msg.parts.map((part) => {
      if (part.type !== "tool") return part
      if (part.state?.status !== "completed" && part.state?.status !== "error") return part
      // In-flight carve-out: never touch pending/running parts
      // Carve-out: preserve compaction part type unchanged
      return redactToolPart(part)
    })
    return { ...msg, parts: transformedParts }
  })
  
  return {
    messages: transformedMessages,
    transformedTurnCount: 0,  // v7 doesn't drop turns
    exemptTurnCount: 0,
    cacheRefHits: 0,
    cacheRefMisses: 0,
  }
}

function redactToolPart(part: MessageV2.ToolPart): MessageV2.ToolPart {
  if (typeof part.state?.output !== "string") return part
  return {
    ...part,
    state: {
      ...part.state,
      output: `[recall_id: ${part.id}]`,
    },
  }
}
```

The v7 logic preserves all messages (no role-level drops). The TransformResult schema is preserved for back-compat (callers may inspect those fields), but v7 always reports zeros — drop-related fields are vestigial under v7.

### DD-6 — Feature flag `enableDialogRedactionAnchor`

New Tweaks key `compaction.enable_dialog_redaction_anchor`, default `true`. When `false`:
- `tryNarrative` falls back to the legacy `Memory.renderForLLMSync` body source.
- `transformPostAnchorTail` falls back to v6 drop logic.
- `scheduleHybridEnrichment` falls back to legacy thresholds + observed-gate.

This is a single master switch for the entire restoration. Setting `false` reverts the system to pre-fix behaviour atomically. Hot-toggleable via existing `Tweaks` infrastructure (no daemon restart).

### DD-7 — Coordinate with Spec 1 (user-msg-replay-unification)

`serializeRedactedDialog`'s `excludeUserMessageID` parameter is the key seam between the two specs. Both specs use the same `findUnansweredUserMessageId` helper (extracted to a shared module if not already in compaction.ts).

Order of operations within a compaction commit:
1. `tryNarrative` (this spec) builds anchor body, EXCLUDING unanswered user msg from the redacted tail
2. `compactWithSharedContext` writes the anchor message
3. Spec 1's `replayUnansweredUserMessage` helper detects the unanswered user msg pre-anchor, replays it post-anchor with fresh ULID, deletes the original
4. Next iter: filterCompacted returns [anchor + replayed user msg], runloop fires LLM call

This sequencing ensures msg-lost is fully solved across all nine observed conditions, with the user msg appearing exactly once (as a post-anchor stream message), and full prior history available in anchor body.

### DD-8 — `lastTextPartText` reasoning-channel fix

Change [memory.ts:201-207](packages/opencode/src/session/memory.ts#L201-L207):

```ts
// Before:
function lastTextPartText(parts: MessageV2.Part[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === "text") return (p as MessageV2.TextPart).text ?? ""
  }
  return ""
}

// After:
function lastNarrativePartText(parts: MessageV2.Part[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === "text") return (p as MessageV2.TextPart).text ?? ""
    if (p.type === "reasoning") return (p as MessageV2.ReasoningPart).text ?? ""
  }
  return ""
}
```

Rename surfaces all callers' update points (compile-time check). The behaviour becomes: prefer text part if it exists (closer to "model's final answer"), fall back to reasoning part otherwise. Keeps "newer-wins" semantics within parts.

This affects: `Memory.read` turnSummaries derivation (used by `renderForHumanSync` and the legacy-fallback path of `tryNarrative`).

### DD-9 — Persistence and recall flow unchanged

The redacted anchor body uses `recall_id: <part.id>` references. The recall flow is:
1. Model emits `recall_toolcall_raw({part_id: "prt_xxx"})` MCP tool call
2. system-manager router dispatches to `working-cache` handler
3. `working-cache.deriveLedger` walks `Session.messages`, finds part with id `prt_xxx`
4. Returns its `state.output` string

The original tool output stays in `Session.messages` in storage — only the anchor body's representation is redacted. This is critical for recall to work.

**No persistence changes needed**. `working-cache.deriveLedger` already keys on `part.id`. Just verified at compaction.ts inventory phase.

### DD-10 — `compactWithSharedContext` argument threading (cosmetic side-fix)

Pass `observed` argument through `compactWithSharedContext` (currently doesn't receive it). The two bare `publishCompactedAndResetChain(sessionID)` calls (compaction.ts:599, 2761) currently produce `recentEvents.compaction.observed === "unknown"`. Side-fix from Spec 1's DD-5 is restated here for completeness — both specs touch the same call sites.

### DD-11 — Round numbering across recompressed boundary

When recompress overwrites anchor body with an LLM summary, the markdown `## Round N` headers from the original redacted-dialog format are gone. The next extend appends new rounds; what number does Round 1 in the appended segment use?

Two options:
- **A**: continue from where the previous extend left off (parse `## Round N` from the LLM summary if present; fall back to a sentinel scan of the original messages stream).
- **B**: reset to `## Round 1` after recompress.

**Decision**: A. The LLM summary should preserve the `## Round N` markers when produced (we'll instruct the LLM compaction prompt to keep them). If parsing fails, fall back to scanning the latest non-recompressed anchor (or session.execution metadata if we record it).

This is a small DD that may need design refinement during implementation. Capture the open question:

**Open question OQ-1**: should the recompress LLM prompt include "preserve `## Round N` headers" instruction? Or should we tag recompressed anchors with explicit `lastRound` metadata in the CompactionPart? Decide during implementation phase.

## Risks / Trade-offs

### Risks

- **Anchor body grows ~3-4× compared to current narrative output**. Mitigation: 50K ceiling triggers recompress. In a steady-state session, recompress fires every ~100 rounds on average.
- **Tool args serialisation could leak sensitive data into anchor body** (e.g. file paths, API keys passed as tool args). Mitigation: cap args at 500 chars, but that doesn't redact secrets. **Risk accepted** — tool args are model-emitted, treated as part of dialog, same exposure as today's `Memory.renderForLLM` (which doesn't include args either, but the messages stream does). No new exposure surface.
- **Round numbering across recompress boundary** — see OQ-1. If parsing breaks, anchor body could have duplicate round numbers from different extend cycles. Confusion-only, not correctness.
- **Feature flag rollback path complexity**: three independent code paths (tryNarrative / scheduleHybridEnrichment / post-anchor-transform) all check the same flag. If flag is toggled mid-compaction, behaviour could be inconsistent for one compaction cycle. Mitigation: read the flag once at the start of each cycle and pass through.
- **Test fixture maintenance**: post-anchor-transform v6 has 11 tests covering drop scenarios. v7 makes most of these obsolete. We replace them with redaction-coverage tests. Net test count stays ~the same but interpretation changes.

### Trade-offs

- **Markdown vs structured parts**: chose markdown (single text part, no schema change) over multi-part role-alternated representation. Trade: lose native role alternation for the anchor's pre-anchor history (model reads it as a transcript-style text). Gain: zero schema change, simpler implementation, model handles transcript-style fine.
- **Skip floor 5K + ceiling 50K**: chose to keep both rather than collapse to single threshold. Trade: more knobs. Gain: skip floor avoids burning LLM budget on tiny anchors; ceiling forces recompress when actually needed.
- **In-place anchor update for recompress**: chose to overwrite the original anchor's text part (existing behaviour) rather than write a new anchor message. Trade: harder to audit anchor history. Gain: filterCompacted slicing remains stable; no synthetic boundaries.
- **`excludeUserMessageID` opt-in vs opt-out**: chose opt-in (caller must explicitly pass the id). Trade: caller responsibility. Gain: serializer stays purely declarative; testable without snapshot helper as a dependency.

## Critical Files

- [packages/opencode/src/session/compaction.ts:512-680](packages/opencode/src/session/compaction.ts#L512-L680) — `compactWithSharedContext` (anchor write); add `observed` arg threading (DD-10)
- [packages/opencode/src/session/compaction.ts:599](packages/opencode/src/session/compaction.ts#L599) — bare `publishCompactedAndResetChain` (DD-10 fix)
- [packages/opencode/src/session/compaction.ts:872-885](packages/opencode/src/session/compaction.ts#L872-L885) — `INJECT_CONTINUE` table; coordinate with Spec 1's removal
- [packages/opencode/src/session/compaction.ts:959-975](packages/opencode/src/session/compaction.ts#L959-L975) — `tryNarrative` (DD-3 rewrite primary site)
- [packages/opencode/src/session/compaction.ts:1454-1470](packages/opencode/src/session/compaction.ts#L1454-L1470) — `scheduleHybridEnrichment` entry (DD-4 patches)
- [packages/opencode/src/session/compaction.ts:1546-1660](packages/opencode/src/session/compaction.ts#L1546-L1660) — In-place anchor update (no change; reused by codex server-side recompress)
- [packages/opencode/src/session/compaction.ts:2761](packages/opencode/src/session/compaction.ts#L2761) — bare `publishCompactedAndResetChain` in `runLlmCompact` (DD-10 fix)
- [packages/opencode/src/session/memory.ts:201-207](packages/opencode/src/session/memory.ts#L201-L207) — `lastTextPartText` (DD-8 rename + reasoning fix)
- [packages/opencode/src/session/memory.ts:244-289](packages/opencode/src/session/memory.ts#L244-L289) — `renderForLLMSync` (no change; demoted to fallback role)
- [packages/opencode/src/session/post-anchor-transform.ts](packages/opencode/src/session/post-anchor-transform.ts) — v6→v7 (DD-5 entire rewrite)
- [packages/opencode/src/session/working-cache.ts:514-555](packages/opencode/src/session/working-cache.ts#L514-L555) — `deriveLedger` (no change; verifies recall flow at DD-9)
- New file: `packages/opencode/src/session/dialog-serializer.ts` (DD-1, DD-2)
- [packages/opencode/src/util/tweaks.ts](packages/opencode/src/util/tweaks.ts) — register `enable_dialog_redaction_anchor` + `anchor_recompress_ceiling_tokens` keys
- Test files (new): `dialog-serializer.test.ts`, `compaction-extend-redaction.test.ts`, `compaction-recompress-trigger.test.ts`, `compaction-recompress-routing.test.ts`, `post-anchor-transform-v7.test.ts`, `compaction-spec-1-synergy.test.ts`
- [packages/opencode/src/session/compaction-run.test.ts](packages/opencode/src/session/compaction-run.test.ts) — existing test seam reference (`__test__.setAnchorWriter` pattern)
