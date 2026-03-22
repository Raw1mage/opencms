# Spec

## Purpose

- Define how the existing builder enters and executes beta-aware build mode without losing current capabilities, using deterministic builder-owned beta primitives for routine orchestration and keeping AI focused on implementation and judgment-heavy work.

## Requirements

### Requirement: Plan enter SHALL not blindly overwrite existing planner roots

The system SHALL refuse to blindly reinitialize planner artifacts when an existing planner root contains non-template or partial real content.

#### Scenario: implementation spec missing but other planner artifacts contain real content

- **GIVEN** the resolved planner root already contains proposal/design/tasks/handoff or diagrams with non-template content
- **WHEN** `plan_enter` is invoked
- **THEN** the system SHALL reuse or explicitly block the root instead of blindly rewriting the artifact set from templates

#### Scenario: brand new planner root has no meaningful content

- **GIVEN** the resolved planner root does not yet contain meaningful planner artifacts
- **WHEN** `plan_enter` is invoked
- **THEN** the system MAY initialize the artifact set from templates

### Requirement: Planner documents SHALL always be stored in the main repo

The system SHALL treat the authoritative main repo/worktree as the only valid storage location for planner/spec/event documents.

#### Scenario: planning is triggered while current worktree is beta

- **GIVEN** the current execution surface is a beta branch/worktree created for isolated build execution
- **WHEN** planning mode is requested
- **THEN** the system SHALL store `/plans`, `/specs`, and `docs/events` updates in the authoritative main repo/worktree instead of creating or modifying branch-local planner documents in the beta worktree

#### Scenario: planner document path resolves into beta worktree

- **GIVEN** planning is in progress and the resolved planner/spec/event write target would land inside a beta worktree
- **WHEN** the write is about to happen
- **THEN** the system SHALL block or reroute the write to the authoritative main repo/worktree before proceeding

### Requirement: Existing builder SHALL preserve current non-beta behavior

The system SHALL optimize the current builder flow without regressing approved non-beta build behavior.

#### Scenario: ordinary build plan without beta workflow

- **GIVEN** an approved plan that does not declare beta-loop execution intent
- **WHEN** `plan_exit` is invoked and builder enters build mode
- **THEN** the existing builder lifecycle SHALL continue to work with compatible behavior and without requiring beta-specific actions

### Requirement: Builder SHALL bootstrap beta execution on approved build entry

The system SHALL allow the existing builder to enter build mode through beta-loop bootstrap metadata and deterministic builder-owned orchestration.

#### Scenario: plan_exit approval with beta-loop-enabled plan

- **GIVEN** planner artifacts are complete and the approved plan declares beta-loop execution intent
- **WHEN** `plan_exit` is invoked and the operator answers Yes
- **THEN** the runtime SHALL resolve beta context, create or reuse the beta loop through builder-owned orchestration, materialize build todos, and emit build-mode handoff metadata containing beta execution context

#### Scenario: beta bootstrap requires explicit decision

- **GIVEN** `plan_exit` is preparing beta bootstrap but branch name or runtime policy is ambiguous
- **WHEN** builder-owned beta orchestration cannot resolve the required context safely
- **THEN** the system SHALL stop and require bounded clarification instead of entering build mode with guessed values

### Requirement: Builder SHALL validate through syncback semantics

The system SHALL support validation-phase syncback from beta execution into the main worktree using planner-approved runtime policy.

#### Scenario: validation step requests runtime refresh

- **GIVEN** build mode is executing a beta-loop-enabled plan and reaches a validation step
- **WHEN** validation requires the main runtime surface to reflect the feature branch
- **THEN** the runtime SHALL perform syncback-equivalent checkout behavior and invoke runtime start/refresh according to the resolved policy

#### Scenario: routine git operations are needed during build

- **GIVEN** build mode is executing on the beta branch and requires routine git progress operations
- **WHEN** branch checkout, commit, push, or pull are required by the approved workflow and policy allows them
- **THEN** the builder SHALL perform them through deterministic built-in flow instead of requiring repeated user prompts for those steps

#### Scenario: bootstrap rejects dirty mainline state

- **GIVEN** the main worktree contains uncommitted changes
- **WHEN** builder attempts beta bootstrap from plan-approved build entry
- **THEN** the system SHALL stop instead of opening a beta branch from a dirty mainline state

#### Scenario: syncback rejects uncommitted beta work

- **GIVEN** the beta branch contains uncommitted implementation changes
- **WHEN** builder attempts syncback for validation
- **THEN** the system SHALL stop instead of syncing back a dirty beta worktree; the validation boundary must use a committed beta branch head

### Requirement: Builder SHALL detect branch drift and prepare remediation with approval gate

The system SHALL detect when the authoritative main/base branch has advanced relative to the beta branch and prepare an explicit remediation path instead of silently rewriting beta history.

#### Scenario: main branch advanced before finalize

- **GIVEN** beta implementation work is complete and the authoritative main/base branch now contains commits not present when beta bootstrap originally occurred
- **WHEN** builder reaches finalize or another branch-consistency checkpoint
- **THEN** the system SHALL detect the drift, prepare rebase/remediation preflight, and require explicit approval before rebasing beta onto the new mainline

#### Scenario: remediation is required but beta branch is dirty

- **GIVEN** branch drift is detected but the beta worktree is not anchored to a clean committed head
- **WHEN** builder prepares remediation
- **THEN** the system SHALL stop instead of attempting rebase/remediation on dirty beta state

### Requirement: Builder SHALL own finalize progression but stop at destructive approval

The system SHALL allow builder to continue from successful validation into merge preflight, but SHALL not execute destructive finalize steps without explicit approval.

#### Scenario: build execution completes successfully

- **GIVEN** implementation and validation have passed in a beta-loop-enabled plan
- **WHEN** build mode reaches completion
- **THEN** the system SHALL prepare merge / cleanup preflight inside builder and pause for explicit approval before executing merge, worktree removal, or branch deletion

## Acceptance Checks

- Existing non-beta build-mode behavior remains compatible after beta-aware flow is added.
- `plan_exit` can emit beta-loop-aware handoff metadata only when planner artifacts are complete and beta execution is explicitly represented.
- Ambiguous branch/runtime decisions stop with explicit clarification requirements instead of guessed defaults.
- Builder-native beta orchestration replaces routine prompt-only AI git orchestration.
- Validation and finalize flow use deterministic built-in tooling while preserving approval gates.
- External beta/dev MCP is not required for the intended builder UX.
