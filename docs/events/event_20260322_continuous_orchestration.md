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

## Follow-up Investigation (Specs Authority / Bug Intake)

- Current authoritative plan/spec root for this topic is `specs/continuous-orchestration/`, not the older dated planning path.
- `specs/continuous-orchestration/{proposal,spec,design,implementation-spec,tasks,handoff}.md` are aligned and already describe the intended dispatch-first + event-driven parent continuation contract.
- `tasks.md` is fully checked, which means this spec package currently reads as "implemented / validated" rather than "open work remains". Any newly discovered bugs should be tracked as either:
  1. focused follow-up fixes under the same semantic root, if they are regressions against this delivered contract; or
  2. a new plan slice, if the bug requires scope beyond the documented contract.
- Main known historical bug clues captured in this package/event chain:
  - original blocking boundary was `task.ts` awaiting worker completion;
  - completion events originally lacked enough parent identity evidence for safe continuation;
  - first dispatch-first refactor exposed sequential-dispatch regression and cleanup leak;
  - nested task delegation must fail fast rather than recurse silently.
- Upstream/background context still relevant for bug triage lives in older autorunner / continuation specs, especially the `20260315_*` autorunner/easier-plan-mode work and `20260309_autonomous_session_workflow_design.md`, because continuous orchestration sits on top of those continuation and todo-authority contracts.

## Follow-up Planning Revision (Operator Control Surface)

- New regression scope was added after the initial dispatch-first plan: background child execution currently leaves the parent session in a conversationally idle-looking state, which hides the stop button and removes a session-global active-run indicator too early.
- User requirements for the revised slice:
  1. Keep the stop button visible while a background subagent is still active.
  2. Add a bottom-pinned subagent status surface showing agent identity, task title, current progress/step, and child-session entry.
  3. Keep that status surface mounted until parent continuation actually takes over, then clear it.
  4. Preserve the policy that the Orchestrator may keep conversing / doing non-task tool calls while still forbidding a second subagent dispatch.
- User decisions locked for planning:
  - scope is **Web + TUI in the same implementation wave**;
  - stop semantics are staged: **first stop interrupts foreground Orchestrator activity; second consecutive stop kills the active child**;
  - TUI child-session entry must use **TUI-native session-tree jump behavior**, not URL rendering.
  - preferred UI implementation is **reuse-first**: extend the old bottom "thinking" / elapsed status surface rather than invent a new unrelated bar.
- Active planner root updated to `/plans/20260322_continuous-orchestration/` with fully rewritten proposal/spec/design/implementation-spec/tasks/handoff and non-placeholder diagram artifacts for this revised operator-control contract.
- Architecture Sync: Updated — `specs/architecture.md` now needs to describe the session-global active-subagent control state and the Web/TUI pinned-status behavior as part of the continuous orchestration contract.

## Implementation / Merge Addendum

- Continuous-orchestration control-surface implementation was completed in the beta worktree, but a later verification pass showed the main worktree still lacked the effective observability chain.
- Root cause: `beta-tool syncback` synchronizes **committed branch state**, not uncommitted dirty worktree state. Some observability changes had existed in beta worktree edits but were not yet fully committed when syncback/merge was first attempted.
- A direct main-vs-beta comparison confirmed the missing restore set in main:
  - `packages/opencode/src/tool/task.ts`
  - `packages/opencode/src/bus/subscribers/task-worker-continuation.ts`
  - `packages/app/src/pages/session.tsx`
  - `packages/app/src/pages/session/session-prompt-dock.tsx`
  - `packages/app/src/pages/session/session-prompt-helpers.ts`
  - `packages/app/src/components/prompt-input.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/prompt/active-child-footer.ts`
- Additional Web drift also had to be repaired so `session.active-child.updated` actually reached the UI store:
  - `packages/app/src/context/global-sync/types.ts`
  - `packages/app/src/context/sync.tsx`
  - `packages/app/src/context/global-sync/child-store.ts`
  - `packages/app/src/context/global-sync/event-reducer.ts`
  - `packages/app/src/context/global-sync/event-reducer.test.ts`
- Post-restore verification:
  - `git diff --check` passed
  - `packages/app/src/context/global-sync/event-reducer.test.ts` passed (`13` pass / `0` fail)
  - full `bun x tsc --noEmit` remained blocked by OOM rather than a feature-specific type error
- Operational lesson recorded: future beta-tool loops must commit beta-branch implementation slices before syncback/merge whenever the intent is to bring those changes back into main via branch state alone.

## Incident Follow-up: Restart / Stale Active Child Recovery

- A later incident exposed that `./webctl.sh dev-refresh` can interrupt backend/frontend/runtime processes while an active child is still recorded for the parent session.
- Investigation confirmed `SessionActiveChild` is currently process-local in-memory state inside `packages/opencode/src/tool/task.ts`; it is not persisted, and its cleanup depends on continuation / handoff paths completing.
- Investigation also confirmed `ProcessSupervisor` is process-local and does not reconstruct child occupancy after restart, so stale `active_child` state can survive long enough to block the next dispatch with `active_child_dispatch_blocked:<parent>:<child>:running`.
- Minimal repair chosen for this slice:
  - keep `handoff` conservative and still blocking;
  - before dispatch blocking on a `running` child, validate live worker evidence (`worker`, `worker.current`, `sessionID`, `parentSessionID`, `toolCallID`);
  - if worker evidence is missing / idle / mismatched, clear the stale active child and continue dispatch.
- Implementation landed in:
  - `packages/opencode/src/tool/task.ts`
  - `packages/opencode/test/tool/task.test.ts`
- Validation outcome for this repair:
  - focused `task.test.ts` rerun still fails before reaching the new assertions because the current assistant-message fixtures are outdated relative to `MessageV2.Assistant` schema requirements (`parentID`, `mode`, `cost`, `tokens`);
  - package typecheck still reports unrelated pre-existing errors in `task-worker-continuation.ts` and TUI prompt files;
  - targeted grep-filtered typecheck showed no new `task.ts` / `task.test.ts` errors attributable to this fix.
- Remaining gap:
  - this stale-running-child self-heal path is implemented, but repo validation is not yet green enough to declare the repair fully verified end-to-end.
- A subsequent Web UX refinement changed the pinned subagent status bar presentation to a compact single-line layout:
  - left side now renders `@agent`, title, current step, and elapsed time on one line;
  - long content truncates to fit available width;
  - right side keeps only the open-session icon and removes the text label.
- Web UI validation for this refinement:
  - `bun x tsc -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json --noEmit` passed after the compact-bar implementation and the `@agent` label normalization patch.
- Architecture Sync: Verified (No doc changes). Existing `specs/architecture.md` already describes active-child state as a session-global, operator-visible control-plane concept and does not require a new boundary for this self-heal guard refinement or the compact Web presentation adjustment.
