---
date: 2026-05-11
summary: "Chapter 09 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D9-1 + D9-2 + D9-3 datasheets"
---

# Chapter 09 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D9-1 + D9-2 + D9-3 datasheets

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **2 TYPE** (C2 CompactionInput struct, C8 CompactHistoryResponse struct) + **2 TEST** (C11 Azure gate test, C12 path-pinning test). Plus 1 const (C1) and 7 fn/fn-body anchors.
- **Open questions**: 0.

## Datasheets delivered

- **D9-1**: `CompactionInput<'a>` body — 9 fields, subset of ResponsesApiRequest (drops tool_choice, store, stream, include, client_metadata).
- **D9-2**: Compact-specific HTTP headers — uniquely includes `x-codex-installation-id` as HTTP header (the ONE place upstream does this). Drops `x-codex-turn-state`, `x-codex-turn-metadata`, OpenAI-Beta (WS-only).
- **D9-3**: `CompactHistoryResponse` shape — `{ output: Vec<ResponseItem> }` unary response.

## Key cross-cutting finding

The compact endpoint is the **ONE place upstream codex-cli emits `x-codex-installation-id` as an HTTP header**. Streaming HTTP (Ch06 C3) and WS (Ch08 C5) both put it in `client_metadata` body. This is documented as a load-bearing fact for any future spec that touches installation_id placement — confirms that the header-form is NOT a general rule but is endpoint-specific to compact.

## OpenCode delta — architectural divergence (by design)

OpenCode **does not use** `/responses/compact`. Instead, OpenCode declares `context_management: [{ type: "compaction", compact_threshold }]` inline on every Responses request body (server-side inline compaction). Functionally equivalent to upstream's separate endpoint, architecturally divergent.

Implications:
- OpenCode never enters the C6 code path → `x-codex-installation-id` HTTP header form is unused by OpenCode entirely.
- Compaction behaviour observations on OpenCode are governed by server interpretation of `context_management`, not by the compact endpoint mechanics in this chapter.
- The Ch06 OpenCode delta map noted `context_management` as OpenCode-only; Chapter 09 confirms the equivalence direction.

## Cross-diagram traceability (per miatdiagram §4.7)

Walked all 8 links — all green:
- RESPONSES_COMPACT_ENDPOINT (C1) + compact_conversation_history (C5) → A9.1, A9.4 → D9-1/D9-2 ✓
- CompactionInput (C2) → A9.2 → D9-1 ✓
- compact_input fn (C3) + path (C4) → A9.4 ✓
- CompactHistoryResponse (C8) → A9.5 → D9-3 ✓
- compact_conversation_history lines 487-503 (C6, C7) → A9.3 → D9-2 ✓
- RemoteCompactionV2 (C10) → A9.1 ✓
- Azure-provider gate TEST (C11) → A9.1 ✓
- path-pinning TEST (C12) → D9-1 ✓

## Cumulative spec progress (9/12 chapters audited)

- 108 claims / 108 anchors total
- 10 TEST + 40 TYPE
- 16 datasheets (D2-1, D2-2, D4-1, D4-2, D5-1, D6-1, D6-2, D7-1, D7-2, D8-1..D8-4, D9-1..D9-3)
- 0 open questions
- All on SHA 76845d716b

## Next

Chapter 10 — Subagents. The four SubAgentSource variants (Review / Compact / MemoryConsolidation / ThreadSpawn) and their wire-shape implications: x-openai-subagent label values, x-codex-parent-thread-id presence, window_id propagation, x-openai-memgen-request flag. Cross-references Chapters 02, 06, 08 where subagent-conditional behaviour was flagged.
