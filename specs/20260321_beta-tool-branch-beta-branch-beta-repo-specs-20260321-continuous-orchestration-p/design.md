# Design: Continuous Orchestration

## Context

- Today `packages/opencode/src/tool/task.ts` behaves as a synchronous tool call: the Orchestrator dispatches a worker and then waits for completion before the tool returns.
- The repo already has most of the primitives needed for continuous orchestration: bus publication, bridged worker events, synthetic messages, and `RunQueue.enqueue()`.
- The missing piece is a runtime composition that treats dispatch and completion as two separate phases owned by different components.

## Goals / Non-Goals

**Goals:**
- Make `task()` dispatch non-blocking for the parent Orchestrator turn.
- Resume parent sessions from event-backed completion evidence.
- Keep the first implementation slice sequential and observable.
- Minimize blast radius by reusing existing bus/session/run-queue primitives.

**Non-Goals:**
- Multi-subagent parallelism.
- Replacing the existing worker bridge transport.
- Adding hidden rescue paths that preserve the old blocking semantics.

## Decisions

- Split orchestration into dispatch-time responsibility (`tool/task.ts`) and completion-time responsibility (bus subscriber / session continuation path).
- Treat task-completion events as authoritative continuation triggers; the tool itself must not await worker completion.
- Preserve `RunQueue.enqueue()` as the only parent-session resume mechanism.
- Use synthetic parent-session messages as the handoff boundary between background completion and resumed Orchestrator reasoning.
- Keep UI changes minimal in phase 1: enough to verify running/completed visibility, not a full redesign.

## Data / State / Control Flow

- Orchestrator calls `task()` -> runtime creates child session / worker -> tool returns immediate dispatch metadata.
- Worker progress continues through existing stdout bridge -> bus events remain visible to monitors/UI.
- Worker completion or failure publishes an authoritative completion event.
- Completion subscriber resolves parent-session identity -> writes a synthetic continuation message -> enqueues parent on `RunQueue`.
- Resumed Orchestrator consumes the synthetic message and decides the next execution step.

## Risks / Trade-offs

- Event payload is currently insufficient for parent continuation -> mitigation is to extend completion metadata and/or resolve parent linkage from session records before dispatch refactor lands.
- Immediate return can expose race conditions in UI/monitor assumptions -> mitigate with targeted validation on status surfaces.
- Prompt/docs may drift from runtime semantics -> mitigate by updating prompt contract in the same implementation wave.
- Removing blocking semantics may reveal hidden callers depending on old timing -> mitigate with code search and explicit validation.

## Critical Files

- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/tool/task.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/bus/index.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/bus/subscribers/`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/session/index.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/session/queue.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/templates/prompts/SYSTEM.md`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/packages/app/src/pages/session/`

## Supporting Docs (Optional)

- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/docs/events/event_20260322_continuous_orchestration.md`
- `/home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration/specs/architecture.md`
