# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Build agent must read the codex-rs reference files before implementing any phase
- Materialize tasks.md into runtime todos before coding

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md
- idef0.json + diagrams/*.json (functional decomposition)
- grafcet.json (state machine / control flow)
- refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs (832 lines — primary reference)
- refs/codex/codex-rs/codex-api/src/sse/responses.rs (1059 lines — event parsing)
- refs/codex/codex-rs/core/src/client.rs (1823 lines — transport selection, fallback, prewarm)
- refs/codex/codex-rs/core/tests/suite/client_websockets.rs (1818 lines — 24 test cases)
- refs/codex/codex-rs/core/tests/suite/websocket_fallback.rs (242 lines — 4 fallback test cases)

## Current State

- WS transport is DISABLED in codex.ts (lines 900-904)
- HTTP transport works correctly and is the active path
- Previous WS attempt code still exists but is dead code (lines 625-770)
- Diagnostic traces (stderr DIAG) are in place for debugging
- Empty response guard (3-round break) is in place in prompt.ts
- Error message surfacing is in place for empty responses

## Stop Gates In Force

- Phase 1 gate: WS handshake must succeed before any other phase
- chatgpt.com endpoint auth format must match codex-rs expectations
- Bun permessage-deflate support must be confirmed or `ws` package adopted
- V2 prewarm rejection by server → skip Phase 5

## Build Entry Recommendation

- Start with Phase 1 (WS Connection Layer) — specifically task 1.1 (deflate investigation) and task 1.2 (CodexWsConnection class)
- Validate Phase 1 with a minimal connection test against chatgpt.com before proceeding
- Phase 2 (Error Parsing) can be developed in parallel with Phase 1 since it's pure logic with no external dependencies
- Phases 3-8 are sequential and depend on Phase 1 success

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned (proposal, spec, design, tasks)
- [x] IDEF0 functional decomposition complete (A0 + A1-A8 + 46 leaf activities)
- [x] GRAFCET state machine complete (15 steps + 6-step SubGrafcet for stream loop)
- [x] Validation plan is explicit (8 phase gates + 9 acceptance checks)
- [x] Runtime todo seed is present in tasks.md (46 tasks across 8 phases)
- [x] Reference source files identified and accessible in refs/codex/
- [x] Test cases identified (24 WS tests + 4 fallback tests from codex-rs)
