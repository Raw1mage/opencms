# Spec

## Purpose

- 定義 codex provider 效能優化的行為需求，確保每項機制在 server 支援和不支援時都正確運作

## Requirements

### Requirement: Prompt Cache Key Injection

The system SHALL include `prompt_cache_key` in every codex Responses API request.

#### Scenario: Cache key per session

- **GIVEN** codex provider is active with a session
- **WHEN** an LLM request is sent
- **THEN** request body contains `"prompt_cache_key": "{session_id}"` and subsequent requests in same session use the same key

#### Scenario: Cache hit on repeated context

- **GIVEN** two consecutive turns in the same session with identical system prompt
- **WHEN** second turn request is sent with same prompt_cache_key
- **THEN** response usage shows `cached_input_tokens > 0`

### Requirement: Sticky Routing

The system SHALL capture and replay `x-codex-turn-state` headers within a turn.

#### Scenario: Turn state capture

- **GIVEN** codex provider sends a request
- **WHEN** response includes `x-codex-turn-state` header
- **THEN** the value is stored in per-turn state

#### Scenario: Turn state replay

- **GIVEN** turn state was captured from a previous response
- **WHEN** a follow-up request is sent within the same turn (tool call loop)
- **THEN** request includes `x-codex-turn-state: {captured_value}` header

#### Scenario: Turn state reset

- **GIVEN** a new turn starts (new user message)
- **WHEN** first request of the new turn is sent
- **THEN** no `x-codex-turn-state` header is included (fresh routing)

### Requirement: Encrypted Reasoning Reuse

The system SHALL preserve and replay encrypted reasoning content across turns.

#### Scenario: Reasoning content capture

- **GIVEN** model responds with reasoning items containing `encrypted_content`
- **WHEN** response items are processed
- **THEN** encrypted_content is stored in conversation history

#### Scenario: Reasoning content replay

- **GIVEN** previous turn's reasoning had encrypted_content
- **WHEN** next turn request is constructed
- **THEN** reasoning item with encrypted_content is included in input array

#### Scenario: Server acknowledgment

- **GIVEN** encrypted reasoning is included in request
- **WHEN** server processes the reasoning
- **THEN** response header `x-reasoning-included: true` is present and client skips re-estimating reasoning tokens

### Requirement: Request Body Compression

The system SHALL compress request bodies with zstd when using ChatGPT subscription mode.

#### Scenario: Compression applied

- **GIVEN** auth mode is ChatGPT OAuth (subscription)
- **WHEN** request body exceeds 1KB
- **THEN** body is compressed with zstd and `Content-Encoding: zstd` header is set

#### Scenario: Compression skipped for API key mode

- **GIVEN** auth mode is API key
- **WHEN** request is sent
- **THEN** no compression is applied

### Requirement: WebSocket Transport with Incremental Delta

The system SHALL use WebSocket transport with incremental delta when available. WebSocket is implemented as a fetch interceptor transport adapter — AI SDK pipeline remains unchanged.

#### Scenario: WebSocket connection

- **GIVEN** codex provider initializes a turn
- **WHEN** WebSocket is not disabled and connection is healthy
- **THEN** WebSocket connection is reused (or established) with proper handshake headers

#### Scenario: Incremental delta

- **GIVEN** a previous response_id exists in the session
- **WHEN** a follow-up request has only appended items (no instruction/tool changes)
- **THEN** request sends only delta items with `previous_response_id` (not full history)

#### Scenario: Synthetic SSE Response

- **GIVEN** WebSocket transport is active
- **WHEN** WS events are received
- **THEN** events are transformed to SSE format and returned as a synthetic Response that AI SDK SSE parser can consume

#### Scenario: Fallback to HTTP

- **GIVEN** WebSocket connection fails, returns 426, or errors mid-stream
- **WHEN** transport fallback is triggered
- **THEN** request falls back to HTTP SSE (current path) transparently

#### ~~Scenario: Prewarm~~ (SHELVED)

~~- **GIVEN** user is typing and session context is loaded~~
~~- **WHEN** prewarm is triggered~~
~~- **THEN** request is sent with `generate: false` to warm server cache without output tokens~~

### Requirement: Server-side Compaction

The system SHALL use server-side compaction when context approaches limits.

#### Scenario: Compact trigger

- **GIVEN** conversation context approaches model's context window limit
- **WHEN** compaction is triggered
- **THEN** system calls `/responses/compact` endpoint instead of client-side compaction

#### Scenario: Compact result

- **GIVEN** `/responses/compact` returns a compacted summary
- **WHEN** summary is received
- **THEN** conversation history is replaced with compacted version and next request uses reduced context

### Requirement: context_management (Inline Compaction)

The system SHALL include `context_management` in codex Responses API requests to enable server-side inline compaction.

#### Scenario: Inline compaction threshold

- **GIVEN** codex provider is active
- **WHEN** an LLM request is sent
- **THEN** request body contains `"context_management": [{"type": "compaction", "compact_threshold": N}]` where N is derived from model context window

### Requirement: providerOptions Injection

The system SHALL set codex-specific providerOptions for store and service_tier.

#### Scenario: store=false for privacy and encrypted reasoning

- **GIVEN** codex provider is active
- **WHEN** an LLM request is constructed
- **THEN** `providerOptions.openai.store = false` is set, triggering AI SDK to auto-include `reasoning.encrypted_content`

#### Scenario: priority service tier for Pro users

- **GIVEN** codex provider is active with ChatGPT Pro subscription
- **WHEN** an LLM request is constructed
- **THEN** `providerOptions.openai.serviceTier = "priority"` is set

## Acceptance Checks

- [x] prompt_cache_key present in all codex requests (Phase 1)
- [ ] cached_input_tokens > 0 on second turn of a session (Phase 1)
- [x] x-codex-turn-state captured and replayed within tool-call turns (Phase 1)
- [ ] providerOptions.openai.store = false 生效 (Phase 2)
- [ ] providerOptions.openai.serviceTier = "priority" 生效 (Phase 2)
- [ ] encrypted_content preserved across turns in reasoning items (Phase 2)
- [x] zstd Content-Encoding header on ChatGPT mode requests (Phase 2)
- [ ] WebSocket connection established via fetch interceptor transport adapter (Phase 3)
- [ ] AI SDK SSE parser correctly consumes synthetic Response from WS (Phase 3)
- [ ] Incremental delta: input_tokens < 50% of full-context baseline (Phase 3)
- [ ] Server compaction reduces context by > 50% (Phase 4)
- [ ] context_management field present in request body (Phase 4)
- [ ] All phases gracefully degrade: no errors when server doesn't support a feature
