# Implementation Spec

## Goal

- Implement continuous orchestration so `task()` dispatch returns immediately, subagents continue in background, and parent Orchestrator sessions resume from completion events without user intervention.

## Scope

### IN

- Refactor `task()` to separate dispatch from completion waiting.
- Add a task-completion subscriber / continuation path that injects synthetic parent-session messages and enqueues the parent session.
- Update prompt/runtime documentation and execution contract text to match the new semantics.
- Validate that UI responsiveness and orchestration continuity work end to end.

### OUT

- Parallel subagent dispatch.
- Cross-process transport redesign.
- General-purpose background job framework unrelated to task orchestration.
- Silent fallback to the old blocking behavior.

## Assumptions

- Existing `task.worker.done` / `task.worker.failed` events do not currently carry enough context for parent-session continuation and must be extended or paired with explicit session lookup / summary extraction during implementation.
- `RunQueue.enqueue()` remains the canonical path for async session resumption.
- Synthetic session messages are an acceptable control-plane surface for resuming the Orchestrator.
- The beta worktree is now the active implementation surface for this feature branch.

## Stop Gates

- Stop if implementation requires parallel subagent dispatch or other scope expansion not represented in this plan.
- Stop if task-completion events cannot identify parent session and task identity with request-level evidence.
- Stop if implementation would require adding silent fallback to the old blocking path.
- Stop if architecture or prompt-contract changes exceed the documented execution slices and require re-planning.

## Critical Files

- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/tool/task.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/bus/index.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/bus/subscribers/`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/session/index.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/session/queue.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/templates/prompts/SYSTEM.md`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/app/src/pages/session/`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/docs/events/event_20260322_continuous_orchestration.md`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/specs/architecture.md`

## Structured Execution Phases

- Phase 1: Trace current blocking `task()` lifecycle, confirm parent/child event identities, and lock the non-blocking dispatch contract.
- Phase 2: Implement immediate dispatch semantics and task-completion continuation wiring on the backend/session side.
- Phase 3: Update prompt/runtime contract text and minimal monitoring/UI surfaces to reflect continuous orchestration semantics.
- Phase 4: Validate end-to-end behavior, sync docs/events/architecture, and prepare merge-ready retrospective evidence.

## Validation

- Run targeted tests for task dispatch / session continuation paths.
- Run repo-appropriate typecheck / lint / test commands for touched packages.
- Verify with runtime evidence that the parent Orchestrator turn returns immediately after dispatch and resumes on completion.
- Verify no hidden fallback keeps the parent turn blocked.

## Handoff

- Build/implementation agent must read this spec first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from unchecked `tasks.md` items before implementation begins.
- Every completed execution slice must update `tasks.md`, `docs/events/event_20260322_continuous_orchestration.md`, and architecture-sync evidence before completion is declared.
- If implementation reveals a new slice outside this contract, update the same plan root before proceeding.
