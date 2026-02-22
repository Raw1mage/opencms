# Event: origin/dev refactor item - show full turn duration

Date: 2026-02-23
Status: Integrated (no code delta)

## Source

- `7e1051af0` fix(ui): show full turn duration in assistant meta

## Analysis

- Upstream intent: ensure duration shown to user reflects the entire turn span, not a single assistant message segment.
- cms current implementation in `packages/ui/src/components/session-turn.tsx` already computes turn-level duration:
  - `duration()` starts from current user message created time.
  - End time is the max `assistantMessages().time.completed` across the turn.
  - Result is displayed in session turn meta (`store.duration`).
- Therefore the behavior target of upstream commit is already satisfied through cms session-turn architecture.

## Decision

- Marked as already integrated.
- No additional code changes required.
