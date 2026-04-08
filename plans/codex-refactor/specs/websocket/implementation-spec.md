# Implementation Spec

## Goal

- Implement Codex WebSocket as a transport adapter beneath the AI SDK contract, enabling persistent connections with error classification, session-scoped fallback, and (later) incremental delta.

## Parent Spec

`specs/codex/provider_runtime/` — DD-1 (AI SDK is authority), DD-2 (providerOptions + interceptor split), DD-4 (WS is extension surface, not parallel stack).

## Scope

### IN

- WS connection to chatgpt.com with correct auth/headers
- Error event parsing (WrappedWebsocketErrorEvent)
- Stream handler with idle timeout and synthetic SSE bridge
- Session-scoped transport selection with sticky HTTP fallback
- Account-aware connection lifecycle
- (Phase 3) Incremental delta

### OUT

- Prewarm (shelved)
- AI SDK internals modification
- Parallel orchestration stack
- Telemetry/model-etag tracking (future)

## Assumptions

- chatgpt.com WS endpoint accepts Bearer token + chatgpt-account-id headers (same as codex-rs)
- Bun WebSocket can establish TLS connections to chatgpt.com (deflate optional)
- AI SDK can consume synthetic SSE Response objects without modification (already proven by previous attempt)
- `OpenAI-Beta: responses_websockets=2026-02-06` header is required (from codex-rs)

## Stop Gates

- Phase 1 gate: if WS handshake cannot succeed against chatgpt.com after investigating auth/headers/TLS → stop, keep HTTP
- If Bun WebSocket fundamentally incompatible → evaluate `ws` npm package; if that also fails → stop
- If synthetic SSE bridge causes AI SDK parsing failures → stop, debug SSE format

## Critical Files

- `packages/opencode/src/plugin/codex-websocket.ts` — new file
- `packages/opencode/src/plugin/codex.ts` — transport selection in fetch interceptor
- `refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs` — protocol reference
- `refs/codex/codex-rs/core/src/client.rs` — transport selection reference
- `specs/codex/provider_runtime/design.md` — architectural constraints

## Structured Execution Phases

- Phase 1 (MVP: Prove WS Works): Minimal WS handshake + single request + synthetic SSE → AI SDK gets a response. No caching, no delta, no retry. Just prove the transport path works end-to-end.
- Phase 2 (Production Hardening): Error parsing (WrappedWebsocketErrorEvent), session-scoped caching, account-aware lifecycle, idle timeout, sticky HTTP fallback, retry budget.
- Phase 3 (Incremental Delta): previous_response_id capture, prefix detection, delta input trimming, cache eviction on errors.
- Phase 4 (Shelved — Prewarm): generate=false optimization. Only if Phases 1-3 are stable and user explicitly requests.

## Validation

- Phase 1: Send "Say hello" over WS → receive text output in UI → verify via daemon stderr trace
- Phase 2: Simulate WS error → verify HTTP fallback activates → verify next turn stays HTTP → verify account rotation triggers reconnect
- Phase 3: Second turn sends fewer input items than first turn (confirmed via DIAG trace) → previous_response_id present in request
- Phase 4 (if done): Prewarm request returns Completed → next request reuses response_id

## Handoff

- Build agent must read this spec first.
- Build agent must read `specs/codex/provider_runtime/design.md` to understand architectural constraints (DD-1 through DD-5).
- Build agent must read `refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs` for protocol behavior.
- Build agent must materialize runtime todo from tasks.md.
- Build agent MUST verify Phase 1 gate (WS handshake succeeds) before proceeding to any other phase.
