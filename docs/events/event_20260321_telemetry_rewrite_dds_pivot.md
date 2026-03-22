# Event: Telemetry Rewrite DDS Pivot

**Date**: 2026-03-21
**Scope**: telemetry architecture planning
**Status**: Completed

## Problem

Telemetry branch had working UI and partial runtime event capture, but the steady-state update path was not aligned with the repo's DDS / bus / global-sync architecture.

The effective path was:

runtime emits some telemetry facts
→ telemetry persistence stores part of them
→ page hook listens to adjacent events
→ app refetches `session.top`
→ app hydrates `session_telemetry`
→ local fallback fills gaps

This made telemetry work, but left authority split across runtime persistence, monitor snapshot, page refresh logic, app hydration, and fallback heuristics.

## Decision

Telemetry planning is officially pivoted to a rewrite-first DDS design:

runtime telemetry events
→ server-side telemetry projector
→ bus/SSE delivery
→ app `global-sync` reducer
→ UI consumers

`session.top` remains only for bootstrap / reconnect / catch-up / degraded snapshot recovery.

## Consequences

- Existing telemetry branch glue is no longer treated as architecture to preserve.
- Build work may rewrite monitor transport usage, hydration helpers, and fallback ownership when they conflict with the target path.
- The success criterion changes from “telemetry cards can render” to “telemetry state converges through the canonical DDS path”.

## Related Artifacts

- `specs/telemetry/proposal.md`
- `specs/telemetry/spec.md`
- `specs/telemetry/design.md`
- `specs/telemetry/implementation-spec.md`
- `specs/telemetry/tasks.md`
- `specs/telemetry/handoff.md`
- `specs/telemetry/telemetry_rewrite_a0_idef0.json`
- `specs/telemetry/telemetry_rewrite_a0_grafcet.json`

## Validation

- Planning package now consistently treats current telemetry branch behavior as baseline only.
- Rewrite target is consistently expressed as runtime events → server projector → app reducer → UI consumer.
- MIAT drafts were added to support decomposition and execution traceability.
