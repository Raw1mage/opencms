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
