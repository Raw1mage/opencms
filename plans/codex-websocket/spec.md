# Codex WebSocket Transport — Full Reproduction Plan

## Goal

Complete rewrite of the Codex WebSocket transport in opencode, faithfully reproducing the behavior of `codex-rs` (`refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs` + `core/src/client.rs`).

The current WS implementation is disabled — it never successfully connected to `chatgpt.com` and silently swallowed errors. HTTP fallback works but lacks the latency and incremental-delta benefits of WS.

## Reference Source Files (codex-rs)

| File | Lines | Responsibility |
|---|---|---|
| `codex-api/src/endpoint/responses_websocket.rs` | 832 | WS connection, message pump, stream handler, error parsing |
| `codex-api/src/sse/responses.rs` | 1059 | SSE event parsing (shared by HTTP & WS) |
| `codex-api/src/provider.rs` | 170 | URL building (`websocket_url_for_path`), scheme conversion |
| `core/src/client.rs` | 1823 | Session-scoped client, WS/HTTP transport selection, fallback, prewarm, retry |
| `core/tests/suite/client_websockets.rs` | 1818 | WS integration tests |
| `core/tests/suite/websocket_fallback.rs` | 242 | WS → HTTP fallback tests |
| `core/tests/suite/agent_websocket.rs` | 429 | Agent-level WS tests |
| `core/tests/suite/stream_error_allows_next_turn.rs` | 124 | Error recovery tests |
| `core/tests/suite/stream_no_completed.rs` | 99 | Missing `response.completed` handling |

**Total reference: ~6,600 lines Rust**

## Target File in opencode

`packages/opencode/src/plugin/codex.ts` — replace the disabled WS section (~lines 625-770).

## Architecture

```
codex-rs architecture:
  ModelClient (session-scoped)
    └─ ModelClientSession (turn-scoped)
        ├─ stream_responses_websocket()  ← WS path
        │   ├─ connect_websocket() → ResponsesWebsocketConnection
        │   │   ├─ WsStream (tokio pump: send/recv mux)
        │   │   ├─ permessage-deflate
        │   │   ├─ headers: auth + originator + turn-state + conversation
        │   │   └─ response headers: x-reasoning-included, x-models-etag, openai-model
        │   ├─ stream_request() → ResponseStream
        │   │   ├─ send: JSON text frame (response.create wrapper)
        │   │   ├─ recv loop: parse each frame
        │   │   │   ├─ Text → parse WrappedWebsocketErrorEvent or ResponsesStreamEvent
        │   │   │   ├─ Close → error: "closed before response.completed"
        │   │   │   ├─ Ping → auto Pong
        │   │   │   └─ idle timeout → error
        │   │   └─ end: ResponseEvent::Completed
        │   └─ prewarm (generate=false) for next-turn latency
        │
        ├─ stream_responses_api()        ← HTTP fallback
        │
        └─ Fallback logic:
            - WS connect fail → retry once → HTTP fallback (session-scoped)
            - WS stream error → retry with budget → HTTP fallback
            - disable_websockets flag persists for session lifetime
```

## Phases

### Phase 1: WS Connection Layer (`CodexWsConnection`)

Reproduce `ResponsesWebsocketConnection` + `WsStream` from `responses_websocket.rs`.

**Deliverables:**
- `CodexWsConnection` class with:
  - `connect(url, headers)` — establish WS with permessage-deflate
  - `send(message)` — send JSON text frame
  - `receive()` — async iterator of parsed frames
  - `close()` — graceful close
  - Ping/Pong auto-reply
  - Idle timeout detection
- Headers: `Authorization`, `originator`, `chatgpt-account-id`, `x-codex-turn-state`
- Response header capture: `x-reasoning-included`, `x-models-etag`, `openai-model`, `x-codex-turn-state`
- URL: derive from `CODEX_API_ENDPOINT` (`https → wss`, append `/responses` if needed)

**Reference:** `responses_websocket.rs` lines 50-170, 343-420

### Phase 2: Error Parsing (`WrappedWebsocketErrorEvent`)

Reproduce error classification from `responses_websocket.rs`.

**Deliverables:**
- Parse `{type:"error", status:429, error:{type:"usage_limit_reached",...}, headers:{...}}`
- Map to typed errors:
  - `websocket_connection_limit_reached` → retryable (reconnect)
  - `usage_limit_reached` with status → transport error (rotation handles)
  - `usage_limit_reached` without status → ignore (codex-rs test line 780-798)
  - Other errors with status → transport error
- Error evicts `previous_response_id` from connection-local cache

**Reference:** `responses_websocket.rs` lines 446-507, tests lines 654-798

### Phase 3: Stream Handler (`streamRequest`)

Reproduce `run_websocket_response_stream` from `responses_websocket.rs`.

**Deliverables:**
- Send `response.create` frame (strip `stream`, `background` fields)
- Receive loop:
  - Parse each text frame as `ResponsesStreamEvent`
  - Handle `codex.rate_limits` events
  - Detect `ResponseEvent::Completed` as stream end
  - Handle `response.incomplete` as stream end
  - Handle `Message::Close` → error
  - Idle timeout → error
- Return synthetic SSE Response for AI SDK consumption
- Track `server_model`, `models_etag`, `server_reasoning_included`

**Reference:** `responses_websocket.rs` lines 214-280, 533-650

### Phase 4: Session-Scoped Transport Selection

Reproduce `ModelClient` / `ModelClientSession` transport logic from `client.rs`.

**Deliverables:**
- Per-session WS connection caching (lazy open)
- Account-aware: close + reconnect when account rotates
- WS → HTTP fallback:
  - `disable_websockets` flag set on WS failure
  - Session-scoped: once HTTP fallback activates, stays HTTP for session lifetime
  - NOT global: new sessions still try WS
- Retry budget: WS connect fail → retry once → HTTP
- `connection_reused` tracking for telemetry

**Reference:** `client.rs` lines 168-234, 505-570, 1095-1200

### Phase 5: Prewarm (`generate=false`)

Reproduce WS prewarm from `client.rs`.

**Deliverables:**
- On first turn: send `response.create` with `generate: false`
- Wait for completion (server prepares context)
- Subsequent requests on same connection reuse `previous_response_id`
- Prewarm failure → fall through to normal request (non-blocking)

**Reference:** `client.rs` lines 14-24 (doc), prewarm logic in `stream_responses_websocket`

### Phase 6: Incremental Delta Integration

Ensure `previous_response_id` + input trimming works correctly over WS.

**Deliverables:**
- Capture `responseId` from `response.completed` event
- On next turn: send only new input items + `previous_response_id`
- Cache eviction on 4xx/5xx errors
- `previous_response_not_found` → full context fallback
- Connection-local cache = most recent response only

**Reference:** Official spec (websocket-mode guide) + `client.rs` delta logic

## Non-Goals (this plan)

- Realtime API / audio WebSocket (different protocol entirely)
- `/responses/compact` over WS (use HTTP for compaction)
- Multi-connection multiplexing (spec says sequential only)

## Testing Strategy

- Unit: mock WS server, test error parsing, frame handling, timeout
- Integration: connect to real `chatgpt.com` WS endpoint with valid account
- Fallback: verify WS failure → HTTP works seamlessly
- Rotation: verify account switch → WS reconnect with new auth

## Risk Assessment

- `chatgpt.com` WS endpoint may have undocumented requirements not in codex-rs
- permessage-deflate support in Bun's WebSocket implementation is uncertain
- Connection-local cache behavior may differ between codex-rs and JS runtime
