# Spec: codex-empty-turn-ws-snapshot-hotfix

## Purpose

Restore accurate cause-family classification for Codex empty turns by aligning the WS transport observation snapshot with the SSE classifier input contract.

### Requirement: WS snapshot frame count reaches classifier

- **GIVEN** `transport-ws.ts` observes a WS request with `frameCount > 0` and no terminal event
- **WHEN** the stream ends and `sse.ts` classifies an effectively empty turn
- **THEN** the classifier input must contain `wsFrameCount > 0`
- **AND** the resulting log entry must include `wsFrameCount`
- **AND** `causeFamily` must be `ws_truncation`.

### Requirement: zero-frame WS closure remains classifiable

- **GIVEN** the WS layer observes closure before any frame is received
- **WHEN** the stream is classified as an empty turn
- **THEN** the classifier input must contain `wsFrameCount: 0`
- **AND** `causeFamily` must be `ws_no_frames`.

### Requirement: no historical log mutation

- **GIVEN** historical JSONL rows were written without `wsFrameCount`
- **WHEN** this hotfix is implemented
- **THEN** existing rows must remain unchanged
- **AND** documentation must state those rows cannot be retroactively disambiguated.

## Acceptance Checks

- A1: Unit or integration test proves a real transport snapshot shape produces `ws_truncation`.
- A2: Existing sse tests for mocked `wsFrameCount` still pass.
- A3: JSONL payload from tested path includes numeric `wsFrameCount`.
- A4: Retry orchestration sees `retry-once-then-soft-fail` for WS classes.
- A5: Existing empty-turn log schema remains compatible.
