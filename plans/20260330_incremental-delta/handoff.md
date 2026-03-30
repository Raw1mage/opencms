# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding.
- Materialize tasks.md into runtime todos before coding.
- Preserve planner task naming in user-visible progress and runtime todo.
- Prefer delegation-first execution when a task slice can be safely handed off.

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md
- docs/events/event_20260330_codex_incremental_delta_rca.md

## Current State

- RCA is complete and recorded in `docs/events/event_20260330_codex_incremental_delta_rca.md`.
- This plan package defines the intended fix scope, transport redesign, continuation invalidation rules, and validation approach.
- The current planning consensus is that the target model is **zero replay, not zero history**.
- Timeout and continuation-failure handling stay inside the same plan because append-only delta is unsafe without explicit invalidation/rebind boundaries.
- No implementation work has started yet.

## Stop Gates In Force

- Preserve all stop gates from implementation-spec.md.
- Return to planning if the chosen transport shape or consumer migration path differs materially from this plan.
- Stop for approval before broadening the fix from Codex-focused paths to product-wide streaming infrastructure.

## Build Entry Recommendation

- Start with Task Group 1 to gather baseline metrics before changing any contracts.
- Use that evidence to implement continuation versioning/invalidation before touching transport shape, including timeout and `previous_response_not_found` boundaries.
- Then choose the narrowest viable runtime event-shape rewrite for Task Group 3.
- Only then migrate Web, TUI, and subagent bridge consumers in Task Group 4.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
