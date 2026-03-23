# Event: Build Mode Refactoring

## Requirement

- Execute the `plans/20260321_build-mode-refactoring` plan and shift beta build authority from prompt-led guidance to a structured runtime admission quiz.

## Scope

### IN

- Beta-sensitive build admission quiz during `plan_exit`
- Mission-backed authority resolution and deterministic mismatch evaluation
- One-time reflection retry then explicit `product_decision_needed` stop
- Prompt/workflow de-redundancy so prompts stay advisory rather than pseudo-enforcement
- Focused validation and plan/task sync

### OUT

- New fallback mechanisms
- Broader beta workflow redesign beyond current admission/runtime boundary
- Commit / push / merge actions

## Tasks

- [x] 1.1 Audit current builder/build-mode authority surfaces and identify where quiz admission should run (`plan_exit`, first continuation, or both)
- [x] 1.2 Define the quiz schema and exact expected answer sources for main repo, base branch, implementation repo, implementation branch, and docs write repo
- [x] 1.3 Define pass/fail evaluation, mismatch evidence format, one-time reflection retry, and ask-user escalation policy
- [x] 2.1 Implement structured beta-sensitive build admission quiz
- [x] 2.2 Reject build entry when any quiz field mismatches authoritative mission/mainline metadata
- [x] 2.3 Persist or surface quiz admission state so later runtime steps know whether calibration already passed
- [x] 3.1 Reduce hardcoded build-mode prompt text so it no longer acts as pseudo-enforcement
- [x] 3.2 Keep only minimal state/stop narration and advisory text that still helps operators without claiming authority
- [x] 3.3 Re-evaluate `beta-workflow` skill and `beta-tool` MCP as advisory assets only, not admission/enforcement authorities
- [x] 4.1 Add or update targeted tests for quiz pass / retry / ask-user admission behavior
- [x] 4.2 Re-run focused build-mode and bootstrap-policy validation
- [x] 4.3 Confirm non-beta build behavior still works after prompt cleanup
- [x] 4.4 Record whether any concrete residual failure remains that would justify a future targeted hard guard

## Conversation Highlights

- Correct active plan was confirmed as `/home/pkcs12/projects/opencode/plans/20260321_build-mode-refactoring`.
- A placeholder-only plan created for plan-exit experimentation was explicitly rejected as the wrong exit target.
- Build execution was materialized from the correct plan and then advanced task-by-task under build mode.

## Debug Checkpoints

### Baseline

- Symptom: beta build safety still depended too much on prompt prose and skill/tool narration instead of a machine-checkable runtime authority gate.
- Risk: prompt-only enforcement could drift, be ignored, or over-claim authority while the real execution boundary remained ambiguous.

### Instrumentation Plan

- Audit `plan_exit`, mission persistence, workflow-runner continuation gates, and beta mission metadata surfaces.
- Verify whether build admission authority sat in `plan_exit`, continuation, or both.
- Search tests for existing stop-reason and pause semantics to reuse instead of inventing new fallback behavior.

### Execution

- Confirmed `plan_exit` is the build-entry handoff boundary and now performs the beta admission quiz.
- Added mission-backed beta authority resolution/evaluation plus persisted `mission.admission.betaQuiz` state.
- Reduced remaining prompt text to advisory guidance after admission success.

### Root Cause

- The original design leaned on hardcoded build-mode/beta guidance text as if it were an authority boundary.
- Runtime had beta context metadata, but lacked a deterministic admission handshake that could prove the builder was calibrated to the authoritative repo/branch/worktree contract before execution.

### Validation

- Deterministic evaluator coverage added for correct answers and multi-field mismatch evidence.
- `plan_exit` now covers pass / retry-pass / retry-fail behavior.
- Non-beta behavior remained valid after prompt cleanup in focused regression runs.

## Key Decisions

- Make `plan_exit` the authoritative beta build admission gate.
- Use a structured quiz with exact mission-backed values for:
  - `mainRepo`
  - `mainWorktree`
  - `baseBranch`
  - `implementationRepo`
  - `implementationWorktree`
  - `implementationBranch`
  - `docsWriteRepo`
- Allow exactly one reflection retry; on repeated mismatch, stop with explicit `product_decision_needed` evidence.
- Treat `beta-workflow` skill and `beta-tool` MCP as advisory/migration assets only, not admission enforcement surfaces.

## Issues Found

- No new blocking runtime issue remained after the focused implementation and validation slices.
- Residual hard guard not currently justified: the structured admission gate plus persisted quiz status now covers the concrete authority gap addressed in this task.

## Verification

- Evidence files:
  - `packages/opencode/src/tool/plan.ts`
  - `packages/opencode/src/session/workflow-runner.ts`
  - `packages/opencode/src/session/mission-consumption.ts`
  - `packages/opencode/src/session/index.ts`
- Focused test coverage present in:
  - `packages/opencode/src/session/mission-consumption.test.ts`
  - `packages/opencode/test/session/planner-reactivation.test.ts`
- Architecture Sync: Updated `specs/architecture.md` to reflect runtime authority vs advisory guidance boundaries.

## Remaining

- No open implementation tasks remain in this plan slice.
- Optional future work only if new evidence appears: add a narrower hard guard beyond current quiz admission if a concrete post-admission failure mode is observed.
