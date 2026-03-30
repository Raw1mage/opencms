# Tasks

## 1. Phase 1 — MVP: Prove WS Works

- [x] 1.1 Prove Bun WebSocket TLS connectivity to chatgpt.com; document whether permessage-deflate is supported, but do not block Phase 1 on deflate
- [x] 1.2 Implement header builder: Authorization, originator, chatgpt-account-id, OpenAI-Beta (responses_websockets=2026-02-06)
- [x] 1.3 Implement minimal `connectWs(url, headers)`: establish WS to chatgpt.com, log handshake result
- [x] 1.4 Implement `sendWsRequest(ws, body)`: serialize response.create payload, strip stream/background, send as Text frame
- [x] 1.5 Implement minimal receive loop: collect Text frames until response.completed or error, log each event type
- [x] 1.6 Implement synthetic SSE bridge: wrap received events as `data: {json}\n\n` ReadableStream, return as Response
- [x] 1.7 Wire into codex.ts fetch interceptor: if WS connect succeeds, use WS path; else fall through to HTTP
- [x] 1.8 End-to-end validation: send "Say hello" via WS -> verify text output appears in UI

## 2. Phase 2 — Production Hardening

### 2A. Error Correctness First

- [x] 2.1 Implement `parseWrappedWebsocketErrorEvent()`: deserialize {type:"error"} with status, error, headers
- [x] 2.2 Implement `mapWrappedWebsocketErrorEvent()`: connection_limit->retryable, status->transport, no-status->ignore
- [x] 2.3 Port 5 error parsing test cases from codex-rs responses_websocket.rs
- [x] 2.4 Implement error-first frame parsing: check WrappedErrorEvent BEFORE ResponsesStreamEvent

### 2B. Runtime Hardening

- [x] 2.5 Implement idle timeout: configurable duration, error on timeout
- [x] 2.6 Implement Close frame detection -> "stream closed before response.completed" error
- [x] 2.7 Implement Ping/Pong auto-reply
- [x] 2.8 Implement session-scoped connection caching: Map<sessionId, WsState>
- [x] 2.9 Implement account-aware lifecycle: detect accountId mismatch -> close + reconnect
- [x] 2.10 Implement `forceHttpFallback()`: sticky disable_websockets per session
- [x] 2.11 Implement retry budget: WS connect fail -> retry once -> HTTP fallback
- [x] 2.12 Implement stream retry: budget-limited, emit "Reconnecting N/N" feedback
- [x] 2.13 Validate: WS error -> HTTP fallback -> session continues
- [x] 2.14 Validate: account rotation -> new WS connection with correct auth

## 3. Phase 3 — Incremental Delta

- [x] 3.1 Capture response_id from response.completed event, store in session state
- [x] 3.2 Implement `getIncrementalItems()`: compare current vs last request, detect prefix match
- [x] 3.3 Implement `prepareWsRequest()`: if prefix match -> send delta items + previous_response_id; else full request
- [x] 3.4 Implement cache eviction on 4xx/5xx: clear previous_response_id
- [x] 3.5 Implement `previous_response_not_found` handling: reset to full context
- [x] 3.6 Validate: second turn input items < first turn (confirmed via DIAG trace)

## 4. Phase 4 — Prewarm (SHELVED)

- [ ] 4.1 Implement prewarm request: response.create with generate=false
- [ ] 4.2 Implement prewarm stream drain: consume until Completed
- [ ] 4.3 Implement prewarm response_id capture for subsequent incremental
- [ ] 4.4 Implement prewarm failure: non-blocking, fall through

> Phase 4 remains intentionally shelved. Promotion to `/specs/` records completed Phases 1-3, not activation of shelved work.
