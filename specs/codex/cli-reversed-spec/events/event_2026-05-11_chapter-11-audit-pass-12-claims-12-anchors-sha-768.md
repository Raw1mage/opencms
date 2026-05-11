---
date: 2026-05-11
summary: "Chapter 11 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 3 open backend Qs honestly recorded / H1 RCA falsification anchored"
---

# Chapter 11 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 3 open backend Qs honestly recorded / H1 RCA falsification anchored

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12). 11 source-derivable + 1 (C10) empirical-evidence-log anchor.
- **Anchors**: 12.
- **TEST/TYPE diversity**: **3 TYPE** (C1 TokenUsage, C4 LastResponse, C5 WebsocketSession) + **2 TEST** (C11, C12 integration tests).
- **Open backend questions**: **3 acknowledged** — recorded openly in chapter § Open questions. Source cannot answer them; backend cooperation or controlled A/B required.

## Datasheets delivered

- **D11-1**: Client-observable cache state per turn (TokenUsage field-by-field).
- **D11-2**: 16-row cache-affecting dimensions consolidation (Ch02-Ch10 cross-ref).
- **D11-3**: Incremental-mode delta contract (4 gates) (WS path).

## Empirical findings — honestly recorded

This chapter does **not** retreat to "GPT-5.5 server regression dominates". User explicit correction received 2026-05-11 evening: subagent caching works (40448→77824 observed) on the same model + install + backend; the differential must be in client-controllable wire dimensions. Server regression is documented as **one** known hazard, not as the dominant explanation.

**Empirically falsified hypothesis H1** (content-parts cardinality, 2026-05-11 RCA): A/B patch deployed, cache did not improve. Documented in chapter and anchored (C10) so the falsification stays load-bearing for future work and isn't accidentally re-proposed.

**Open question Q1** (subagent-vs-main differential after H1 falsification): kept honest, not papered over. Candidates listed: x-openai-subagent header, AGENTS.md content, tools-list contents, system per-turn extras. Requires further controlled A/B to disambiguate.

## Cross-diagram traceability (per miatdiagram §4.7)

All 8 cross-links verified. TokenUsage → A11.4 → D11-1; prompt_cache_key + client_metadata → A11.1 → D11-2; LastResponse + WebsocketSession + get_incremental_items + items_added → A11.2/A11.5 → D11-3; current_window_id → A11.3; tools dimension cross-ref Ch05 C12 → D11-2 row 8; TEST C11/C12 → D11-3.

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | protocol/protocol.rs:1983 | struct | ✓ TokenUsage 5 fields + helpers |
| C2 | client.rs:742 (cross-ref) | assignment | ✓ pure thread_id |
| C3 | client.rs:625 (cross-ref) | fn | ✓ WS client_metadata composition |
| C4 | client.rs:249 | struct | ✓ LastResponse 2 fields |
| C5 | client.rs:255 | struct | ✓ WebsocketSession 4 fields |
| C6 | client.rs:988 | fn | ✓ strict-extension 4-gate contract |
| C7 | client.rs:1754 | local+push | ✓ items_added accumulation |
| C8 | client.rs:381 | fn | ✓ window_id format `{thread_id}:{window_generation}` |
| C9 | codex-api/common.rs:175 (cross-ref) | struct field | ✓ tools independent dimension |
| C10 | provider_codex-prompt-realign/events/event_2026-05-11_rca-content-parts-shape... | empirical log | ✓ H1 hypothesis + A/B falsification recorded |
| C11 | core/tests/suite/client_websockets.rs:812 | TEST | ✓ previous_response_id re-use across turns |
| C12 | core/tests/suite/client_websockets.rs:1361 | TEST | ✓ get_incremental_items strict-extension end-to-end |

## OpenCode delta — investigation-active findings

- **Q1 differential is active investigation** as of this chapter's audit. Don't speculate beyond source. Candidates still in play after H1 falsification: x-openai-subagent header routing, AGENTS.md content, tools-list, per-turn system extras.
- **incremental-mode failure modes** between upstream's strict-extension contract (C6) and OpenCode's prevLen-based delta computation may differ. Worth a future deep dive if cache lineage analysis surfaces incrementality bugs.
- **All Ch02-Ch10 OpenCode deltas** are consolidated in D11-2 as a single cache-dimension reference. Downstream specs should cite D11-2 when discussing cache impact instead of re-deriving.

## Cumulative spec progress (11/12 chapters audited)

- 132 claims / 132 anchors total
- 14 TEST + 47 TYPE
- 21 datasheets (D2-1, D2-2, D4-1, D4-2, D5-1, D6-1, D6-2, D7-1, D7-2, D8-1..D8-4, D9-1..D9-3, D10-1, D10-2, D11-1, D11-2, D11-3)
- 3 open backend questions (Q1-Q3) honestly recorded; 0 unresolved source-derivable claims
- All on SHA 76845d716b

## Next

Chapter 12 — Rollout & Telemetry. Final chapter. Covers what gets persisted to disk (rollout files) and what gets emitted as OTel / analytics for backend / operator consumption. Smaller scope; closes out the 12-chapter set.
