# Spec

## Purpose

- Provide a WebSocket transport adapter for Codex API requests that reduces latency via persistent connection reuse, properly surfaces errors, and gracefully falls back to HTTP — all beneath the AI SDK contract.

## Parent Spec

`specs/codex_provider_runtime/` — Requirement: Transport extension boundary (spec.md line 60-63).

## Requirements

### Requirement: WS Connection As Transport Adapter

The system SHALL establish WebSocket connections to the Codex endpoint as a transport adapter, producing a synthetic Response object that AI SDK consumes identically to HTTP SSE.

#### Scenario: Successful WS Request

- **GIVEN** a valid account with WS-compatible auth
- **WHEN** the fetch interceptor routes a request through WS
- **THEN** AI SDK receives a Response with content-type text/event-stream containing the same event sequence as HTTP SSE

#### Scenario: WS Unavailable

- **GIVEN** WS handshake fails or is not supported
- **WHEN** the interceptor detects failure
- **THEN** the request falls through to HTTP with zero user-visible impact

### Requirement: Error Event Classification

The system SHALL parse WrappedWebsocketErrorEvent frames and classify them into typed errors matching codex-rs behavior.

#### Scenario: Usage Limit With Status Code

- **GIVEN** server sends `{type:"error", status:429, error:{type:"usage_limit_reached",...}}`
- **WHEN** the system parses this frame
- **THEN** it throws a transport error that rotation can handle (switch account)

#### Scenario: Usage Limit Without Status Code

- **GIVEN** server sends `{type:"error", error:{type:"usage_limit_reached",...}}` with no status
- **WHEN** the system parses this frame
- **THEN** it is NOT mapped to an error (matches codex-rs test case line 780-798)

#### Scenario: Connection Limit Reached

- **GIVEN** server sends error with code `websocket_connection_limit_reached`
- **WHEN** the system parses this frame
- **THEN** it produces a retryable error that triggers reconnection

### Requirement: Session-Scoped Fallback

The system SHALL fall back to HTTP on WS failure, with the fallback being sticky for the session's lifetime.

#### Scenario: Fallback Activation

- **GIVEN** WS fails after retry budget exhaustion
- **WHEN** the system activates fallback
- **THEN** the current request succeeds via HTTP and all subsequent requests in this session use HTTP

#### Scenario: Fallback Stickiness

- **GIVEN** HTTP fallback was activated in turn N
- **WHEN** turn N+1 begins
- **THEN** it goes directly to HTTP without attempting WS

### Requirement: Account-Aware Connection Lifecycle

The system SHALL detect account rotation and reconnect with the new account's credentials.

#### Scenario: Account Rotation

- **GIVEN** a WS connection is open with account A
- **WHEN** rotation switches to account B
- **THEN** the old connection is closed and a new one opened with account B's auth

### Requirement: Incremental Delta (Phase 3)

The system SHALL detect consecutive requests with common input prefix and send only new items with previous_response_id.

#### Scenario: Delta Request

- **GIVEN** turn 1 completed with response_id R1
- **WHEN** turn 2's input extends turn 1's context
- **THEN** only new items are sent with previous_response_id=R1

#### Scenario: Cache Eviction

- **GIVEN** a request fails with 4xx/5xx
- **WHEN** the error is detected
- **THEN** previous_response_id cache is cleared

## Acceptance Checks

- WS handshake succeeds against chatgpt.com (Phase 1 gate)
- "Say hello" → text output appears in UI via WS transport
- Error parsing: 5 codex-rs test cases pass
- WS failure → HTTP fallback → session continues
- Fallback stickiness: second turn after fallback skips WS
- Account rotation → new connection with correct auth
- (Phase 3) Second turn input items < first turn
- (Phase 3) Cache eviction on 4xx/5xx confirmed
