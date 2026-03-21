# Proposal: Continuous Orchestration

## Why

- The Orchestrator's `task()` dispatch currently blocks the parent turn until the subagent completes.
- That blocks user progress visibility, prevents mid-run interaction, and makes slow LLM responses look like failures.
- The repo already has bus, session update, and run-queue primitives that can support non-blocking orchestration, but they are not yet composed into a continuous dispatch/resume flow.

## Original Requirement Wording (Baseline)

- "啟用beta-tool，基於現在branch，開一個beta branch在beta repo，進行 specs/20260321_continuous_orchestration/proposal.md的開發計"
- "只做 plan"
- "讀取 /home/pkcs12/projects/.beta-worktrees/opencode/beta/continuous-orchestration，然後plan_enter"
- "2"

## Requirement Revision History

- 2026-03-22: Scope was first narrowed to planning only so the workstream could be stabilized and committed cleanly.
- 2026-03-22: Beta-tool branch creation was blocked by a dirty main worktree; the blocker was resolved by committing the planning package and creating `beta/continuous-orchestration`.
- 2026-03-22: In beta worktree plan mode, the user requested that the plan be expanded into a build-ready implementation package rather than stopping at validation-only closure.

## Effective Requirement Description

1. Define an execution-ready implementation plan for continuous orchestration on the beta worktree.
2. Convert the current proposal package from a planning-only placeholder into a build-ready package with concrete implementation phases.
3. Keep beta-tool as the managed worktree/branch mechanism and use this plan root as the single execution contract for the implementation session.

## Scope

### IN

- Refine proposal, implementation spec, design, tasks, handoff, and diagrams into build-ready artifacts.
- Define concrete runtime changes for non-blocking `task()` dispatch and event-driven Orchestrator continuation.
- Define validation targets, execution slices, and documentation obligations for implementation.

### OUT

- Parallel subagent dispatch.
- Cross-process bus redesign.
- New fallback mechanisms that mask orchestration errors.
- Large UI redesign outside the minimum visibility changes required by the orchestration flow.

## Non-Goals

- Running multiple subagents concurrently in phase 1.
- Replacing the existing RunQueue model.
- Re-architecting unrelated session monitor or account-management flows.

## Constraints

- Beta-tool remains the authoritative worktree manager for this workstream.
- Implementation must fail fast on missing task-completion evidence rather than silently falling back to blocking behavior.
- Changes must stay aligned with existing session/bus/prompt architecture documented in `specs/architecture.md`.
- Event logging and architecture sync remain mandatory before implementation completion.

## What Changes

- `task()` will be split into immediate dispatch semantics plus background completion handling.
- A task-completion subscriber path will inject synthetic continuation messages and enqueue the parent Orchestrator session.
- Prompt / execution contract docs will be updated so Orchestrator behavior matches the new non-blocking semantics.
- Monitoring / validation work will verify that the parent turn no longer freezes during subagent execution.

## Capabilities

### New Capabilities

- Non-blocking task dispatch: the Orchestrator can dispatch work and end the turn while the subagent continues in the background.
- Event-driven continuation: completion/failure events resume the parent Orchestrator automatically.
- Build-ready plan contract: implementation can proceed from this plan root without needing a second planning pass.

### Modified Capabilities

- Orchestrator execution semantics: `task()` becomes dispatch-first rather than completion-blocking.
- Session continuation flow: synthetic completion messages become part of the normal orchestrator resume path.
- Monitoring expectations: task-running visibility is treated as a first-class runtime contract.

## Impact

- Primary code impact: `packages/opencode/src/tool/task.ts`, `packages/opencode/src/bus/index.ts`, `packages/opencode/src/session/index.ts`, `packages/opencode/src/session/queue.ts`, prompt/runtime docs, and monitoring surfaces.
- Documentation impact: `docs/events/`, `specs/architecture.md`, and prompt templates must reflect the new orchestration semantics.
- Validation impact: implementation must prove immediate UI responsiveness plus reliable task-result continuation.
