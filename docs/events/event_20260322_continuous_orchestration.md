# Event: Continuous Orchestration Planning

## Requirement

- User requested beta-tool enablement, creation of a beta branch/worktree, and development planning for `specs/20260321_continuous_orchestration/proposal.md`.
- The workstream was first stabilized as plan-only, then reopened in the beta worktree and expanded into a build-ready implementation plan.

## Scope

### IN

- Refine the continuous orchestration proposal into build-ready planner artifacts.
- Define execution slices for non-blocking task dispatch and parent-session continuation.
- Preserve beta-tool as the authoritative branch/worktree mechanism for this implementation workstream.

### OUT

- Parallel subagent dispatch.
- Cross-process orchestration redesign.
- Dependency/bootstrap repair outside this feature scope.

## Task List

- [x] Read existing architecture and plan baseline.
- [x] Inspect current continuous orchestration proposal.
- [x] Rewrite plan artifacts for plan-only scope.
- [x] Record beta-tool blocker and branch prerequisite.
- [x] Commit the planning package on `cms` and create the beta worktree.
- [x] Re-enter plan mode in the beta worktree.
- [x] Expand proposal/spec/design/tasks/handoff into a build-ready package.
- [x] Replace placeholder diagrams with implementation-aligned architecture models.

## Conversation Summary

- The initial `beta-tool newbeta` call was blocked because the main worktree was dirty.
- The user chose to finish planning on `cms`, commit the plan package, and then retry beta-tool.
- After the beta worktree was created, the user requested that the plan be upgraded from validation-only closure to a build-ready implementation package.
- The current beta worktree now contains a concrete implementation plan for continuous orchestration.

## Debug Checkpoints

### Baseline

- Symptom: the original worktree could not open the beta loop because `newbeta` requires a clean main worktree.
- Evidence: `newbeta` returned `Git worktree is dirty; refusing unsafe branch/worktree transition.`
- Dirty item: untracked planning package under `specs/20260321_beta-tool-branch-beta-branch-beta-repo-specs-20260321-continuous-orchestration-p/` before it was committed.

### Instrumentation Plan

- Verify branch/worktree cleanliness before invoking beta-tool.
- Read architecture and plan artifacts before rewriting the implementation contract.
- Replace placeholder execution/diagram artifacts with build-ready, implementation-specific content.

### Execution

- Read `specs/architecture.md` and the existing plan package.
- Normalized the package into a plan-only baseline, recorded the blocker, and wrote the first event entry.
- Committed the planning package on `cms`, then created `beta/continuous-orchestration` via beta-tool.
- Re-entered plan mode inside the beta worktree and rewrote proposal / implementation-spec / spec / design / tasks / handoff / diagrams into build-ready artifacts.
- Traced the current blocking boundary and confirmed that `task()` waits on worker completion via `await done` / outer `Promise.race(...)`.
- Traced `task.worker.done` / `task.worker.failed` payloads and confirmed they only publish child `sessionID` + `workerID`, which is insufficient by itself for parent-session continuation.
- Refactored `packages/opencode/src/tool/task.ts` so dispatch returns immediate metadata and worker completion is handled out-of-band.
- Added `packages/opencode/src/bus/subscribers/task-worker-continuation.ts` and registered it at runtime so success/failure events inject synthetic parent-session continuation messages and resume the parent through the workflow runner path.
- Updated prompt/runtime contract docs to describe dispatch-first semantics and verified that existing session UI surfaces still read child session activity from tool metadata without requiring UI code changes.
- Fixed review-discovered regressions by failing fast on nested task delegation, preserving parent-side logical task tracking, restoring task metadata, and forcing cleanup on continuation evidence failures.

### Root Cause

- The main blocker was not a beta-tool defect; it was an intentional clean-tree gate.
- The plan package originally contained placeholders and planning-only constraints that were insufficient for direct build execution.
- A second refinement pass inside the beta worktree was required to convert the package into an implementation-ready contract.
- The current runtime also lacks enough completion payload evidence to resume the parent orchestrator directly from existing bus events.
- Dispatch-first semantics initially exposed a sequential-dispatch regression and cleanup leak; both required a second hardening pass before validation.

### Validation

- All core planner artifacts now contain concrete, non-placeholder implementation content.
- Diagrams now reference the continuous orchestration runtime rather than generic placeholders.
- Phase 1 tracing evidence is now captured: the blocking boundary is in `task.ts`, and existing completion-event payloads are insufficient for direct parent resumption.
- `git diff --check` passed after the refactor and regression-fix pass.
- Validation commands remain environment-blocked: `bun run typecheck` fails because `tsgo` is missing; targeted `bun test` commands fail because `zod` / `solid-js` cannot be resolved in this beta worktree.
- Architecture Sync: Verified (No doc changes). Existing `specs/architecture.md` already describes beta-tool architecture, subagent visibility, and sequential dispatch constraints; this feature changes execution semantics inside those existing boundaries rather than introducing a new long-lived module boundary.

## Notes

- The active implementation surface is `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration` on branch `beta/continuous-orchestration`.
- No runtime code has been changed yet in the beta worktree.
- Next implementation entry point is Task Group 1 in `tasks.md`.
