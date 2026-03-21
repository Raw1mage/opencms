# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from unchecked `tasks.md` items before execution continues.
- Build/implementation agent must preserve fail-fast semantics when task completion evidence is missing.
- User-visible progress and decision prompts must reuse the same planner-derived todo naming.

## Required Reads

- `proposal.md`
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`
- `docs/events/event_20260322_continuous_orchestration.md`
- `specs/architecture.md`

## Current State

- The beta worktree exists and is the active implementation surface.
- Planner artifacts are now build-ready and define concrete backend / prompt / validation slices.
- No implementation code has been changed yet in this beta worktree.

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to plan mode before coding if a new implementation slice is not represented in planner artifacts.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.
- Do not introduce silent fallback to blocking `task()` behavior.

## Build Entry Recommendation

- Start with Task Group 1 to trace the current blocking lifecycle and event payload authority before editing runtime code.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
