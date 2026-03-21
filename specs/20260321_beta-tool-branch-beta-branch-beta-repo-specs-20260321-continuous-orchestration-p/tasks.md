# Tasks

## 1. Baseline Trace And Contract Lock

- [x] 1.1 Trace the current blocking `task()` lifecycle and identify the exact await boundary.
- [x] 1.2 Trace existing `task.worker.done` / `task.worker.failed` payloads and confirm parent-session / task identity coverage.
- [x] 1.3 Lock the non-blocking dispatch contract, stop gates, and validation targets in the plan/event docs.

## 2. Backend Dispatch Refactor

- [x] 2.1 Refactor `packages/opencode/src/tool/task.ts` so dispatch returns immediate metadata without awaiting worker completion.
- [x] 2.2 Add or wire a task-completion subscriber that injects synthetic parent-session continuation messages.
- [x] 2.3 Enqueue the parent session through `RunQueue` on both success and failure paths.

## 3. Prompt / UI Contract Sync

- [x] 3.1 Update prompt/runtime contract text to describe dispatch-first task semantics.
- [x] 3.2 Verify monitoring or session UI surfaces still expose running/completed subagent activity under the new flow.
- [x] 3.3 Remove or flag any stale assumptions that still treat `task()` as blocking.

## 4. Validation And Documentation

- [x] 4.1 Run targeted validation for dispatch/continuation behavior and record evidence.
- [x] 4.2 Run applicable typecheck / lint / tests for touched surfaces.
- [x] 4.3 Update `docs/events/event_20260322_continuous_orchestration.md` with checkpoints, root cause, implementation decisions, and validation results.
- [x] 4.4 Sync `specs/architecture.md` or record `Architecture Sync: Verified (No doc changes)` with evidence.
- [x] 4.5 Produce retrospective coverage against the proposal's effective requirement description.

<!--
Unchecked checklist items are the planner handoff seed for runtime todo materialization.
Checked items may remain for human readability, but they are not used as new todo seeds.
Runtime todo is the visible execution ledger and must not be replaced by a private parallel checklist.
-->
