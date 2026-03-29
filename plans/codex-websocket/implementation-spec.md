# Implementation Spec

## Goal

- Faithfully reproduce codex-rs WebSocket transport in TypeScript, enabling persistent WS connections with incremental delta, prewarm, structured error parsing, and session-scoped HTTP fallback.

## Scope

### IN

- WS connection layer (permessage-deflate, TLS, headers, ping/pong, idle timeout)
- WrappedWebsocketErrorEvent parsing (connection_limit, usage_limit, transport errors)
- Stream handler (frame parse loop, event emission, synthetic SSE bridge)
- Session-scoped transport selection (WS-first, sticky HTTP fallback)
- V2 prewarm (generate=false)
- Incremental delta (previous_response_id, prefix detection, cache eviction)
- Error recovery (retry budget, auth recovery, 426 fallback)

### OUT

- Realtime API / audio WebSocket
- `/responses/compact` over WS
- Multi-connection multiplexing
- Modifying AI SDK chunk parsing internals

## Assumptions

- Bun's WebSocket supports permessage-deflate (or `ws` npm package can be used as fallback)
- chatgpt.com WS endpoint accepts the same auth headers as codex-rs (Bearer token + chatgpt-account-id)
- The `OpenAI-Beta: responses_websockets=2026-02-06` header is required for V2 features
- AI SDK can consume synthetic SSE Response objects without modification

## Stop Gates

- If Bun WebSocket cannot establish TLS connection to chatgpt.com at all → investigate transport-level issues before proceeding
- If chatgpt.com WS endpoint requires auth format different from codex-rs → stop and reverse-engineer from network traces
- If V2 prewarm (generate=false) is rejected by server → skip Phase 5, proceed without prewarm
- If incremental delta causes request failures → disable delta, use full requests only

## Critical Files

- `packages/opencode/src/plugin/codex-websocket.ts` — new file: WS connection, error parsing, stream handler
- `packages/opencode/src/plugin/codex.ts` — fetch interceptor modification for WS transport selection
- `packages/opencode/src/session/llm.ts` — codexSessionState integration
- `refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs` — primary reference (832 lines)
- `refs/codex/codex-rs/codex-api/src/sse/responses.rs` — event parsing reference (1059 lines)
- `refs/codex/codex-rs/core/src/client.rs` — transport selection reference (1823 lines)

## Structured Execution Phases

- Phase 1 (WS Connection Layer): Establish connection with correct headers, TLS, deflate. Verify handshake succeeds against chatgpt.com. This is the gate for all subsequent phases.
- Phase 2 (Error Parsing): Implement WrappedWebsocketErrorEvent classification. Port 5 test cases from codex-rs. Must pass before wiring into stream handler.
- Phase 3 (Stream Handler): Implement full frame receive loop with error-first parsing, event emission, idle timeout. Return synthetic SSE Response. Verify AI SDK can consume output.
- Phase 4 (Transport Selection): Wire WS into fetch interceptor. Implement session-scoped caching, account-aware lifecycle, sticky HTTP fallback. Verify fallback works when WS fails.
- Phase 5 (Prewarm): Implement generate=false optimization. Non-blocking — failure falls through. Verify connection reuse after prewarm.
- Phase 6 (Incremental Delta): Implement prefix detection, delta input, previous_response_id. Verify reduced input items on second turn.
- Phase 7 (Retry & Recovery): Implement budget-limited retry, auth recovery, 426 handling. Port fallback test cases from codex-rs.
- Phase 8 (Integration Testing): End-to-end tests against live chatgpt.com endpoint with real accounts.

## Validation

- Phase 1: `new CodexWsConnection().connect()` succeeds against chatgpt.com, handshake headers captured
- Phase 2: 5 error parsing test cases pass (from responses_websocket.rs tests)
- Phase 3: Send "Say hello" → receive text delta events → Completed event with response_id and token usage
- Phase 4: WS failure → automatic HTTP fallback → session continues working
- Phase 5: Prewarm request → Completed → next request reuses connection + response_id
- Phase 6: Second turn sends fewer input items than first turn (delta mode confirmed in logs)
- Phase 7: Connect failure × 3 → HTTP fallback activates → request succeeds via HTTP
- Phase 8: Full multi-turn conversation over WS with account rotation, error recovery, and fallback

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts (proposal.md, spec.md, design.md, tasks.md) before coding.
- Build agent must read the codex-rs reference files (responses_websocket.rs, client.rs, responses.rs) before implementing.
- Build agent must materialize runtime todo from tasks.md.
- Build agent must verify Phase 1 (connection handshake) before proceeding to any other phase.
