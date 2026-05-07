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

---

## Implementation Result (post-execution, 2026-05-07)

### Patch applied

`transport-ws.ts` now exports a `TransportSnapshot` interface and `getSnapshot()` returns explicit boundary fields per implementation-spec.md. Internal `WsObservation.frameCount` stays as the local counter name (DD-2). The `{...wsObs}` spread that exported the wrong field name is gone.

```ts
// Before (commit 9d09d63a3 in codex-empty-turn-recovery):
getSnapshot: () => ({
  ...wsObs,
  deltasObserved: { ...wsObs.deltasObserved },
})

// After (this hotfix):
getSnapshot: () => ({
  wsFrameCount: wsObs.frameCount,
  terminalEventReceived: wsObs.terminalEventReceived,
  terminalEventType: wsObs.terminalEventType,
  wsCloseCode: wsObs.wsCloseCode,
  wsCloseReason: wsObs.wsCloseReason,
  serverErrorMessage: wsObs.serverErrorMessage,
  deltasObserved: { ...wsObs.deltasObserved },
})
```

### Regression test

Added to `sse.test.ts` under "WS snapshot boundary contract regression" describe block:

- Imports `TransportSnapshot` type from `transport-ws.ts` and uses it to type the snapshot literal. **TypeScript-level compile guard** — if anyone renames `wsFrameCount` on either side, the test file fails to compile.
- Runtime assertion: `typeof lines[0].wsFrameCount === "number"` after end-to-end pipeline. **Runtime guard** — verifies the field actually survives JSON.stringify (the original bug's failure mode).
- Two scenarios covered: `wsFrameCount > 0 → ws_truncation`, `wsFrameCount === 0 → ws_no_frames`.

### Test results

- 107/107 codex-provider tests pass (was 105 before; +2 new boundary regression tests)
- All existing 16 sse integration tests still pass — no consumer-side regression
- Build clean

### Why the original bug shipped (lessons recorded)

1. **Inline callback types are a structural-typing trap.** When two files declare the same boundary independently (one as the callback signature, one as the producer return type), TypeScript can't enforce alignment without an explicit shared interface. The fix exports `TransportSnapshot` so both sides reference the same contract.
2. **Mock-correct tests don't catch boundary-incorrect production code.** The Phase 1 sse.test.ts integration tests mocked `getTransportSnapshot` with the consumer-expected field name `wsFrameCount` directly, so the test always passed regardless of whether the actual `transport-ws.ts:getSnapshot()` returned the right name. Real-boundary regression tests (importing the producer's exported type) close this gap.
3. **JSON.stringify silently drops undefined.** `{wsFrameCount: undefined, ...}` serializes to JSONL without the key. No crash, no warning — just a quietly malformed log entry. Schema-validation against data-schema.json AT WRITE TIME would have caught this; deferred to a future spec.

### Historical evidence limitation

Pre-hotfix JSONL rows that omitted `wsFrameCount` **cannot be retroactively reclassified**. `terminalEventReceived: false + zero deltas` is insufficient to disambiguate `ws_truncation` vs `ws_no_frames` vs true `unclassified`. JSONL is append-only per data-schema.json; existing rows stay as partial evidence.

Operator queries M2 (cause-family distribution) running over data spanning the pre/post-hotfix boundary should treat pre-hotfix `unclassified` rows as "WS-class with frame count unknown" rather than true unclassified.

### What this hotfix does NOT change

- Retry semantics (still cap=1 per INV-08)
- Runloop nudge (still broad per D-4)
- Compaction policy (L1 landmine still un-fixed)
- Account rotation policy (L2 landmine still un-fixed)
- JSONL append-only contract (no historical mutation)

The remaining empty-response landmines L1, L2, L3, L4, L7 belong to [specs/fix-empty-response-rca/](../../specs/fix-empty-response-rca/) which is paused at `proposed` per its D-6. **This hotfix is a prerequisite for that data to be useful** — without `wsFrameCount` populated, fix-empty-response-rca couldn't have ranked L1 vs L2 from production logs anyway.

### Architecture Sync

**Verified (No doc changes).** The codex-empty-turn-recovery section of `specs/architecture.md` already names the boundary contract correctly (it says "WS-layer evidence flows into sse.ts as wsFrameCount"). The architecture doc was right; the code was wrong. No doc update needed; the hotfix brought code into compliance with what the architecture already promised.

### Daemon restart

**Not requested.** Per handoff.md Stop Gate: "Stop before any daemon restart; only `system-manager_restart_self` is allowed if the user explicitly asks for live deployment." Hotfix is committed to main but the running daemon still has the old code. User must explicitly request restart for the fix to take effect on live JSONL.
