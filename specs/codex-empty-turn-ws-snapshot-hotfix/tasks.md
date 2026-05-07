# Tasks

## 1. Hotfix implementation

- [ ] 1.1 Normalize `transport-ws.ts:getSnapshot()` to return `wsFrameCount: wsObs.frameCount` at the exported SSE boundary.
- [ ] 1.2 Add regression coverage that fails when the real WS snapshot shape omits `wsFrameCount`.
- [ ] 1.3 Verify `ws_truncation` and `ws_no_frames` still select `retry-once-then-soft-fail` and emit numeric `wsFrameCount` in log payloads.

## 2. Evidence and documentation

- [ ] 2.1 Record the live RCA evidence and historical-log limitation in `docs/events/event_20260507_codex-empty-turn-ws-snapshot-hotfix.md`.
- [ ] 2.2 Update architecture or runbook only if code boundary wording changes; otherwise record `Architecture Sync: Verified (No doc changes)` with basis.
- [ ] 2.3 Run focused tests for codex-provider empty-turn classifier/SSE/WS snapshot path.

## 3. Closeout

- [ ] 3.1 Run plan sync/validation for this hotfix package.
- [ ] 3.2 Prepare implementation handoff with backup path and no-daemon-restart reminder.
