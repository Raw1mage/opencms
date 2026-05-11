---
date: 2026-05-11
summary: "Chapter 08 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D8-1..D8-4 datasheets + Ch06 delta correction"
---

# Chapter 08 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D8-1..D8-4 datasheets + Ch06 delta correction

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **2 TYPE** (C3 ResponsesWsRequest enum, C4 ResponseProcessedWsRequest struct) + **1 TEST** (C12 build_ws_client_metadata_includes_window_lineage_and_turn_metadata). Plus 1 const-block (C1) and 8 fn-body anchors.
- **Open questions**: 0.

## Datasheets delivered (4 datasheets — the heaviest chapter so far)

- **D8-1**: WS handshake headers (HTTP upgrade request). 13 rows incl OpenAI-Beta + identity + sticky-routing.
- **D8-2**: First WS frame ResponseCreate payload. ResponseCreateWsRequest field-by-field; flags WS-only previous_response_id + generate fields.
- **D8-3**: WS client_metadata shape — 2-5+ keys, **richer than HTTP**. Includes the W3C trace overlay.
- **D8-4**: ResponseProcessedWsRequest ACK shape.

## Critical correction to Chapter 06

Chapter 06's OpenCode delta map flagged "x-codex-window-id in client_metadata" as drift vs upstream's "one-key" rule. Chapter 08 reveals that **upstream WS path also emits x-codex-window-id in client_metadata** (C5, C12 TEST pin both). The "drift" characterisation was HTTP-path-specific. OpenCode primarily uses WS, so the delta is much smaller than initially recorded.

Updated finding: divergence exists only on the OpenCode HTTP fallback path (rarely used). Primary WS path = aligned. Recommend updating `provider_codex-installation-id/` and any future bundle-slow-first work to reflect this.

## Cross-diagram traceability (per miatdiagram §4.7)

Walked:
- core/client.rs::build_websocket_headers → A8.1 → D8-1 ✓
- tokio_tungstenite::connect_async_tls_with_config → A8.2 ✓
- core/client.rs::build_ws_client_metadata → A8.3 → D8-3 (+ TEST C12) ✓
- core/client.rs::prepare_websocket_request → A8.4 → D8-2 previous_response_id ✓
- core/client.rs::stream_responses_websocket → A8.5 → D8-2 ✓
- codex-api/endpoint/responses_websocket.rs::stream_request → A8.6 → forward link to Ch07 D7-1 ✓
- codex-api/common.rs::ResponseProcessedWsRequest → A8.7 → D8-4 ✓

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | core/client.rs:135 | const block | ✓ OPENAI_BETA + responses_websockets=2026-02-06 + /responses path |
| C2 | core/client.rs:890 | fn | ✓ 8 header sources composed |
| C3 | codex-api/common.rs:272 | enum | ✓ 2 variants |
| C4 | codex-api/common.rs:243 | struct | ✓ response_id String |
| C5 | core/client.rs:625 | fn | ✓ always installation_id + window_id; conditionals |
| C6 | codex-api/common.rs:247 | fn | ✓ W3C trace overlay |
| C7 | core/client.rs:1037 | fn | ✓ 3-gate delta-mode decider |
| C8 | core/client.rs:1377 | fn body | ✓ struct-update with client_metadata overlay |
| C9 | codex-api/endpoint/responses_websocket.rs:405 | fn call | ✓ tungstenite WS upgrade |
| C10 | codex-api/endpoint/responses_websocket.rs:248 | fn | ✓ connection_reused flag + cached event seeding |
| C11 | codex-api/endpoint/responses_websocket.rs:155 | const + read | ✓ turn_state read from response.headers |
| C12 | core/src/client_tests.rs:272 | TEST | ✓ 5-key map under subagent+turn_metadata |

## Cumulative spec progress (8/12 chapters audited)

- 96 claims / 96 anchors total
- 8 TEST + 38 TYPE
- 13 datasheets (D2-1, D2-2, D4-1, D4-2, D5-1, D6-1, D6-2, D7-1, D7-2, D8-1, D8-2, D8-3, D8-4)
- 0 open questions
- All on SHA 76845d716b

## Next

Chapter 09 — Compact Sub-Endpoint. Different path (`/responses/compact`), different request type (`ApiCompactionInput`), and the ONE place where `x-codex-installation-id` rides as an HTTP header (mentioned in Ch02 + Ch06 contexts). Smaller scope than Ch08 but pins the cross-chapter "where else does installation_id surface" question.
