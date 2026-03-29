# Spec

## Purpose

- Provide a persistent WebSocket transport for Codex API requests that reduces latency via connection reuse, lowers cost via incremental delta (sending only new items), and gracefully falls back to HTTP when WS is unavailable.

## Requirements

### Requirement: WS Connection Establishment

The system SHALL establish a WebSocket connection to `wss://chatgpt.com/backend-api/codex/responses` with TLS, permessage-deflate compression, and proper authentication headers.

#### Scenario: Successful Handshake

- **GIVEN** a valid OAuth access token and chatgpt-account-id
- **WHEN** the system initiates a WebSocket connection
- **THEN** the handshake completes within the connect timeout, response headers (x-reasoning-included, x-models-etag, openai-model, x-codex-turn-state) are captured, and the connection is ready for requests

#### Scenario: Connect Timeout

- **GIVEN** the server does not respond within the connect timeout
- **WHEN** the timeout expires
- **THEN** the connection attempt fails with a timeout error and the system can retry or fall back to HTTP

### Requirement: Error Event Classification

The system SHALL parse WrappedWebsocketErrorEvent frames and classify them into typed errors matching codex-rs behavior.

#### Scenario: Usage Limit With Status

- **GIVEN** the server sends `{type:"error", status:429, error:{type:"usage_limit_reached",...}, headers:{...}}`
- **WHEN** the system parses this frame
- **THEN** it produces a Transport(Http{status:429, headers, body}) error that rotation can handle

#### Scenario: Usage Limit Without Status

- **GIVEN** the server sends `{type:"error", error:{type:"usage_limit_reached",...}}` with no status field
- **WHEN** the system parses this frame
- **THEN** it returns None (the error is NOT mapped) — matching codex-rs test behavior

#### Scenario: Connection Limit Reached

- **GIVEN** the server sends an error with code `websocket_connection_limit_reached`
- **WHEN** the system parses this frame
- **THEN** it produces a Retryable error that triggers reconnection

### Requirement: Stream Response Handling

The system SHALL receive and parse streaming response events over WebSocket, emitting them as ResponseEvent values through a channel.

#### Scenario: Normal Text Response

- **GIVEN** a request is sent over WS
- **WHEN** the server streams response.created → output_item.added → output_text.delta → output_item.done → response.completed events
- **THEN** each event is parsed and emitted in order, with token usage extracted from the Completed event

#### Scenario: Idle Timeout

- **GIVEN** a request is being streamed
- **WHEN** no frame arrives within the idle timeout duration
- **THEN** the stream terminates with an idle timeout error

#### Scenario: Server Close Before Completed

- **GIVEN** a request is being streamed
- **WHEN** the server sends a Close frame before response.completed
- **THEN** the stream terminates with "stream closed before response.completed" error

### Requirement: Session-Scoped Transport Selection

The system SHALL try WebSocket first and fall back to HTTP on failure, with the fallback being sticky for the session's lifetime.

#### Scenario: WS Success

- **GIVEN** WS is enabled and the connection succeeds
- **WHEN** a request is made
- **THEN** it is sent over WS and the response is streamed back

#### Scenario: WS Failure Fallback

- **GIVEN** WS connection fails after retry budget exhaustion
- **WHEN** the system detects exhaustion
- **THEN** it activates HTTP fallback, the current request succeeds via HTTP, and all subsequent requests in this session use HTTP

#### Scenario: Fallback Stickiness

- **GIVEN** HTTP fallback was activated in turn N
- **WHEN** turn N+1 begins
- **THEN** it goes directly to HTTP without attempting WS

### Requirement: Account-Aware Connection Lifecycle

The system SHALL detect when account rotation changes the active account and reconnect the WebSocket with the new account's credentials.

#### Scenario: Account Rotation

- **GIVEN** a WS connection is open with account A
- **WHEN** rotation switches to account B
- **THEN** the system closes the old connection and opens a new one with account B's auth token

### Requirement: Incremental Delta Requests

The system SHALL detect when consecutive requests share a common input prefix and send only the new items with previous_response_id.

#### Scenario: Second Turn Incremental

- **GIVEN** turn 1 completed with response_id=R1 and the system captured the output items
- **WHEN** turn 2's input starts with (turn 1's input + R1's output items) + new items
- **THEN** the system sends only the new items with previous_response_id=R1

#### Scenario: Cache Eviction On Error

- **GIVEN** a request fails with 4xx/5xx
- **WHEN** the error is detected
- **THEN** the previous_response_id cache is cleared and the next request sends full context

### Requirement: V2 Prewarm

The system SHALL support sending a prewarm request (generate=false) to prepare server-side context without generating output.

#### Scenario: Prewarm Then Request

- **GIVEN** a new turn begins
- **WHEN** the system sends a prewarm request
- **THEN** the server prepares context, returns Completed with response_id, and the subsequent real request uses this response_id for incremental input

## Acceptance Checks

- WS handshake succeeds against chatgpt.com with at least one valid account
- Error parsing: 5 test cases ported from codex-rs all pass
- Streaming: "Say hello" returns text deltas and Completed event with token usage
- Fallback: simulated WS failure → HTTP takes over within same session
- Stickiness: second turn after fallback goes directly to HTTP (no WS attempt)
- Account rotation: new connection established with correct auth
- Incremental: second turn input items < first turn input items
- Prewarm: generate=false request returns Completed, next request uses response_id
- Idle timeout: no-frame scenario terminates stream within timeout duration
