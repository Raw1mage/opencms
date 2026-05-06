# Spec: codex-empty-turn-recovery

## Purpose

Define the behavioral contract for how the codex provider detects "effectively empty" assistant turns, classifies them by cause family, preserves forensic evidence via structured logging, and selects a non-blocking recovery action — all without hard-failing CMS.

This spec is the source of truth for the empty-turn recovery boundary. Any future codex-provider change that touches stream termination, finishReason mapping, or empty-output handling must reconcile with this spec via plan-builder's amend/extend/refactor modes.

## Definitions

- **Empty turn**: an assistant turn whose stream concludes without emitting any `text-delta` part to AI SDK and without any `tool-call` part. May or may not have received a terminal event from codex.
- **Terminal event**: any of `response.completed`, `response.incomplete`, `response.failed`, `error` in the SSE/WS frame stream.
- **Cause family**: a finite enum of identified failure modes; the `unclassified` member is reserved for residue.
- **Recovery action**: a finite enum of non-blocking handling strategies; `hard-error` is explicitly excluded (per Decision D-1).
- **Forensic evidence**: structured log entry with enough state to reconstruct the turn's classification post-hoc.

## Requirements

### Requirement: Cause-family classification covers every empty turn

#### Scenario: WS truncation with frames received but no terminal event

- **GIVEN** the WS connection received `frameCount > 0` from codex
- **AND** no `response.completed` / `response.incomplete` / `response.failed` / `error` frame ever arrived
- **AND** `ws.onclose` fires while `state.status === "streaming"`
- **WHEN** the SSE flush block runs
- **THEN** the classifier MUST emit cause family `ws_truncation`
- **AND** the recovery action MUST be `retry-once-then-soft-fail`

#### Scenario: WS connection lost before any frame

- **GIVEN** the WS connection was opened and a request body was sent
- **AND** `frameCount === 0` when `ws.onclose` or `ws.onerror` fires
- **WHEN** the SSE flush block runs
- **THEN** the classifier MUST emit cause family `ws_no_frames`
- **AND** the recovery action MUST be `retry-once-then-soft-fail`

#### Scenario: Server reports completed but no text and no tool calls observed

- **GIVEN** `response.completed` arrived with `resp.status === "completed"`
- **AND** zero `response.output_text.delta` events were observed
- **AND** zero `response.function_call_arguments.*` events were observed
- **AND** the request body included `reasoning.effort` OR `include: ["reasoning.encrypted_content"]`
- **WHEN** the SSE flush block runs
- **THEN** the classifier MUST emit cause family `server_empty_output_with_reasoning`
- **AND** the recovery action MUST be `pass-through-to-runloop-nudge`
- **AND** the log entry MUST flag the suspect parameters by name (so production data can confirm the OpenHands #2797 B/C exposure)

#### Scenario: Server reports completed with deltas but classifier sees them as empty

- **GIVEN** `response.completed` arrived with `resp.status === "completed"`
- **AND** at least one `response.output_text.delta` was observed during the stream
- **WHEN** the SSE flush block runs
- **THEN** the turn MUST NOT be classified as empty (text was emitted to AI SDK during streaming)
- **AND** the classifier MUST be a no-op for this turn

#### Scenario: Server reports incomplete with reason

- **GIVEN** `response.incomplete` arrived
- **AND** zero text/tool deltas observed before it
- **WHEN** the SSE flush block runs
- **THEN** the classifier MUST emit cause family `server_incomplete`
- **AND** the recovery action MUST be `pass-through-to-runloop-nudge`
- **AND** the log entry MUST capture `incomplete_details.reason` verbatim

#### Scenario: Server reports failed

- **GIVEN** `response.failed` or top-level `error` arrived
- **AND** zero text/tool deltas observed before it
- **WHEN** the SSE flush block runs
- **THEN** the classifier MUST emit cause family `server_failed`
- **AND** the recovery action MUST be `pass-through-to-runloop-nudge`
- **AND** the log entry MUST capture the server error message verbatim

#### Scenario: No matching cause family

- **GIVEN** the empty-turn condition holds
- **AND** none of the above scenarios match
- **WHEN** the SSE flush block runs
- **THEN** the classifier MUST emit cause family `unclassified`
- **AND** the recovery action MUST be `pass-through-to-runloop-nudge`
- **AND** the log entry MUST include the full stream-state snapshot for forensic triage

### Requirement: Hard-error is never emitted for empty turns

#### Scenario: Classifier output reaches finish part

- **GIVEN** the classifier has emitted a cause family
- **WHEN** the SSE pipeline emits its terminal `finish` part to AI SDK
- **THEN** the `finishReason` MUST be one of `{stop, tool-calls, length, other, unknown}` — i.e., a regular AI-SDK `LanguageModelV2FinishReason`
- **AND** the SSE pipeline MUST NOT throw, MUST NOT call `controller.error()`, MUST NOT propagate any exception that stalls the runloop
- **AND** classifier metadata MUST be attached to the `finish` part's `providerMetadata.openai.emptyTurnClassification` field

#### Scenario: WS layer chooses to retry

- **GIVEN** the classifier selected `retry-once-then-soft-fail` for a turn
- **AND** the retry is attempted exactly once
- **WHEN** the retry also lands as empty
- **THEN** the second classification MUST proceed normally and emit a `finish` part with `pass-through-to-runloop-nudge` recovery (the soft-fail path)
- **AND** under no circumstances may the second failure be reported as a hard error

### Requirement: Forensic evidence preservation

#### Scenario: Every empty-turn classification emits a log entry

- **GIVEN** the classifier ran for a turn (regardless of cause family or recovery action chosen)
- **WHEN** the classification completes
- **THEN** a structured log entry MUST be written to the empty-turn log channel
- **AND** the entry MUST conform to the JSON Schema in `data-schema.json`
- **AND** the entry MUST include at minimum: `timestamp`, `sessionId`, `messageId`, `accountId`, `causeFamily`, `recoveryAction`, `wsFrameCount`, `terminalEventReceived`, `terminalEventType`, `deltasObserved` (counts by type), `requestOptionsShape` (sanitized; see schema), `streamStateSnapshot`

#### Scenario: Successful (non-empty) turns do not emit empty-turn log entries

- **GIVEN** a turn emitted at least one text-delta or tool-call to AI SDK
- **WHEN** the SSE pipeline finishes
- **THEN** no empty-turn log entry MUST be written for this turn (the channel is reserved for empty-turn classification)

#### Scenario: Log emission failure does not block recovery

- **GIVEN** the log channel is unavailable, full, or throws on write
- **WHEN** the classifier attempts to emit a log entry
- **THEN** the classifier MUST swallow the log error
- **AND** MUST emit a single `console.error("[CODEX-EMPTY-TURN] log emission failed: ...")` as a fallback breadcrumb
- **AND** MUST proceed with the recovery action as if logging had succeeded
- **AND** under no circumstances may a logging failure be allowed to stall the recovery path

### Requirement: Runloop nudge remains broad

#### Scenario: Empty turn reaches runloop with classifier metadata

- **GIVEN** a `finish` part arrived at the runloop carrying `providerMetadata.openai.emptyTurnClassification`
- **WHEN** the runloop's empty-response guard evaluates
- **THEN** the existing `?` nudge logic MUST still fire under its current trigger conditions (no narrowing per Decision D-4)
- **AND** the nudge MUST attach the classification metadata to its synthetic message's `providerMetadata` (so subsequent forensic reads can correlate the nudge with the upstream classification)

### Requirement: Audit-before-omit for OpenHands B/C parameters

#### Scenario: Production logs surface `server_empty_output_with_reasoning` cluster

- **GIVEN** the classifier has been emitting logs in production for ≥ 7 days
- **AND** a non-trivial fraction (≥ 5% threshold to be tuned in design) of empty turns are tagged `server_empty_output_with_reasoning`
- **WHEN** the maintainer reviews the log cluster
- **THEN** the maintainer MUST trigger an `extend` mode revision of this spec to add a Requirement covering parameter omission for codex-subscription tier
- **AND** until that extend lands, the provider MUST NOT pre-emptively strip those parameters (per Decision D-3)

### Requirement: Cause-family enum is finite and append-only

#### Scenario: New empirical cause discovered

- **GIVEN** a sustained pattern in the `unclassified` log cluster identifies a new cause
- **WHEN** the maintainer documents the new cause
- **THEN** an `extend` mode revision MUST add the new cause family to the enum
- **AND** no existing cause family member may be removed or renamed (append-only)
- **AND** the schema version in `data-schema.json` MUST bump

### Requirement: Recovery action enum is finite and excludes hard-error

#### Scenario: Action vocabulary check at code review

- **GIVEN** a code change touches the classifier or recovery dispatch
- **WHEN** the change is reviewed
- **THEN** the change MUST NOT introduce any recovery action outside the enum `{retry-once-then-soft-fail, synthesize-from-deltas, pass-through-to-runloop-nudge, log-and-continue}`
- **AND** the change MUST NOT introduce any code path that throws an exception in response to an empty turn

## Acceptance Checks

A1. Replay the `msg_dfe39162f` stream fingerprint (frameCount > 0, no terminal event, ws.onclose mid-stream) against the classifier — MUST emit `ws_truncation` + `retry-once-then-soft-fail`.

A2. Replay a synthetic stream with `response.completed { output: [] }` plus zero deltas plus a request body containing `reasoning.effort` — MUST emit `server_empty_output_with_reasoning` + `pass-through-to-runloop-nudge`, and the log entry MUST list `reasoning.effort` in `requestOptionsShape.suspectParams`.

A3. Replay a successful stream with deltas and `response.completed` — MUST NOT emit any empty-turn log entry.

A4. Force the log channel to throw on every write — classifier MUST still complete recovery; `console.error` fallback breadcrumb MUST be the only side-effect difference.

A5. Trigger every cause-family scenario from the Requirements section in unit tests; verify each emits the expected family + action + log entry.

A6. Run a 24-hour smoke test against a real codex backend with the classifier enabled; collect log distribution; verify no recovery action is `hard-error` and no exception escaped the SSE pipeline.

A7. Verify the runloop continues to fire `?` nudge for all classified empty turns (no narrowing per D-4); verify nudge synthetic message carries classification metadata.

## Out of Contract

- Counter-measures against codex backend rate limiting or quota — those land outside this spec
- The exact telemetry destination implementation (file vs. existing channel vs. both) — design decision recorded in `design.md`
- Account rotation policy changes to reduce cold-prefix probability — separate concern noted in proposal Risks
