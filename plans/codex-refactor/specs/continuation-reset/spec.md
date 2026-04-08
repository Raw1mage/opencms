# Spec: dialog continuation checkpoint reuse and remote ref flush

## Purpose

- Define a continuation reset policy that is **trigger-driven**.
- Preserve local semantic continuity while preventing stale provider-issued remote refs from being replayed.
- Standardize checkpoint replay semantics as **checkpoint prefix + raw tail steps**.
- Require observable debug logs for continuation invalidation failures (including `text part msg_* not found`).

## Requirements

### Requirement: Flush policy SHALL be A-trigger-only
The system SHALL decide remote-ref flushing only by reset triggers (A-set). No separate "keep conditions" section is defined.

#### Scenario: trigger evaluation
- **GIVEN** a continuation rebuild decision point
- **WHEN** any A-trigger matches
- **THEN** `flushRemoteRefs = true`
- **AND** provider-specific remote refs/sticky continuity state must be cleared
- **WHEN** no A-trigger matches
- **THEN** `flushRemoteRefs = false`

### Requirement: A-trigger set SHALL be explicit
The system SHALL recognize the following reset/rebuild triggers.

#### Scenario: A1 execution identity changed
- **GIVEN** previous and current execution identity snapshots
- **WHEN** `providerId` OR `modelID` OR `accountId` changes
- **THEN** flush remote refs

#### Scenario: A2 provider invalidation
- **GIVEN** provider/server returns continuation invalidation evidence
- **WHEN** errors such as `previous_response_not_found` or `text part msg_* not found` are observed
- **THEN** flush remote refs

#### Scenario: A3 restart resume mismatch
- **GIVEN** daemon/session restart resume path
- **WHEN** local checkpoint chain cannot be trusted to align with remote continuation chain
- **THEN** flush remote refs

#### Scenario: A4 checkpoint rebuild untrusted
- **GIVEN** continuation is rebuilt from checkpoint/compaction boundary
- **WHEN** remote continuity safety cannot be proven
- **THEN** flush remote refs

#### Scenario: A5 explicit operator reset
- **GIVEN** user/operator explicitly requests continuation reset
- **WHEN** reset command is accepted
- **THEN** flush remote refs

### Requirement: Checkpoint replay SHALL be prefix replacement + tail replay
Checkpoint is used to replace compacted prefix only; non-compacted steps remain raw replay tail.

#### Scenario: checkpoint + tail composition
- **GIVEN** total steps = 1..16 and checkpoint compacts 1..10
- **WHEN** continuation payload is composed
- **THEN** replay input must be `checkpoint(1..10) + rawSteps(11..16)` in order

### Requirement: Flush SHALL clear remote refs only
Flushing must not discard local semantic assets that are valid for warm start.

#### Scenario: flush scope isolation
- **GIVEN** any A-trigger matched
- **WHEN** flush executes
- **THEN** provider-issued remote refs/sticky continuity state are cleared
- **AND** checkpoint prefix and raw tail steps remain available for composition

### Requirement: Provider cleanup SHALL remain adapter-owned
Runtime orchestration is unified, but concrete cleanup keys/state are provider-defined.

#### Scenario: provider-specific continuity shape
- **GIVEN** providers expose different remote continuity mechanisms
- **WHEN** flush is requested
- **THEN** runtime invokes provider-specific cleanup hooks without assuming `msg_*` is universal

### Requirement: Invalidation failure SHALL log full state snapshot
When continuation invalidation errors happen, runtime SHALL emit a structured debug log snapshot for postmortem tracing.

#### Scenario: `text part msg_* not found` at runtime
- **GIVEN** request execution fails with `text part msg_* not found`
- **WHEN** error is classified as continuation invalidation
- **THEN** runtime logs a structured snapshot including at least:
  - execution identity (`providerId`, `modelID`, `accountId`)
  - matched trigger(s) / trigger evaluation result
  - checkpoint boundary (`checkpointStart`, `checkpointEnd`) and raw tail range
  - replay composition summary (checkpoint+tail counts)
  - provider invalidation code/message
  - serializer input summary (no secrets)
  - provider sticky continuity-state summary (no secrets)
  - flush decision/result
- **AND** log output uses existing runtime logger (no new event channel required in this slice)

## Acceptance Checks

- A-trigger-only policy is present; no separate B keep-conditions section exists.
- Codex/OpenAI account switch no longer replays stale refs that cause `text part msg_* not found`.
- Replay composition is explicitly defined as checkpoint prefix + raw tail steps.
- Flush behavior clears provider remote refs only and preserves checkpoint/tail semantic assets.
- Provider-specific cleanup contract is documented without cross-provider `msg_*` assumptions.
- Invalidation failures emit structured debug logs with full state snapshot fields for tracing.
