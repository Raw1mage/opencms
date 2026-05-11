---
date: 2026-05-11
summary: "Chapter 12 audit pass — 12 claims / 12 anchors / FINAL CHAPTER — 144 anchors total, ready for graduation"
---

# Chapter 12 audit pass — 12 claims / 12 anchors / FINAL CHAPTER — 144 anchors total, ready for graduation

## Audit result: PASS — FINAL CHAPTER

- **Submodule SHA pinned**: `76845d716b720ca701b2c91fec75431532e66c74` (unchanged across all 12 chapters).
- **Claims**: 12 (C1–C12).
- **Anchors**: 12.
- **TEST/TYPE diversity**: **7 TYPE** (C1 RolloutItem enum, C2 SessionMetaLine, C3 CompactedItem, C4 TurnContextItem, C5 RolloutRecorder, C6 RolloutCmd, C9 AttestationProvider trait) + **1 TEST** (C12 state_db_init_backfills_before_returning). Plus 1 module re-exports anchor (C8), 1 use-import (C7), 1 cross-ref (C11), 1 module ref (C10).
- **Open questions**: 0 source-derivable.

## Datasheets delivered

- **D12-1**: Rollout `.jsonl` file format (5 RolloutItem variants, path convention).
- **D12-2**: Persisted-item filter (`policy::is_persisted_rollout_item`).
- **D12-3**: AttestationProvider trait + `x-oai-attestation` header boundary.

## Spec graduation readiness

**The reversed-spec is complete.** 12/12 chapters audited; 144 claims / 144 anchors; 24 datasheets; 15 TEST + 53 TYPE anchors; 0 unresolved source-derivable claims; 3 open backend questions honestly recorded; 1 empirically falsified hypothesis (H1 content-parts cardinality) anchored to prevent re-proposal.

Ready for user-triggered `plan_graduate` to move from `/plans/codex_cli-reversed-spec/` to `/specs/codex/cli-reversed-spec/`.

## Final cumulative table (per chapter)

| Ch | Title | Claims | TEST | TYPE | Datasheets |
|---|---|---|---|---|---|
| 01 | Entry Points & Process Bootstrap | 12 | 1 | 2 | — |
| 02 | Auth & Identity | 12 | 2 | 6 | D2-1, D2-2 |
| 03 | Session & Turn Lifecycle | 12 | 0 | 8 | N/A |
| 04 | Context Fragment Assembly | 12 | 1 | 6 | D4-1, D4-2 |
| 05 | Tools & MCP | 12 | 1 | 7 | D5-1 |
| 06 | Responses API Request Build | 12 | 1 | 2 | D6-1, D6-2 |
| 07 | HTTP SSE Transport | 12 | 1 | 2 | D7-1, D7-2 |
| 08 | WebSocket Transport | 12 | 1 | 2 | D8-1 to D8-4 |
| 09 | Compact Sub-Endpoint | 12 | 2 | 2 | D9-1, D9-2, D9-3 |
| 10 | Subagents | 12 | 2 | 4 | D10-1, D10-2 |
| 11 | Cache & Prefix Model | 12 | 2 | 3 | D11-1, D11-2, D11-3 |
| 12 | Rollout & Telemetry | 12 | 1 | 7 | D12-1, D12-2, D12-3 |
| **Σ** | | **144** | **15** | **53** | **24** |

## Cross-cutting findings preserved for downstream specs

- **H1 falsification** anchored: content-parts cardinality is NOT the subagent-vs-main cache differential. Future RCAs MUST NOT re-propose without new evidence.
- **3 open backend questions** (Q1 subagent-vs-main differential after H1 falsified; Q2 client_metadata cardinality keying; Q3 previous_response_id TTL) acknowledged and unresolved at source level — require backend cooperation or controlled A/B.
- **Three OpenCode wire-shape findings** during this work, recorded in delta maps:
  1. `X-OpenAI-Fedramp` header gap (Ch02) — OpenCode does not parse `chatgpt_account_is_fedramp` JWT claim.
  2. Underscore-only session/thread headers (Ch06) — OpenCode misses upstream's dash-form mirror emission.
  3. `context_management` field is OpenCode-only (Ch06/Ch09) — by-design architectural divergence vs upstream's compact endpoint.
- **Bundle-slow-first refinement** (`plans/provider_codex-bundle-slow-first-refinement/`) resume gate satisfied per Ch04 findings; L3 split justifiable, L6 currentDate split rejected (upstream byte alignment).
- **Subagent caching differential** remains an active investigation question; downstream RCA work to use D11-2 cache-dimension consolidation as starting point instead of re-deriving.

## Next

Pending user-triggered:
1. **Commit** the 12-chapter spec (split code vs docs per `feedback_commit_all_split_code_docs.md`).
2. **Graduate** the spec via `plan_graduate` to `/specs/codex/cli-reversed-spec/`.

The reviewer (this agent) will not auto-commit or auto-graduate per AGENTS.md zone contract.
