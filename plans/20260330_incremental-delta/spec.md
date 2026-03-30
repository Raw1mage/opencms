# Spec

## Purpose

- Define observable requirements for making Codex incremental delta effective across request construction, runtime streaming, and UI consumption.
- Define the append-only conversation contract: zero replay to provider when continuation is valid, while retaining full local durable history.
- Define observable continuation invalidation behavior for timeout, close-before-completion, and `previous_response_not_found` boundaries.

## Requirements

### Requirement: Preserve Request Continuation Savings

The system SHALL preserve Codex continuation semantics while making request-side delta savings measurable in local runtime construction.

#### Scenario: Continue a Codex conversation with one new user message

- **GIVEN** a session with a valid prior Codex `responseId`
- **WHEN** the user sends one new follow-up message
- **THEN** the provider request SHALL use the continuation handle and SHALL avoid reconstructing unnecessary local prompt payload beyond what the runtime contract still requires

### Requirement: Submit Only Newly Added Facts When Continuation Is Valid

The system SHALL submit only newly added user input and newly added tool results to the provider when the continuation contract remains valid.

#### Scenario: Continue a conversation without contract invalidation

- **GIVEN** an existing Codex conversation whose system prompt, tool schema, provider-model identity, and upstream state handle are unchanged
- **WHEN** a new round begins
- **THEN** the provider-bound payload SHALL contain only newly added facts plus continuation/version metadata, and SHALL NOT replay prior context, prior tool results, or the prior system prompt

### Requirement: Invalidate Append-Only Submission Explicitly

The system SHALL fail fast and explicitly rebind when append-only submission is no longer valid.

#### Scenario: Continuation contract changes

- **GIVEN** a conversation where the system prompt hash, tool schema hash, provider-model identity, transcript base, or upstream conversation state has changed or expired
- **WHEN** the next round is prepared
- **THEN** the runtime SHALL explicitly invalidate append-only submission, surface the reason, and rebase the request path according to the new contract

### Requirement: Handle Continuation Failure Boundaries Explicitly

The system SHALL treat websocket timeout/close ambiguity and `previous_response_not_found` as explicit continuation invalidation boundaries.

#### Scenario: First-frame timeout before continuation is confirmed

- **GIVEN** a websocket request that is sent with a prior continuation handle
- **WHEN** no first frame arrives before the configured first-frame timeout
- **THEN** the runtime SHALL invalidate the inherited continuation state before fallback or retry and SHALL NOT silently reuse the stale handle

#### Scenario: Mid-stream stall before completion

- **GIVEN** a websocket stream that has already received one or more frames
- **WHEN** no additional frame arrives before the configured idle timeout and no terminal completion event has been confirmed
- **THEN** the runtime SHALL treat the continuation pointer as ambiguous, clear or invalidate continuation state, and require explicit rebind/full-context recovery policy for the next request

#### Scenario: Provider rejects prior continuation

- **GIVEN** a fallback HTTP request or subsequent round carrying a prior continuation handle
- **WHEN** the provider responds with `400 Previous response ... not found`
- **THEN** the runtime SHALL clear cached continuation state and SHALL either perform one explicit full-context rebind or surface a fail-fast recovery error

### Requirement: Stream Assistant Output As Delta-Aware Runtime Data

The system SHALL propagate streamed assistant text through session and SSE boundaries without repeatedly treating the full accumulated part as the primary transport payload.

#### Scenario: Receive a multi-chunk assistant text stream

- **GIVEN** a streamed assistant response arriving as multiple text deltas
- **WHEN** session processing publishes each update
- **THEN** the runtime SHALL emit a delta-aware event contract that allows downstream consumers to append only the new text while preserving correctness

### Requirement: Keep Consumers Correct Across Web, TUI, and Subagent Views

The system SHALL render streamed assistant output correctly for all supported consumers after the transport contract changes.

#### Scenario: Observe assistant output in Web, TUI, and subagent activity surfaces

- **GIVEN** the same streamed response is visible in the main session and, where applicable, bridged child-session activity
- **WHEN** delta-aware events are consumed by Web, TUI, and subagent bridge paths
- **THEN** each surface SHALL render the same final text with no missing, duplicated, or stale chunks

## Acceptance Checks

- Instrumentation shows `JSON.stringify(event).length` no longer grows in proportion to the full accumulated `part.text` for each streamed chunk.
- Instrumentation shows `delta.length` and downstream payload size remain close for the new transport path.
- Instrumentation shows provider-bound round payloads contain only newly added user/tool facts when continuation is valid.
- Invalidation logs or metrics show deterministic rebinding when prompt/tool/provider/upstream state versions change.
- Validation covers `first-frame timeout`, `mid-stream stall timeout`, and HTTP `400 Previous response ... not found` as explicit continuation invalidation boundaries.
- Web and TUI streamed output matches the final stored assistant text for representative long responses.
- Subagent activity rendering remains correct after bridge-path updates.
