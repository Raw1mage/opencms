# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read `specs/codex_provider_runtime/design.md` (DD-1, DD-2, DD-4) before coding
- Build agent must read `refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs` for protocol behavior
- Materialize tasks.md into runtime todos before coding
- **Phase 1 gate is mandatory**: WS handshake must succeed before proceeding to any other phase

## Required Reads

- implementation-spec.md (this plan)
- specs/codex_provider_runtime/design.md (architectural constraints)
- specs/codex_provider_runtime/spec.md (requirement: Transport extension boundary)
- refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs (832 lines — protocol)
- refs/codex/codex-rs/core/src/client.rs (1823 lines — transport selection / fallback)
- refs/codex/codex-rs/core/tests/suite/client_websockets.rs (24 test cases)
- refs/codex/codex-rs/core/tests/suite/websocket_fallback.rs (4 fallback test cases)

## Current State

- WS transport is DISABLED in codex.ts (comment block at ~line 900)
- HTTP transport works correctly and is the active path
- Previous WS dead code still exists (lines 625-770) — to be replaced
- Diagnostic stderr traces (DIAG) are in place for debugging
- Empty response guard (3-round break + error display) is in prompt.ts
- Error message surfacing is in place for codex HTTP errors

## Stop Gates In Force

- Phase 1: WS handshake must succeed against chatgpt.com
- Bun WS TLS compatibility must be confirmed
- Synthetic SSE bridge must produce parseable output for AI SDK
- No parallel orchestration stack (DD-1, DD-4)

## Build Entry Recommendation

- Start with task 1.1: investigate Bun WebSocket capabilities (TLS, deflate)
- Then task 1.2: minimal `connectWs()` — just establish handshake, log result
- If handshake succeeds: proceed through Phase 1 sequentially (1.3 → 1.8)
- If handshake fails: investigate headers, auth format, TLS config before proceeding
- Phase 2 error parsing (tasks 2.1-2.3) can be developed in parallel since it's pure logic

## Execution-Ready Checklist

- [x] Implementation spec is complete and MVP-first
- [x] Parent spec reference (`specs/codex_provider_runtime/`) is explicit
- [x] Companion artifacts are aligned (proposal, spec, design, tasks)
- [x] IDEF0 functional decomposition available (A0 + 8 modules + 46 leaves)
- [x] GRAFCET state machine available (15 steps + SubGrafcet)
- [x] Prewarm explicitly shelved (Phase 4, not in MVP)
- [x] Validation plan has per-phase gates
- [x] Runtime todo seed in tasks.md (30 active tasks + 4 shelved)
- [x] Stop gates are concrete and actionable
