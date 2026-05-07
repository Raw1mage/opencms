# Spec: codex-update

## Purpose

Bring `packages/opencode-codex-provider/` to feature parity with the upstream codex submodule range `5cc5f12ef..f7e8ff8e5` for surfaces we mirror, without changing any caller-visible API of the provider beyond additive options.

## Requirements

### Requirement: Distinct session_id and thread_id headers

Provider must emit both `session_id` and `thread_id` HTTP headers on every Responses-API request, matching upstream `build_session_headers(session_id, thread_id)` (codex commit `a98623511b`).

#### Scenario: caller supplies only sessionId

- **GIVEN** a request with `sessionId = "S-uuid"` and no explicit `threadId`
- **WHEN** the provider builds headers
- **THEN** the header map contains `session_id: S-uuid` AND `thread_id: S-uuid`
- **AND** they are equal (default-pairing per DD-1)

#### Scenario: caller supplies both sessionId and threadId

- **GIVEN** a request with `sessionId = "S-uuid"` and `threadId = "T-uuid"`
- **WHEN** the provider builds headers
- **THEN** the header map contains `session_id: S-uuid` AND `thread_id: T-uuid`
- **AND** they remain distinct

#### Scenario: caller supplies neither

- **GIVEN** a request with neither field set
- **WHEN** the provider builds headers
- **THEN** neither `session_id` nor `thread_id` header is emitted (current null-skip behavior preserved)

### Requirement: x-client-request-id sourced from threadId

Per upstream commit `a98623511b`, the `x-client-request-id` header now carries the thread identifier rather than the conversation/session identifier.

#### Scenario: x-client-request-id reflects threadId

- **GIVEN** a request with `sessionId = "S-uuid"` and `threadId = "T-uuid"`
- **WHEN** the provider builds headers
- **THEN** the `x-client-request-id` header value equals `T-uuid` (NOT `S-uuid`)

#### Scenario: x-client-request-id falls back to sessionId

- **GIVEN** a request with `sessionId = "S-uuid"` and no `threadId`
- **WHEN** the provider builds headers
- **THEN** `x-client-request-id` equals `S-uuid` (because `threadId` defaults to `sessionId`)

### Requirement: prompt_cache_key sources from threadId

Per upstream commit `a98623511b`, the `prompt_cache_key` body field is now sourced from `thread_id`, semantically aligning the cache key with the thread (not the multi-thread session).

#### Scenario: default cache key follows threadId

- **GIVEN** a request with `sessionId = "S-uuid"` (no `threadId`, no `promptCacheKey` override)
- **WHEN** the provider builds the request body
- **THEN** `body.prompt_cache_key` equals `S-uuid` (because `threadId` defaults to `sessionId` per DD-1)
- **AND** the value continues to remain stable across retries within the same logical turn

#### Scenario: explicit promptCacheKey override is preserved

- **GIVEN** a request with `sessionId = "S-uuid"`, `threadId = "T-uuid"`, AND `promptCacheKey = "custom-key"`
- **WHEN** the provider builds the request body
- **THEN** `body.prompt_cache_key` equals `"custom-key"` (override wins)

### Requirement: WebSocket send-side idle timeout

Per upstream commit `35aaa5d9fc`, the WebSocket send must be bounded by an idle timeout, not just the receive side.

#### Scenario: stalled send aborts within idle timeout

- **GIVEN** a Responses-API WS request whose `ws.send(...)` callback never fires (simulated stall)
- **WHEN** the configured `WS_IDLE_TIMEOUT_MS` (30s) elapses without the send acknowledging
- **THEN** the provider aborts the WS session
- **AND** sets `wsErrorReason = "ws_send_timeout"`
- **AND** transitions the empty-turn classifier to a transient-failure outcome

#### Scenario: normal send completes well under timeout

- **GIVEN** a Responses-API WS request whose `ws.send(...)` callback fires immediately
- **WHEN** the request flows normally
- **THEN** no `ws_send_timeout` is recorded
- **AND** stream behavior is unchanged from prior versions

### Requirement: Empty-turn classifier recognizes ws_send_timeout

The empty-turn classifier (`packages/opencode-codex-provider/src/empty-turn-classifier.ts`) must categorize `ws_send_timeout` alongside the existing transient-failure reasons (`first_frame_timeout`, `mid_stream_stall`, etc.).

#### Scenario: ws_send_timeout classified as transient

- **GIVEN** a turn snapshot with `wsErrorReason = "ws_send_timeout"` and `frameCount = 0`
- **WHEN** the classifier runs
- **THEN** the outcome category equals the existing transient-failure category (matching `first_frame_timeout` semantics)
- **AND** the recovery hint is "retry"

### Requirement: No regression in existing wire format

All other wire-shape fields (model, instructions, input, tools, tool_choice, parallel_tool_calls, reasoning, store, stream, include, text, client_metadata, previous_response_id, store, generate, context_management) remain bit-for-bit identical to current behavior.

#### Scenario: no header drift on unchanged surfaces

- **GIVEN** a request with the same options that produced header set H_old before this plan
- **WHEN** the same request is rebuilt after this plan
- **THEN** the new header set H_new equals H_old plus exactly `{thread_id: <value>}` (no other additions, no removals)

## Acceptance Checks

- [ ] All existing `bun test packages/opencode-codex-provider/` pass
- [ ] New tests added: thread_id header emission, x-client-request-id sourcing, prompt_cache_key sourcing, ws_send_timeout simulation, classifier categorization
- [ ] Live smoke: a real codex-account turn shows both `session_id` and `thread_id` headers in `[CODEX-WS] REQ` log lines
- [ ] No backwards-incompatible change to provider's public exports
- [ ] design.md DD-5 (response.processed deferral) and DD-4 (compact direct-call deferral) remain unimplemented and documented
