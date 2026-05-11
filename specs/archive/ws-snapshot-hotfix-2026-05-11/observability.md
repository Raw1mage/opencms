# Observability

## Events

This hotfix does not add new bus events; it restores the `wsFrameCount` field on the existing `codex.emptyTurn` channel payload (DD-2 boundary normalization).

## Metrics

Pre/post-hotfix observable via the JSONL log:

- **Pre-hotfix baseline**: empty-turn rows with `terminalEventReceived=false` show `wsFrameCount` absent and `causeFamily=unclassified`.
- **Post-hotfix expectation**: same rows show numeric `wsFrameCount` and `causeFamily ∈ {ws_truncation, ws_no_frames}`.

## Primary signal

- `~/.local/state/opencode/codex/empty-turns.jsonl`

## Expected post-hotfix evidence

Future empty-turn rows with `terminalEventReceived=false` must include numeric `wsFrameCount`.

Expected classification:

- `wsFrameCount > 0` → `causeFamily: "ws_truncation"`
- `wsFrameCount === 0` → `causeFamily: "ws_no_frames"`

## Historical evidence limitation

Rows already written without `wsFrameCount` are partial evidence. They prove empty turns reached `finishReason=unknown` with no terminal event and no deltas, but cannot distinguish no-frame from truncation.

## Checkpoints

- Baseline: live rows 18-20 in `empty-turns.jsonl` missing `wsFrameCount`.
- Boundary: `transport-ws.ts:getSnapshot()` output shape.
- Consumer: `sse.ts` `transportSnapshot.wsFrameCount` read.
- Result: JSONL includes `wsFrameCount` and non-`unclassified` WS cause.
