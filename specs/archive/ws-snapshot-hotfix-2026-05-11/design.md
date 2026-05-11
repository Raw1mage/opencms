# Design: codex-empty-turn-ws-snapshot-hotfix

## Context

The existing empty-turn recovery spec expected WS-layer evidence to flow into `sse.ts` as `wsFrameCount`. The real WS observation object in `transport-ws.ts` stores the property as `frameCount` and `getSnapshot()` currently returns that object unchanged. `sse.ts` then reads `transportSnapshot.wsFrameCount`, receives `undefined`, and builds an invalid/incomplete snapshot. JSON serialization drops `undefined`, which explains live rows missing `wsFrameCount` and falling through to `unclassified`.

## Goals / Non-Goals

### Goals

- Make the transport/SSE boundary use one explicit snapshot contract.
- Ensure live logs preserve `wsFrameCount` for every classified empty turn.
- Ensure tests fail if the real boundary shape drifts again.

### Non-Goals

- No broad retry policy rewrite.
- No runloop anti-loop implementation.
- No historical JSONL correction.

## Decisions

### DD-1 — Boundary contract name is `wsFrameCount`

`MapResponseStreamOptions.getTransportSnapshot()` already declares `wsFrameCount`; data-schema.json and runbook also call the JSONL field `wsFrameCount`. The hotfix should adapt `transport-ws.ts` to that public contract rather than changing downstream consumers to `frameCount`.

### DD-2 — Keep internal `WsObservation.frameCount` if desired, but normalize at `getSnapshot()`

The minimal fix is in `transport-ws.ts:getSnapshot()`: return `wsFrameCount: wsObs.frameCount` plus the other existing fields. This preserves internal naming while making the exported boundary explicit.

### DD-3 — Add a real-boundary regression test

Existing `sse.test.ts` mocks `getTransportSnapshot()` with the already-correct `wsFrameCount` key, so it cannot catch this bug. Add a test that uses the same shape returned by `transport-ws.ts` or directly validates `getSnapshot()` output from a WS request path.

### DD-4 — Historical evidence remains partial

Existing rows that omitted `wsFrameCount` cannot be safely reclassified: `terminalEventReceived=false` alone cannot distinguish no-frame from mid-stream truncation. The hotfix event log must state this evidence gap.

## Critical Files

- `packages/opencode-codex-provider/src/transport-ws.ts`
- `packages/opencode-codex-provider/src/sse.ts`
- `packages/opencode-codex-provider/src/sse.test.ts`
- `packages/opencode-codex-provider/src/empty-turn-classifier.test.ts`
- `docs/events/event_20260507_codex-empty-turn-ws-snapshot-hotfix.md`

## Risks / Trade-offs

- If tests only mock `sse.ts`, the real boundary can drift again. Mitigation: DD-3 adds a regression test that uses the real getSnapshot() output shape.
- If a runtime fallback accepts both names silently, future schema drift may be masked. Prefer explicit boundary normalization and test coverage. Mitigation: this hotfix does NOT add a fallback — it normalizes once and lets TypeScript-style structural typing catch future drift.
- Trade-off: keeping internal `WsObservation.frameCount` while exporting `TransportSnapshot.wsFrameCount` introduces a field-name dual. Acceptable per DD-2 because the internal counter name is local-only and the boundary name is the contract that matters.
