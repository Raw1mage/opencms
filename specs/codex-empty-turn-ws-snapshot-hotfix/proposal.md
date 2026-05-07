# Proposal: codex-empty-turn-ws-snapshot-hotfix

## Requirement

Fix the hot path that preserved empty-turn JSONL evidence but lost the WS frame-count field before classification. The hotfix must make future empty-turn logs classify `terminalEventReceived=false` cases as `ws_no_frames` or `ws_truncation` instead of `unclassified` when the WS layer has the required frame-count evidence.

## User-visible reason

Live evidence from `~/.local/state/opencode/codex/empty-turns.jsonl` for session `ses_1fde3b9f6ffeGLz88Qm5cOgr9V` shows three empty turns with no terminal event, no deltas, and null usage. The logs preserved the event but omitted `wsFrameCount`, so the classifier could not identify whether the root class was no frames or mid-stream truncation.

## Scope In

- Repair the `transport-ws.ts` to `sse.ts` snapshot field contract.
- Add tests that exercise the real boundary shape, not only a hand-written `wsFrameCount` mock.
- Preserve existing non-throwing recovery behavior.
- Record forensic limitation for already-written JSONL lines: historical rows cannot be reclassified because `wsFrameCount` was not persisted.

## Scope Out

- No runloop nudge policy changes.
- No compaction policy changes.
- No account rotation policy changes.
- No attempt to rewrite or mutate existing JSONL history.
- No daemon restart in this plan unless explicitly requested after implementation.

## Evidence baseline

- `empty-turns.jsonl` lines 18-20: `terminalEventReceived=false`, `deltasObserved` all zero, `usage` null, `causeFamily=unclassified`, missing `wsFrameCount`.
- Runtime telemetry for the same session contains `finishReason=unknown` rows matching the empty-turn timestamps.
- Code boundary mismatch: `transport-ws.ts` snapshot has `frameCount`; `sse.ts` expects `wsFrameCount`.

## Constraints

- Fail fast on contract mismatch in tests; do not add runtime fallback that masks a bad snapshot shape unless it is explicit and observable.
- Keep provider package independent from opencode runtime globals.
- Do not change the existing JSONL append-only policy.

## Revision History

- 2026-05-07: Initial hotfix plan opened from live empty-turn RCA.
