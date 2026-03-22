# Event: Telemetry Plan Refresh

**Date**: 2026-03-21
**Scope**: `specs/telemetry/`, `specs/architecture.md`
**Status**: Completed

## Change

- Rebased the telemetry planning package around a rewrite-first DDS target instead of a hydration-first completion story.
- Split the documentation into two explicit layers: current implemented state vs target rewrite architecture.
- Reframed the target telemetry design as:
  - runtime emits telemetry events
  - server-side projector owns the authoritative telemetry read model
  - app `global-sync` reducer owns the canonical telemetry slice
  - UI surfaces are read-only consumers
  - `session.top` is bootstrap/catch-up/degraded snapshot transport only
- Added MIAT planning artifacts so future build work can follow functional decomposition and control-flow traceability.

## Current State Captured

- Runtime telemetry events already exist and supported ones persist through `packages/opencode/src/bus/subscribers/telemetry-runtime.ts` into `RuntimeEventService`.
- `packages/opencode/src/session/monitor.ts` and `GET /session/top` currently expose snapshot telemetry to consumers.
- App currently refreshes `session.top` via `packages/app/src/pages/session/use-status-monitor.ts` and hydrates `session_telemetry` through `packages/app/src/context/sync.tsx` plus `monitor-helper.ts`.
- Existing telemetry UI surfaces remain read-only consumers, but the update path is still snapshot/hydration-led.

## Target State Recorded

- The plan no longer treats snapshot hydration as the desired steady-state telemetry path.
- Long-term architecture now records a bus-driven projector/reducer pipeline and demotes `session.top` to bootstrap/catch-up behavior.
- Build-stage implementation is explicitly allowed to rewrite or remove current telemetry glue that conflicts with the target ownership model.

## Validation

- Verified updated plan wording against `specs/architecture.md`, `packages/opencode/src/session/llm.ts`, `packages/opencode/src/session/processor.ts`, `packages/opencode/src/bus/subscribers/telemetry-runtime.ts`, `packages/opencode/src/session/monitor.ts`, `packages/opencode/src/server/routes/session.ts`, `packages/app/src/context/global-sync/types.ts`, `packages/app/src/context/global-sync/event-reducer.ts`, `packages/app/src/context/sync.tsx`, `packages/app/src/pages/session/use-status-monitor.ts`, and `packages/app/src/pages/session/monitor-helper.ts`.
- Confirmed the documents distinguish current branch behavior from target design and encode a rewrite-friendly execution contract.

## Follow-up

- Future builders should execute from the new phase order in `specs/telemetry/tasks.md`.
- Product code remains unchanged by this event; this is a planning/architecture pivot only.
