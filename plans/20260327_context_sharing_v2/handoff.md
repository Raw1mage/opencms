# Handoff

## Execution Contract

- Build agent must read `implementation-spec.md` first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before making additional changes.
- Runtime todo must mirror the checklist names in `tasks.md`.
- Validation and documentation sync are mandatory completion gates for this feature.

## Required Reads

- `implementation-spec.md`
- `proposal.md`
- `spec.md`
- `design.md`
- `tasks.md`

## Current State

- Core implementation for context sharing v2 is already partially/completely landed in code.
- Planner package now captures the forward path, return path, validation, and doc-sync contracts.
- Remaining build scope is validation execution plus architecture/event truth synchronization.

## Stop Gates In Force

- Stop if prompt.ts behavior does not match the chosen contract for parent-prefix loading timing.
- Stop if child-to-parent relay is still only a shallow summary and cannot substantiate the stated product goal.
- Stop if compaction oscillation appears in stress validation and requires new guard logic.

## Build Entry Recommendation

- Start with validation tasks 3.3-3.6, then immediately land documentation sync tasks 4.2-4.3.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
