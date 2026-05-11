# Design: compaction_recall-affordance

## Context

When opencode's narrative compaction path runs (triggered by rebind from rate-limit rotation, daemon restart, or paralysis self-heal), pre-anchor tool results collapse into an LLM-generated prose summary stored in the anchor message body. The AI receives this prose summary as its memory of the past, but has no way to: (a) tell which tool results are stubs vs. live in journal, (b) address specific past tool calls by id, (c) retrieve original tool output content.

Code audit findings (2026-05-12 incident):
- `Memory.Hybrid.recallMessage` exists but is internal-only — no AI-facing tool wraps it.
- `OverrideParser` auto-recall (per memory.ts:495 comment) was never implemented (`grep -rln "OverrideParser"` → empty).
- `buildUserPayload` instructs the LLM to produce prose anchor body; no requirement to retain tool_call_id index.

Result: production AI loops re-doing tool calls it already did, because it cannot tell its prior outputs are gone and has no recall mechanism. Captured as 跳針 in production session `ses_1e8cbd779ffezUjDVUZXBvwkqy` (debug.log 2026-05-12 04:14–04:25).

This design fixes the affordance gap in three independent layers (L1 anchor format, L2 tool exposure, L3 system notice) that together close the loss-creating path.

## Goals / Non-Goals

### Goals

- AI must be able to retrieve any prior tool output by `tool_call_id` after narrative compaction.
- AI must be told when its tool history is narrative-compacted so it learns to use recall.
- Narrative anchors must remain addressable — `tool_call_id` is a recoverable handle, not a discarded artifact.
- Provider-agnostic: works for codex (when server-side compaction is unavailable), anthropic, openai.
- Backward-compatible: existing anchors lacking TOOL_INDEX degrade gracefully without crashing.

### Non-Goals

- Lowering compaction predicate threshold (Bug A from incident — separate plan).
- Capping narrative anchor body size (Bug C from incident — separate plan).
- Preserving post-anchor reasoning journal across rebind (Bug B partial — recall affordance subsumes the recovery channel; structural fix deferred).
- Auto-recall (model-bypassing) heuristics — recall is explicit and AI-invoked.
- Cross-session recall for subagent-parent flows — out of scope for v1, existing `read_subsession` covers this surface.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| LLM ignores TOOL_INDEX instruction (anchor body lacks the section) | Post-write `validateToolIndex` emits `compaction.tool_index.missing` telemetry; L3 system note adapts wording to "infer ids from narrative"; tool still works for guessed ids |
| TOOL_INDEX bloats anchor beyond budget for sessions with thousands of pre-anchor tool calls | INV-6 size ceiling: truncate oldest entries beyond `targetTokens * 0.1`; emit `truncated_count` field |
| Recall scan is O(n) over Session.messages stream — slow for huge sessions | Acceptable for v1; n is bounded by session message count. Future: index by callID at write time if hot. |
| AI over-uses recall (calls it unnecessarily for in-journal callIDs) | `redundant=true` metadata + log; soft signal for prompt-engineering follow-up |
| New tool description adds tokens to every build-agent turn | Tool description capped ≤500 chars; net cost ≤150 tokens per turn vs. immeasurable cost of 跳針 |
| Amnesia notice block adds tokens to every post-narrative turn | Block content kept ≤500 chars; cumulative over the anchor's lifetime; bounded by next-anchor supersession |

## Critical Files

- `packages/opencode/src/session/compaction.ts` — L1 lives here (buildUserPayload + defaultWriteAnchor + validateToolIndex)
- `packages/opencode/src/session/memory.ts` — `Memory.Hybrid.recallByCallId` extension
- `packages/opencode/src/tool/recall.ts` — new L2 tool definition
- `packages/opencode/src/tool/registry.ts` — RecallTool registration
- `packages/opencode/src/session/prompt.ts` — L3 amnesia notice injection adjacent to existing block assembly
- `packages/opencode/src/session/message-v2.ts` — possibly need to add `kind` field to anchor message metadata for L3 trigger (open question Q1 in handoff.md)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Provider-agnostic compaction pipeline                          │
│                                                                  │
│  ┌────────────────┐    ┌──────────────────┐    ┌─────────────┐ │
│  │ rebind trigger │ →  │  narrative       │ →  │  anchor     │ │
│  │ (rotation /    │    │  compaction      │    │  message    │ │
│  │ restart /      │    │  (kind=          │    │  (summary=  │ │
│  │ paralysis)     │    │  narrative)      │    │  true)      │ │
│  └────────────────┘    └──────────────────┘    └─────────────┘ │
│                              │                       │          │
│                              ▼                       │          │
│              [L1] buildUserPayload emits             │          │
│              ## TOOL_INDEX section with              │          │
│              (tool_call_id, name, args, status,      │          │
│               output_chars) for every pre-anchor     │          │
│              tool call.                              │          │
│                                                      ▼          │
│                                            ┌──────────────────┐ │
│                                            │ [L3] prompt.ts   │ │
│                                            │ injects system   │ │
│                                            │ note when next   │ │
│                                            │ turn sees the    │ │
│                                            │ narrative anchor │ │
│                                            └──────────────────┘ │
│                                                      │          │
│                                                      ▼          │
│                                            ┌──────────────────┐ │
│                                            │ AI calls         │ │
│                                            │ [L2] recall(id)  │ │
│                                            │ tool when        │ │
│                                            │ needed           │ │
│                                            └──────────────────┘ │
│                                                      │          │
│                                                      ▼          │
│                              ┌────────────────────────────────┐ │
│                              │ Memory.Hybrid.recallByCallId   │ │
│                              │ scans message stream for       │ │
│                              │ ToolPart.callID == arg         │ │
│                              │ returns original output        │ │
│                              └────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

The three layers are independent components but share one invariant: **a `tool_call_id` emitted in TOOL_INDEX must be resolvable by `recall`**. This is verified by `wiki_validate` drift detection (Phase B; out of scope for initial cut).

## Decisions

- **DD-1**: TOOL_INDEX is emitted in the anchor body, not as separate metadata, because the anchor body is the only thing the LLM sees on the next turn — separate metadata would not affect inference. Format is a fenced-table after the prose narrative so providers that strip code fences still see plain text fallback.
- **DD-2**: Recall is an explicit AI-invoked tool, not an automatic prompt-side override. Rationale: auto-recall (the never-implemented OverrideParser) is fragile — it requires parsing the model's free-form output, races with tool-call generation, and silently injects content the model didn't ask for. Explicit recall is deterministic, observable, and reuses the existing tool-call permission machinery.
- **DD-3**: `recall` returns the original tool output as a text block, NOT as a synthesized ToolPart. The model already knows what tool was called (from the TOOL_INDEX); what it lacks is the content. Returning text avoids reasoning-chain confusion ("did I just call this tool now?").
- **DD-4**: `Memory.Hybrid.recallMessage` is extended (not replaced) with a sibling `recallByCallId(sessionID, callID) → ToolPart | null` function. Existing API stays for the subagent-recall use case (which still uses msgId).
- **DD-5**: L3 system note is injected only when the most recent anchor's `kind === "narrative"`. Server-side compaction (kind=4 / hybrid_llm enriched) skips L3 because those paths preserve content via provider-side mechanisms.
- **DD-6**: Recall scope is intra-session only for v1. Cross-session recall (subagent-parent) follows existing recallMessage signature and is not exposed in the new tool. Rationale: avoids leaking authority boundaries; subagent results already surface via `read_subsession`.
- **DD-7**: Idempotency: if recall is called twice with the same id in the same session, both calls succeed with the same payload — no caching, no de-dup. Cost is one O(n) message scan per call; n is bounded by session size and the scan is in-memory.
- **DD-8**: TOOL_INDEX emission failures (LLM produces anchor body without the section) downgrade gracefully: anchor still persists; L3 system note still fires but instructs the model to use recall by guessing tool_call_ids from the narrative. A telemetry event `compaction.tool_index.missing` fires for ops visibility.
- **DD-9**: Tool registration: `RecallTool` is unconditionally registered in the build agent's catalog (no feature flag). Rationale: backward-compatible (provider-agnostic), low token cost (~150 chars of tool description), no opt-in friction. If we later need to gate it, a Tweaks flag can be added without touching call sites.
- **DD-10**: System-note text is short and imperative, not a system prompt rewrite. Insert as a synthetic user message OR a `system_block` before the user turn; choose the latter to match the existing prompt-block convention ([prompt.ts blocks structure](packages/opencode/src/session/prompt.ts)).

## Code anchors

- `packages/opencode/src/session/compaction.ts:3120-3168` — `buildUserPayload`, where TOOL_INDEX instruction is inserted into the prompt template.
- `packages/opencode/src/session/compaction.ts:2581-2660` — `defaultWriteAnchor`, where post-write validation (DD-8 telemetry) hooks in.
- `packages/opencode/src/session/memory.ts:499-508` — `Memory.Hybrid.recallMessage`, sibling `recallByCallId` added here.
- `packages/opencode/src/session/memory.ts:384-509` — `Memory.Hybrid` namespace, scope for new accessor.
- `packages/opencode/src/session/prompt.ts:1980-2036` — `applyStreamAnchorRebind` block, post-rebind system-note injection adjacent to this.
- `packages/opencode/src/tool/recall.ts` (new) — `RecallTool` definition using `Tool.define` pattern (see `packages/opencode/src/tool/reread-attachment.ts:90-167` as template).
- `packages/opencode/src/tool/registry.ts:147` — registration site for `RecallTool` (added next to `RereadAttachmentTool` since both are voucher-style recovery tools).

## Submodule refs

None. This change is entirely within `packages/opencode/src/`.

## External contracts

- **Compaction telemetry** (existing): adds `compaction.tool_index.{emitted,missing}` events. Schema is `{sessionID, kind, anchorId, indexEntryCount, indexBytes}`. Out-of-band consumers (UI, KB) unchanged.
- **Tool registry**: `RecallTool` joins the unconditional set returned by `registry.all()`. No version negotiation needed; new tool is purely additive.
- **Prompt blocks**: L3 system note follows the existing block convention (`system_block_0`, `bundle_developer`, `bundle_user`, etc. seen in telemetry). New block id: `system_block_amnesia_notice` with `policy: "session_stable_until_next_anchor"`.

## Failure modes

- **LLM ignores TOOL_INDEX instruction**: anchor body lacks the section → DD-8 telemetry → L3 note prompts "tool_call_ids may not be addressable; try recall with ids inferred from narrative" → recall fails with `unknown_call_id` if guess is wrong → AI falls back to re-running tool.
- **recall called with id not in stream**: returns `{ error: "unknown_call_id", message: "Tool call <id> not found in this session's history." }` with explicit instruction to re-execute the original tool.
- **recall on post-anchor (still-live) tool call**: succeeds, returns the same output that's already in journal. Wasteful but harmless. Telemetry tags `redundant=true`.
- **System note race with provider-switch**: L3 only fires when narrative is the anchor kind; switching providers mid-turn doesn't re-fire the note (anchor doesn't change). Acceptable: the model has the note from the prior turn already in cached prompt.
