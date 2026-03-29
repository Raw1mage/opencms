# Tasks

## 1. WS Connection Layer (A2, A3)

- [ ] 1.1 Investigate Bun WebSocket permessage-deflate support; if unavailable, evaluate `ws` npm package
- [ ] 1.2 Implement `CodexWsConnection` class: connect(), send(), receive(), close()
- [ ] 1.3 Implement WsStream message pump: bidirectional mux with send channel + receive channel
- [ ] 1.4 Implement Ping/Pong auto-reply in message pump
- [ ] 1.5 Implement idle timeout wrapping receive calls
- [ ] 1.6 Implement Close frame detection → error propagation
- [ ] 1.7 Implement URL builder: `websocket_url_for_path()` (https→wss scheme conversion)
- [ ] 1.8 Implement header builder: auth, originator, chatgpt-account-id, turn-state, beta features, turn-metadata, timing-metrics
- [ ] 1.9 Implement response header capture: x-reasoning-included, x-models-etag, openai-model, x-codex-turn-state
- [ ] 1.10 Implement Drop/cleanup: abort pump task, close connection

## 2. Error Parsing (A4)

- [ ] 2.1 Implement `parseWrappedWebsocketErrorEvent()`: deserialize {type:"error"} with status, error, headers
- [ ] 2.2 Implement `mapWrappedWebsocketErrorEvent()`: connection_limit→retryable, status→transport, no-status→ignore
- [ ] 2.3 Implement `jsonHeadersToHttpHeaders()`: convert JSON header map to standard headers
- [ ] 2.4 Port test cases from responses_websocket.rs lines 654-798 (5 test cases)
- [ ] 2.5 Verify: error event with status=429 + usage_limit → Transport(Http{429})
- [ ] 2.6 Verify: error event without status → None (not mapped)
- [ ] 2.7 Verify: connection_limit_reached → Retryable with reconnect message

## 3. Stream Handler (A6)

- [ ] 3.1 Implement `streamRequest()`: send response.create frame, start receive loop
- [ ] 3.2 Strip `stream` and `background` fields from WS request payload
- [ ] 3.3 Implement frame receive loop: error-check-first → parse → emit → break on Completed
- [ ] 3.4 Implement codex.rate_limits event handling (WS-specific)
- [ ] 3.5 Implement server model tracking: emit ServerModel event on model change
- [ ] 3.6 Implement stream end detection: response.completed AND response.incomplete
- [ ] 3.7 Implement Binary frame → error, Close frame → error
- [ ] 3.8 Implement synthetic SSE Response wrapper (ReadableStream → data: {json}\n\n format)
- [ ] 3.9 Implement `trackLastResponse()`: accumulate OutputItemDone items, capture response_id via oneshot pattern

## 4. Transport Selection (A1)

- [ ] 4.1 Implement `responsesWebsocketEnabled()`: check provider flag + disable_websockets + fixture override
- [ ] 4.2 Implement session-scoped connection caching: Map<sessionId, WsSessionState>
- [ ] 4.3 Implement account-aware connection lifecycle: close + reconnect on account mismatch
- [ ] 4.4 Implement `forceHttpFallback()`: set disable_websockets flag, reset cached session
- [ ] 4.5 Implement transport selection in fetch interceptor: WS-first → on failure → HTTP fallback
- [ ] 4.6 Implement fallback stickiness: once HTTP activated, persist for session lifetime
- [ ] 4.7 Implement `connectionReused` tracking for telemetry

## 5. Prewarm (A7)

- [ ] 5.1 Implement prewarm request: response.create with generate=false
- [ ] 5.2 Implement prewarm stream drain: consume events until Completed
- [ ] 5.3 Implement prewarm response ID capture for subsequent incremental request
- [ ] 5.4 Implement prewarm failure handling: non-blocking, fall through to normal request
- [ ] 5.5 Ensure prewarm counts as first WS attempt for retry budget

## 6. Incremental Delta (A6.2, A6.6)

- [ ] 6.1 Implement `getIncrementalItems()`: compare current vs last request, detect prefix match
- [ ] 6.2 Implement `prepareWebsocketRequest()`: full or incremental based on prefix detection
- [ ] 6.3 Implement cache eviction on 4xx/5xx errors: clear previous_response_id
- [ ] 6.4 Implement `previous_response_not_found` handling: reset to full context
- [ ] 6.5 Integrate with existing codexSessionState in llm.ts

## 7. Retry & Recovery (A8)

- [ ] 7.1 Implement WS connect retry: budget-limited, prewarm counts as first attempt
- [ ] 7.2 Implement WS stream retry: budget-limited, emit "Reconnecting N/N" feedback
- [ ] 7.3 Implement 401 handling: auth recovery state machine integration
- [ ] 7.4 Implement 426 handling: immediate HTTP fallback
- [ ] 7.5 Implement retry exhaustion → HTTP fallback activation

## 8. Integration Testing

- [ ] 8.1 Test: basic WS connection to chatgpt.com with valid account
- [ ] 8.2 Test: WS request → response → text output
- [ ] 8.3 Test: connection reuse across multiple turns
- [ ] 8.4 Test: account rotation → reconnect with new auth
- [ ] 8.5 Test: usage_limit_reached error → proper error surfacing
- [ ] 8.6 Test: WS failure → HTTP fallback works
- [ ] 8.7 Test: incremental delta → reduced input items on second turn
- [ ] 8.8 Test: idle timeout → error propagation
- [ ] 8.9 Test: 60-min connection limit → reconnect
