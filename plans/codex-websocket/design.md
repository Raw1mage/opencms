# Design

## Context

- codex-rs implements WS transport across 4 core files (~6,600 lines Rust)
- opencode's previous WS attempt was a thin wrapper that forwarded raw WS frames as fake SSE — lacked error parsing, idle timeout, deflate, account tracking
- The WS endpoint is `chatgpt.com/backend-api/codex/responses` (internal), not `api.openai.com` (public)
- HTTP transport is stable and verified; WS must be additive, never regressive

## Goals / Non-Goals

**Goals:**

- Faithful TypeScript reproduction of codex-rs WS protocol
- Correct error classification matching codex-rs test suite
- Session-scoped connection caching with account-aware lifecycle
- Incremental delta requests with previous_response_id
- V2 prewarm for latency reduction
- Clean WS→HTTP fallback that never leaves the user stuck

**Non-Goals:**

- Performance parity with native Rust (acceptable overhead in JS)
- Supporting alternative WS endpoints (only chatgpt.com)
- Realtime/audio WebSocket protocol

## Decisions

- DD-1: **Single file vs module split** — Extract WS code into `codex-websocket.ts` to keep codex.ts manageable. The fetch interceptor in codex.ts delegates to the new module for WS transport.
- DD-2: **Synthetic SSE bridge** — Keep the pattern of returning a synthetic `Response(ReadableStream)` to AI SDK. This avoids modifying AI SDK internals. The WS handler converts events to `data: {json}\n\n` format.
- DD-3: **permessage-deflate** — Investigate Bun's WS support first. If native deflate unavailable, use `ws` npm package with `perMessageDeflate` option as fallback.
- DD-4: **Connection caching scope** — Per-session (matching codex-rs ModelClient pattern). Connection stored in a Map keyed by session ID. Turn-scoped session borrows from this cache.
- DD-5: **Fallback stickiness** — Once HTTP fallback activates for a session, it stays HTTP for the session's lifetime (matching codex-rs `disable_websockets` AtomicBool behavior). New sessions still try WS.
- DD-6: **Error parsing priority** — Check WrappedWebsocketErrorEvent FIRST before parsing as ResponsesStreamEvent (matching codex-rs line 594-598). This prevents error events from being silently ignored.
- DD-7: **Beta header** — Include `OpenAI-Beta: responses_websockets=2026-02-06` for V2 protocol features (prewarm, incremental).

## Data / State / Control Flow

### Connection lifecycle

```
Session start → check WS availability
  → YES: lazy-connect on first request
    → Handshake (TLS + deflate + headers)
    → Cache in session map
    → Reuse across turns (check account match)
    → On error: retry with budget → fallback to HTTP
  → NO: straight to HTTP

Session end → Drop session
  → Cache connection back to session map (for next session reuse — codex-rs pattern)
```

### Request flow (WS path)

```
Turn start
  → Check cached connection (open? account match?)
  → If prewarm needed: send generate=false, drain stream
  → Build request (full or incremental via get_incremental_items)
  → Send as Text frame
  → Receive loop with idle timeout
    → Each frame: error check → event parse → emit to channel
    → On Completed: break, capture response_id
  → Return synthetic SSE Response
  → AI SDK consumes as if HTTP SSE
```

### Error classification (from codex-rs)

```
WS frame received
  → parse_wrapped_websocket_error_event()
    → code=websocket_connection_limit_reached → Retryable (reconnect)
    → status present → Transport(Http{status, headers, body})
    → status absent → None (ignore — codex-rs test case)
  → parse ResponsesStreamEvent
    → process_responses_event()
      → response.failed:
        → context_length_exceeded → ContextWindowExceeded
        → insufficient_quota → QuotaExceeded
        → usage_not_included → UsageNotIncluded
        → invalid_prompt → InvalidRequest
        → server_is_overloaded/slow_down → ServerOverloaded
        → rate_limit_exceeded → Retryable (parse retry-after regex)
        → default → Retryable
      → response.incomplete → Stream error
      → response.completed → Completed (normal end)
```

## Risks / Trade-offs

- **Bun WS deflate support** → If unavailable, messages are uncompressed (higher bandwidth but still functional). Mitigation: test with `ws` npm package.
- **chatgpt.com endpoint changes** → Internal endpoint may change without notice. Mitigation: monitor via stderr diagnostics already in place.
- **Connection limit (60 min)** → Long sessions hit the limit. Mitigation: detect `websocket_connection_limit_reached` and reconnect (matching codex-rs).
- **Incremental delta correctness** → Prefix matching must exactly reproduce codex-rs logic or requests may fail. Mitigation: port test cases from client_websockets.rs.
- **Race condition: account rotation during streaming** → Connection carries old auth. Mitigation: account-aware reconnection (A26) already designed.

## Critical Files

- `packages/opencode/src/plugin/codex.ts` — fetch interceptor, transport selection
- `packages/opencode/src/plugin/codex-websocket.ts` — new file: WS connection, error parsing, stream handler
- `packages/opencode/src/session/llm.ts` — codexSessionState, previousResponseId injection
- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts` — chunk schema, event parsing
- `refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs` — primary reference
- `refs/codex/codex-rs/core/src/client.rs` — transport selection, fallback, prewarm reference
