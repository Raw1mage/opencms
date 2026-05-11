---
date: 2026-05-11
summary: "Chapter 10 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D10-1 + D10-2 datasheets"
---

# Chapter 10 audit pass — 12 claims / 12 anchors / SHA 76845d716b / 0 open questions / D10-1 + D10-2 datasheets

## Audit result: PASS

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **4 TYPE** (C1 SessionSource, C2 SubAgentSource, C3 InternalSessionSource, C4 ThreadSource enums) + **2 TEST** (C11 ThreadSpawn end-to-end cross-ref, C12 Internal-MemoryConsolidation). Plus 6 fn / match-arm anchors.
- **Open questions**: 0.

## Datasheets delivered

- **D10-1**: Subagent-variant → wire-identity matrix. 12 rows enumerating every SessionSource variant + its emission of x-openai-subagent / x-codex-parent-thread-id / x-openai-memgen-request across HTTP/WS/Compact paths.
- **D10-2**: Identity inheritance contract (parent → child) at spawn time. Lists 13 fields with inherited / fresh status + source anchors.

## Cross-chapter consolidation finding

This chapter collapses the subagent-conditional fragments scattered across:
- Ch02 C12 (SessionSource at app-server `--session-source` flag)
- Ch03 C4/C5 (Session.installation_id inheritance)
- Ch06 C10 (build_responses_identity_headers + build_subagent_headers)
- Ch08 C5/C12 (build_ws_client_metadata with subagent + parent_thread_id keys)
- Ch09 C7 (compact path identity headers)

Into one matrix (D10-1) that downstream specs can cite directly.

## Audit table

| Cn | Anchor | Kind | Verified |
|---|---|---|---|
| C1 | protocol/src/protocol.rs:2500 | enum | ✓ 8 variants of SessionSource |
| C2 | protocol/src/protocol.rs:2561 | enum | ✓ 5 variants of SubAgentSource incl ThreadSpawn fields |
| C3 | protocol/src/protocol.rs:2554 | enum | ✓ 1 variant InternalSessionSource::MemoryConsolidation |
| C4 | protocol/src/protocol.rs:2516 | enum | ✓ 3 variants ThreadSource + as_str() |
| C5 | core/src/client.rs:1672 | fn | ✓ 5-label canonical map |
| C6 | core/src/client.rs:1684 | match arm | ✓ main-variant None invariant |
| C7 | core/src/client.rs:1693 | fn | ✓ ThreadSpawn-only Some |
| C8 | core/src/client.rs:593 | fn | ✓ memgen flag only on Internal variant |
| C9 | core/src/codex_delegate.rs:65 | fn | ✓ identity inheritance contract verified |
| C10 | core/src/agent/registry.rs:65 | match arm | ✓ depth extract for nesting limit |
| C11 | core/src/client_tests.rs:272 | TEST | ✓ ThreadSpawn label "collab_spawn" + parent_thread_id |
| C12 | core/src/client_tests.rs:260 | TEST | ✓ Internal(MemoryConsolidation) label "memory_consolidation" + memgen flag |

## OpenCode delta — key findings

1. **OpenCode lacks centralised subagent-label mapping** (no `subagent_header_value` equivalent). Caller-controlled label string passed via `subagentLabel` option. **Drift**: backend first-party classification may not match if non-canonical labels used. Worth standardising on the 5 canonical labels.
2. **OpenCode does not emit `x-openai-memgen-request`** — no memory consolidation feature yet. Record for the memory-feature roadmap.
3. **OpenCode emits `x-codex-parent-thread-id` based on caller flag**, not variant constraint. Upstream emits ONLY for ThreadSpawn — OpenCode could over-emit; backend tolerance unknown but worth verifying.
4. **Identity inheritance**: OpenCode inherits installation_id (post `specs/provider/codex-installation-id/` graduation) but inherits services differently (daemon-shared registry vs Arc clones). Functionally equivalent.

## Cumulative spec progress (10/12 chapters audited)

- 120 claims / 120 anchors total
- 12 TEST + 44 TYPE
- 18 datasheets (D2-1, D2-2, D4-1, D4-2, D5-1, D6-1, D6-2, D7-1, D7-2, D8-1..D8-4, D9-1..D9-3, D10-1, D10-2)
- 0 open questions
- All on SHA 76845d716b

## Next

Chapter 11 — Cache & Prefix Model. This is the **synthesis chapter**: how the identity dimensions (installation_id, prompt_cache_key, chatgpt-account-id), wire-body content (driver + bundles + history), and tools surface combine to produce backend prefix-cache behaviour. Will reference the parallel ongoing RCA work on content-parts-shape divergence (subagent OK / main 4608) — that work's findings will inform but not block Ch11. Also covers known cache hazards (openai/codex#20301 GPT-5.5 regression) and the previous_response_id chain semantics from Ch07/Ch08.
