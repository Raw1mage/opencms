# Proposal: dialog-replay-redaction

## Why

Local compaction has one job, formally stated:

```
extend (every compaction commit, cheap, deterministic):
  anchor[n+1].body = anchor[n].body + serialize_redacted(tail_between(anchor[n], now))

  where serialize_redacted walks parts and substitutes:
    tool.state.output → "recall_id: <part.id>"

recompress (only when anchor body grows too large):
  if estimate_tokens(anchor[n+1].body) > 50_000:
    if provider == codex:
      anchor[n+1].body := await /responses/compact(anchor[n+1].body)
    else:
      anchor[n+1].body := await llm_agent_compact(anchor[n+1].body)
```

The infrastructure for this two-tier model already exists in the codebase. It has been progressively misdirected by a v1→v6 evolution on `post-anchor-transform.ts` and a wrong-target reading of `Memory.renderForLLM`. **This spec is a restoration, not a new feature.** It catalogues the existing pieces, identifies where they diverged from the formal model, and patches the divergence.

The naming "dialog-replay-redaction" captures the corrected mechanism: each compaction extends the anchor by **replaying the dialog** (preserving user/assistant/reasoning/tool_call) while **redacting the tool result payloads** down to recall references. No prose summarization at the extend step; LLM-grade summarization only at the recompress threshold.

### Production motivation

2026-05-09 quantification on session `ses_1f47aa711ffehMSKNf54ZCHFTF`: codex /responses/compact request had 440 input items at 735617 bodyBytes — average 1671 bytes per item. Tool output payloads dominate that bulk; pure dialogue (user msg + assistant text + reasoning + tool_call args) is ~10-20% of the bytes. Redacting the bulk recovers the same item-count compression as the v6 "drop completed assistants" approach, **without** the amnesia regression v5 introduced (which v6 only partially recovered).

### Why upstream codex-rs's "drop everything" was wrongly imitated

[refs/codex/codex-rs/core/src/compact.rs:466-530](refs/codex/codex-rs/core/src/compact.rs#L466-L530) `build_compacted_history` does drop all completed assistants, but it does so **only because** the upstream pipeline produces a high-quality LLM summary via `/responses/compact` to take their place. Three preconditions:

1. `/responses/compact` produces a real LLM-distilled summary
2. Codex backend retains chain state via `previous_response_id`
3. Recall via the chain handles missing detail

The v5 commit (`ac2b34a0b`, 2026-05-08) imitated only the first observable behaviour ("output drops completed assistants") without recreating the three preconditions. Our narrative kind produces a Memory-derived approximation, not an LLM summary; and we explicitly invalidate the codex chain at compaction time. Result: amnesia loop. v6 (`c56e5538f`) partially recovered by keeping current-task tail, but kept the wrong drop target.

The corrected design (this spec) sidesteps the question entirely: don't drop the dialog, just redact the bulky output payloads.

## Inventory of Existing Pieces (盤點)

The two-tier model is already represented in code; these are the pieces:

| Piece | Location | Status |
|-------|----------|--------|
| Anchor primitive (`assistant.summary=true` + `compaction` part) | message-v2 schema | ✅ Correct |
| `Memory.Hybrid.getAnchorMessage` / `findMostRecentAnchorIndex` | memory.ts:391; compaction.ts | ✅ Correct |
| `compactWithSharedContext` anchor write path | compaction.ts:512 | ✅ Correct schema; needs body source change |
| `tryNarrative` (extend kind) | compaction.ts:959 | ⚠️ Wrong body source — derives from Memory.renderForLLMSync, not anchor[n] + redact(tail) |
| `Memory.read` / `renderForLLMSync` / `turnSummaries` | memory.ts:83-289 | ⚠️ Lossy — `lastTextPartText` only takes "last text part", ignores reasoning, drops tool args |
| `lastTextPartText` | memory.ts:201 | ⚠️ Reasoning-blind |
| `working-cache` L2 ledger (recall infra) | working-cache.ts:514 `deriveLedger` | ✅ Correct — derived view over Session.messages, recall by `messageRef + callID` (= part.id) |
| `recall_toolcall_*` MCP tools | system-manager + working-cache | ✅ Correct — `recall_toolcall_raw(part.id)` resolves to original tool output |
| `post-anchor-transform.ts` v6 | full file | ❌ Wrong target — drops prior-task assistants instead of redacting tool payloads |
| `scheduleHybridEnrichment` (recompress kind) | compaction.ts:1454 | ⚠️ Wrong threshold direction (skip-floor only, no ceiling); wrong observed-gate; no provider dispatch |
| `Hybrid.runHybridLlm` (LLM compaction body) | compaction.ts:2105+ | ✅ Correct |
| `tryLowCostServer` (codex /responses/compact plugin) | compaction.ts:1056 | ✅ Correct — used by kind chain today, can be reused by recompress |
| Anchor in-place update on hybrid_llm success | compaction.ts:1546-1660 STEP 3 | ✅ Correct — "土製品" overwritten by "refined" on enrichment success |
| Staleness check (interloper anchor) | compaction.ts:1573-1600 | ✅ Correct — handles concurrent compactions |
| `anchor-prefix-expand.ts` Phase 2 (codex serverCompactedItems) | full file | ✅ Correct — orthogonal; stays |
| `PostCompaction` follow-up table (todolist / subagents) | post-compaction.ts | ✅ Correct — complementary; stays |

**Summary**: 11 pieces correct, 4 pieces need patches (`tryNarrative`, `lastTextPartText`, `post-anchor-transform`, `scheduleHybridEnrichment`). No new mechanisms; this is a refit.

## Original Requirement Wording (Baseline)

- "我們的narrative compaction究竟能不能有效減少itemcount ?"
- "幫我提升narrative compaction的品質"
- "把純對話回合保留下來。就算我跟AI聊了1000個round也沒幾個token"
- "我們的local compaction真的說起來只有一件事：starting from last anchor, replay dialog with payloads replaced by an index to working cache"
- "anchor[n+1] = anchor[n] + tail[ dialogs - payloads + index(payloads) ]; if (anchor > 50K) { if (codex) server-side-compaction else llm-compaction }"
- "我們之前有一個 background refining anchor 的設計應該還在吧"
- "spec 2 只是重新補充之前做過的 local compaction 機制。理論上我們之前都做過了，只是被前面 V1~V6 改壞"

## Requirement Revision History

- 2026-05-09 (initial draft): proposal.md drafted as `narrative-quality`, listed 3 candidate options for prose-continuity improvement
- 2026-05-09 (revised): renamed slug to `dialog-replay-redaction`. User clarified the work is restoration/refit of an existing two-tier design (extend + recompress) that was misdirected by v1-v6 evolution, not a new feature. Three originally proposed options abandoned in favour of the formal model `anchor[n+1] = anchor[n] + redact(tail)` + threshold-triggered recompress.
- 2026-05-10 (v7 retired same day as launch): Production observation showed v7's render-time redaction was a design overreach. Root principle reaffirmed: redaction is a **one-time event** at compaction extend, not a render-time **state**. Post-anchor live tail flows raw; the bounding job belongs to the compaction trigger, not the render layer. v7 the function stays callable as a no-op; spec point 3 amended; render-time redaction logic permanently retired.

## Effective Requirement Description

The compaction subsystem's existing two-tier design — fast extend on every compaction + background recompress when anchor grows large — must be restored to match the formal model:

1. **Extend (`anchor[n+1] = anchor[n] + serialize_redacted(tail)`)**
   - Replace `tryNarrative`'s anchor body source. Today it derives from `Memory.renderForLLMSync`; restore it to `previousAnchor.text + serializeRedactedDialog(messagesAfterPreviousAnchor)`.
   - `serializeRedactedDialog` produces markdown-formatted dialog (user / assistant / reasoning / tool_call rounds) with each `tool.state.output` replaced by `recall_id: <part.id>`.
   - Result: anchor body grows by exactly the redacted tail per compaction, with `recall_id` references resolvable via the existing `recall_toolcall_*` MCP tool family.

2. **Recompress (size-triggered, provider-aware)**
   - `scheduleHybridEnrichment`'s 5K skip-floor is correct — keep.
   - Add a 50K trigger ceiling that **forces** recompress regardless of `observed`.
   - Remove the current `observed in {overflow, cache-aware, manual}` gate at line 1470.
   - At entry, dispatch by provider: codex → `/responses/compact` (the existing `tryLowCostServer` plugin path); else → existing `Hybrid.runHybridLlm` LLM path.
   - On success, the existing in-place anchor update (compaction.ts:1546-1660) overwrites the redacted-dialog body with the LLM-distilled body. The "土製品" → "refined" supersession that's already wired stays.

3. **Post-anchor-transform retired (v6 AND v7)**
   - With anchor body absorbing the prior dialog at extend time, the render layer has no remaining bounding job. Both v6 (drop completed assistants) and v7 (render-time per-tool-part redaction) are retired.
   - v7 stays callable as a pass-through (so dispatch/test surface is stable), but performs no message drops and no output substitution. The live tail between compaction events flows raw.
   - **Why render-time redaction was wrong** (2026-05-10 hotfix):
     - The model needs to read its own just-completed tool output to plan the next step in a multi-step assistant turn. Render-time redaction replaced that output with `[recall_id: ...]` before the next step started, blinding the model.
     - Observed effect: agent saw recall markers it never asked for, called `recall_toolcall_raw` to dereference its own latest tool, or fell back to re-running the same bash/glob — wasting tokens and cycles.
     - Bounding the live-tail token cost is the **compaction trigger**'s job (size threshold fires the next compaction event). It is NOT the render layer's job to pre-empt that decision.
   - Consequence: anchor body remains the single redaction sink. The live tail accumulates raw tool outputs until the next compaction event folds them in.

4. **Memory.read / lastTextPartText / turnSummaries demoted to fallback**
   - These are no longer the source for anchor body. They remain available for `renderForHumanSync` (UI session-list preview, debug dumps) and for the rare cold-start case where no anchor has been written yet.
   - Side-fix: `lastTextPartText` ignores `ReasoningPart`. Update to also accept `type === "reasoning"`. This is correctness-level; affects renderForHumanSync and any other turnSummaries consumer.

5. **PostCompaction follow-up table preserved**
   - The provider-pluggable summary addendum (todolist + active subagents + …) appended to anchor body after extend stays as-is. It complements the redacted dialog with structured runtime state the LLM can't infer from text replay alone.

### Markdown anchor body format

```md
## Round 47

**User**

你能幫我看一下 codex provider 的 ws truncate bug 嗎？

**Reasoning**

先 grep ws_truncation 看分布，再讀 sse.ts 確認 frame_count 處理。判斷邏輯應該在 try/finally 之間...

**Assistant**

好，我來查。

**Tool**: `read({"file":"sse.ts","offset":350,"limit":50})` → `recall_id: prt_e0bb775XYZ`

**Tool**: `grep({"pattern":"frame_count"})` → `recall_id: prt_e0bb776ABC`

**Assistant**

找到原因：frame_count 的 `+=` 在 try block 裡，throw 時計數遺失。修正方案：移到 finally。

## Round 48

**User**

下一題...
```

Per-round overhead: ~8-12 tokens (header + role markers). 1000 rounds ≈ 10-12K tokens of metadata; trivial relative to dialog content.

## Scope

### IN

- New `serializeRedactedDialog` helper (single file, ~80 LOC pure function)
- `tryNarrative` rewrite: input = (prevAnchor, tail messages) instead of Memory.read
- `scheduleHybridEnrichment` modifications: 50K ceiling, observed-gate removal, provider dispatch
- `post-anchor-transform.ts` v6 → v7 (replace drop with redact)
- `lastTextPartText` reasoning-channel fix
- Test fixtures: extend correctness, recompress trigger boundary, codex vs non-codex provider routing, redaction round-trip via recall tools
- Integration tests reproducing the 2026-05-09 production flash-compaction observation, verifying the anchor body actually contains the dialog replay

### OUT

- Restructuring the kind chain (narrative / replay-tail / low-cost-server / llm-agent stay; only narrative's body construction changes)
- Replacing the codex `/responses/compact` plugin (already wired)
- Modifying `anchor-prefix-expand.ts` Phase 2 (codex's structured `serverCompactedItems` path stays orthogonal; expansion still applies when chainBinding matches)
- Changing the working-cache L2 ledger derivation (works as-is; redaction's `recall_id` literally maps to `part.id` which is already the ledger's `messageRef`/`toolCallID` linkage)
- Changing `Memory.Hybrid` namespace (getAnchorMessage / getJournalMessages / pinned-zone APIs all kept)
- Schema migration on `MessageV2` or `CompactionPart`

### Cross-spec coupling

- **Spec `compaction/user-msg-replay-unification` (planned)** stays valid. The user-msg-swallow bug it fixes happens at recompress time (when LLM body replaces the redacted-dialog body); the helper still covers that race window. After this spec lands, the bug surface narrows but doesn't disappear.
- **Spec `compaction/itemcount-fix` (living)** stays orthogonal. Item count discipline at request time is independent of how the anchor body is constructed.
- **Spec `compaction/empty-turn-recovery` (implementing)** stays orthogonal. The classifier and self-heal flow are upstream of compaction.

## Non-Goals

- Not aiming to replace the existing kind chain abstraction.
- Not aiming to make narrative produce LLM-grade summaries — that's recompress's job.
- Not aiming to make recompress synchronous; it stays background-fire-and-forget like today, except that the 50K ceiling case may need to escalate to synchronous if hit DURING compaction commit (TBD in design phase).

## Constraints

- Anchor token cost: redacted-dialog format runs ~3-4× larger than current `lastTextPartText`-only turnSummaries. 100 rounds at ~500 tokens/round ≈ 50K tokens, which **is** the recompress trigger. Implies recompress fires roughly every 100 rounds in active sessions. Acceptable.
- working-cache L2 ledger is derived from `Session.messages`, not separately persisted. The redaction's `recall_id: <part.id>` reference must remain resolvable via that derivation. Verified: `part.id` is the `messageRef` field in `LedgerEntry`; `recall_toolcall_raw(part.id)` resolves correctly.
- AGENTS.md rule 1: every transformation step logs explicitly. No silent fallback.
- Backwards compatibility: existing anchors written before this fix are valid (they have a single text part with the old format). Memory.read still parses them as turnSummaries[0] verbatim, so transition is seamless.
- The existing `enableHybridLlm` Tweaks flag stays. A new flag `enableDialogRedactionAnchor` (default `true`) gates the new tryNarrative behaviour for safe rollout / rollback.

## What Changes

| Component | Action |
|-----------|--------|
| `tryNarrative` (compaction.ts:959) | Replace body construction with redacted-dialog; gated by feature flag |
| `serializeRedactedDialog` (new file `dialog-serializer.ts`) | New helper, pure function |
| `scheduleHybridEnrichment` (compaction.ts:1454) | Add 50K ceiling, remove observed-gate, add provider dispatch |
| `post-anchor-transform.ts` (v6→v7) | Replace drop logic with redact-only logic |
| `lastTextPartText` (memory.ts:201) | Accept `reasoning` part type |
| `Tweaks.compactionSync()` | Add `enableDialogRedactionAnchor`, `anchorRecompressCeilingTokens=50000` |
| Test files | Add 6-8 new fixtures covering extend / recompress boundary / provider routing / redaction round-trip / fallback paths |

No schema changes. No data migration. No external API changes.

## Capabilities

### New Capabilities

- **Redacted-dialog anchor body**: the anchor's text content is the cumulative dialog replay with tool outputs redacted. Model can read its own conversation history verbatim across compactions.
- **Provider-aware recompress dispatch**: codex sessions get free server-side compaction at the 50K ceiling; others use LLM-grade compression.
- **Threshold-driven recompress trigger**: anchor size, not observed condition, drives the recompress decision.

### Modified Capabilities

- `tryNarrative` output shape: still markdown text, but the format is now structured dialog replay instead of free-form turn summaries.
- `post-anchor-transform`: from drop-based to redact-based.
- `Memory.read` / `renderForLLMSync`: demoted from primary anchor body source to UI/diagnostic role + cold-start fallback.

## Impact

- **Affected code**: `compaction.ts` (tryNarrative + scheduleHybridEnrichment), `post-anchor-transform.ts` (v6→v7), `memory.ts` (lastTextPartText), one new file (`dialog-serializer.ts`), `tweaks.ts` (new flags).
- **Affected behaviour**:
  - Model retains full conversation history (text + reasoning + tool args) across compactions
  - Tool result raw payloads no longer inflate the LLM context (already not visible after v6, but now properly recallable on demand)
  - Anchor body grows monotonically until 50K, then recompresses to LLM summary
- **Affected operators**: telemetry surface gains anchor-size + recompress-trigger metrics
- **Affected docs**: `specs/compaction/architecture.md` — narrative kind body construction section update; `specs/architecture.md` cross-cutting compaction section update
- **Risk**: anchor body grows ~3-4× compared to current; sessions with no recompress (codex 429 + non-codex no LLM available) could push token budget. Mitigation: feature flag rollback to old `Memory.renderForLLMSync` body
- **Cross-spec coupling**: Spec `user-msg-replay-unification` still required for recompress race window
