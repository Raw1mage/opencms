# Event: Codex empty-turn WS snapshot hotfix

## Requirement

Open a hotfix plan after live empty-turn logs showed evidence preservation worked but WS frame-count evidence was lost before classification.

## Scope

IN:

- Plan a targeted fix for `transport-ws.ts` to `sse.ts` snapshot field mismatch.
- Preserve JSONL append-only forensic model.
- Add regression-test requirements.

OUT:

- Upstream Codex backend RCA.
- Runloop nudge policy changes.
- Compaction or account-rotation policy changes.

## Baseline

- Session: `ses_1fde3b9f6ffeGLz88Qm5cOgr9V`.
- Evidence: `~/.local/state/opencode/codex/empty-turns.jsonl` lines 18-20.
- Observed: `terminalEventReceived=false`, no deltas, null usage, `finishReason=unknown`, but missing `wsFrameCount` and classified as `unclassified`.

## Root Cause

Boundary field mismatch:

- `transport-ws.ts` internally records `frameCount`.
- `sse.ts` expects `wsFrameCount` from `getTransportSnapshot()`.
- JSON serialization drops `undefined`, so historical rows lost the key.

## Task List

- Create hotfix spec package under `specs/codex-empty-turn-ws-snapshot-hotfix/`.
- Implement minimal boundary normalization in follow-up execution.
- Add regression coverage for the real boundary shape.

## Validation Plan

- Focused codex-provider tests around SSE empty-turn classification.
- Assert JSONL payload contains numeric `wsFrameCount`.
- Confirm `causeFamily` becomes `ws_truncation` or `ws_no_frames` for no-terminal WS empty turns.

## Architecture Sync

Pending implementation. Existing architecture already documents the empty-turn classifier path; expected closeout is likely `Verified (No doc changes)` unless code boundary wording changes.

## Backup

XDG whitelist backup: `/home/pkcs12/.config/opencode.bak-20260507-1200-codex-empty-turn-ws-snapshot-hotfix/`.

This is a pre-plan snapshot for manual restore only.
