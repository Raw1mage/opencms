---
date: 2026-05-11
summary: "Chapter 06 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D6-1 + D6-2 datasheets"
---

# Chapter 06 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D6-1 + D6-2 datasheets

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **2 TYPE** (C7 Reasoning, C8 TextControls) + **1 TEST** (C12 build_subagent_headers_sets_other_subagent_label). Plus 1 constants-block (C9) + 6 fn-body anchors. Sufficient.
- **Open questions**: 0.

## Datasheets delivered

- **D6-1**: Full `ResponsesApiRequest` body (14 fields tabulated). Each field has source file:line + stability + notes. Anchor for downstream specs that need to know what bytes leave codex.
- **D6-2**: Per-turn HTTP headers (streaming path). 16 rows covering: Authorization, User-Agent, originator, ChatGPT-Account-Id, X-OpenAI-Fedramp (Ch02 carry-over), session_id/session-id/thread_id/thread-id pairs, x-client-request-id, x-codex-beta-features, x-codex-turn-state, x-codex-turn-metadata, x-codex-window-id, x-codex-parent-thread-id, x-openai-subagent, x-openai-memgen-request, x-oai-attestation. Plus the critical "x-codex-installation-id NOT in headers on streaming path" row pointing to body's client_metadata.

## Cross-diagram traceability (per miatdiagram §4.7)

Walked all 6 links:
- build_responses_request → A6.1/A6.2/A6.3 → D6-1 ✓
- build_responses_identity_headers → A6.4 → D6-2 (window + parent_thread + subagent) ✓
- build_subagent_headers → A6.4 → D6-2 (subagent + memgen) ✓
- stream_request → A6.5 → D6-2 (x-client-request-id + session/thread pairs) ✓
- ResponsesApiRequest struct → D6-1 outer shape ✓
- X_CODEX_* constants → D6-2 header name registry ✓

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | core/src/client.rs:708 | fn | ✓ build_responses_request signature + 14 fields |
| C2 | core/src/client.rs:742 | assignment | ✓ pure thread_id, no mix-in |
| C3 | core/src/client.rs:759 | assignment | ✓ one-key HashMap with installation_id |
| C4 | core/src/client.rs:753 | assignment | ✓ Azure-only true |
| C5 | core/src/client.rs:754 | assignment | ✓ stream=true hard-coded |
| C6 | core/src/client.rs:721 | conditional | ✓ include opt-in for reasoning replay |
| C7 | codex-api/src/common.rs:113 | struct | ✓ Reasoning shape confirmed |
| C8 | codex-api/src/common.rs:143 | struct | ✓ TextControls + TextFormat shapes |
| C9 | core/src/client.rs:136 | constants block | ✓ 7 header constants enumerated |
| C10 | core/src/client.rs:612 | fn | ✓ identity headers compose subagent + parent + window |
| C11 | codex-api/endpoint/responses.rs:70 | fn | ✓ x-client-request-id + build_session_headers + subagent_header |
| C12 | core/src/client_tests.rs:248 | TEST | ✓ subagent label header assertion |

## Key OpenCode drift findings (recorded in delta map)

1. **`x-codex-window-id` is in OpenCode's `client_metadata`** — upstream emits it as HTTP header only. Extra body-side key vs upstream's "one key" rule. Future ticket if backend keying surfaces.
2. **OpenCode emits underscore-only session/thread headers** — upstream emits both underscore AND hyphen forms (via build_session_headers). Backend tolerance unknown; low risk.
3. **`context_management` field is OpenCode-only** — by-design choice (server-side inline compaction vs upstream's Compact sub-endpoint, Ch09). Documented; not a regression target.
4. **Wire body shape otherwise aligned** — D6-1's 14 fields map cleanly between codex-cli and opencode-codex-provider.

## Cumulative spec progress (6/12 chapters audited — halfway)

- 72 claims / 72 anchors total
- 6 TEST + 24 TYPE
- 7 datasheets (D2-1, D2-2, D4-1, D4-2, D5-1, D6-1, D6-2)
- 0 open questions across all chapters
- All on SHA 76845d716b

## Next

Chapter 07 — HTTP SSE Transport. Lighter content (transport mechanics: endpoint URL, retry, previous_response_id chain, SSE event parsing). The wire-body content has been audited; Chapter 07 is about how the bytes leave.
