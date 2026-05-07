# Observability

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
