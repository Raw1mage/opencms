# Spec: Recovery Refactor After 2026-04-01 Drift

## Purpose

- Restore the remaining high-value functionality lost from the 2026-04-01 drift by refactoring it into the active recovery branch in a safe, slice-by-slice order.

## Requirements

### Requirement: Recover remaining high-value slices in value order

The system SHALL restore the remaining missing high-value capability groups one slice at a time in explicit value order.

#### Scenario: first recovery slice starts

- **GIVEN** the planner has identified Claude Native / `claude-provider` as the highest-value missing capability chain
- **WHEN** build execution begins
- **THEN** the implementation agent must start with that slice before lower-priority recovery work

### Requirement: Oversized recovery slices must be decomposed before coding resumes

The system SHALL re-plan any recovery slice that proves larger than a bounded, verifiable execution slice.

#### Scenario: Claude Native first slice hits a stop gate

- **GIVEN** the current tree lacks the `packages/opencode-claude-provider` source scaffold and a live `claude-native` integration surface
- **WHEN** the initial Claude Native recovery slice is investigated
- **THEN** the planner must split it into smaller executable stages before build execution continues

### Requirement: Beta bootstrap precedes code-bearing recovery work

The system SHALL create and verify the beta execution surface before any code-bearing recovery slice starts.

#### Scenario: build mode resumes after re-planning

- **GIVEN** the authoritative base branch is `recovery/cms-codex-20260401-183212`
- **WHEN** build execution restarts
- **THEN** the first actionable coding step must be beta bootstrap, not direct code modification on the authoritative worktree

### Requirement: Historical branches are evidence sources, not merge authority

The system SHALL use historical commits and stale refs only as evidence for missing behavior, not as authority for direct merge-based restoration.

#### Scenario: a missing behavior is traced to an old branch

- **GIVEN** the desired behavior exists in a stale `cms`, `beta/*`, or `test/*` history line
- **WHEN** the agent restores the behavior
- **THEN** it must refactor the behavior into current recovery code instead of treating the old branch as merge authority

### Requirement: Restored provider list UI counts as already recovered

The system SHALL treat the `模型提供者` provider-list UI slice as functionally recovered for planning and prioritization.

#### Scenario: provider management work is prioritized

- **GIVEN** the current recovery branch already contains the provider dialog rename/polish patch and related provider-list recovery
- **WHEN** the remaining provider-management backlog is reviewed
- **THEN** the planner must exclude that restored UI slice from the high-priority missing list and only track the still-missing provider-manager behavior

### Requirement: Runtime todo derives from planner tasks

The system SHALL treat planner `tasks.md` unchecked checklist items as the runtime todo seed.

#### Scenario: plan is approved for execution

- **GIVEN** planner artifacts are execution-ready
- **WHEN** the plan is materialized into runtime execution
- **THEN** runtime todo must be derived from `tasks.md`, not from ad hoc conversational checklists

### Requirement: Same workstream extends the same plan

The system SHALL extend the existing plan root for the same workstream instead of creating a new sibling plan by default.

#### Scenario: a new idea or bug appears within the same workstream

- **GIVEN** an existing plan already captures the active workstream
- **WHEN** follow-up scope, fixes, or design slices are added
- **THEN** the planner must update the same plan root unless the user explicitly requests or approves a new plan

### Requirement: New plans require user-approved branching

The system SHALL only create a new plan root when the user explicitly requests one, or explicitly approves the assistant's proposal to branch.

#### Scenario: assistant detects a possible branch

- **GIVEN** the assistant sees adjacent but potentially separable work
- **WHEN** user approval has not been given
- **THEN** the assistant must not create a new plan root on its own

### Requirement: Completion includes retrospective review

The system SHALL produce a post-implementation review that compares implementation results against the effective requirement description.

#### Scenario: implementation is declared complete

- **GIVEN** execution work has been finished
- **WHEN** the assistant prepares completion reporting
- **THEN** it must provide concise requirement coverage, remaining gaps, and validation evidence without exposing raw internal chain-of-thought

### Requirement: Finalize remains approval-gated after validation

The system SHALL treat fetch-back, finalize, and disposable beta cleanup as a post-validation approval gate rather than an automatic continuation of `8.3`.

#### Scenario: provider-manager validation finishes

- **GIVEN** `8.3` focused validation has completed and retrospective closure artifacts are available
- **WHEN** the assistant reaches the finalize boundary
- **THEN** it must first prepare a recommendation, stop for user approval, and only after approval execute fetch-back/finalize/cleanup

## Acceptance Checks

- Planner artifacts explicitly list the recovery slice order and stop gates.
- The plan explicitly decomposes Claude Native into smaller executable stages after the first stop gate.
- The first build action is beta bootstrap from the authoritative recovery branch.
- The plan treats the `模型提供者` UI patch as recovered and does not re-open it as an untriaged gap.
- The handoff instructs build execution to recover by refactor, not branch merge.
- The plan makes `8.3` a near-final validation slice, but still requires retrospective closure and user-approved finalize/cleanup afterward.
