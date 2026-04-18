# Spec: <plan-title>

## Purpose

- <behavioral intent of this change>

## Requirements

### Requirement: <name>
The system SHALL <behavior>.

#### Scenario: <name>
- **GIVEN** <context>
- **WHEN** <action>
- **THEN** <outcome>

### Requirement: Runtime todo derives from plan-builder tasks
The system SHALL treat plan-builder `tasks.md` unchecked checklist items as the runtime todo seed.

#### Scenario: plan is approved for execution
- **GIVEN** plan-builder artifacts are execution-ready
- **WHEN** the plan is materialized into runtime execution
- **THEN** runtime todo must be derived from `tasks.md`, not from ad hoc conversational checklists

### Requirement: Same workstream extends the same plan
The system SHALL extend the existing plan root for the same workstream instead of creating a new sibling plan by default.

#### Scenario: a new idea or bug appears within the same workstream
- **GIVEN** an existing plan already captures the active workstream
- **WHEN** follow-up scope, fixes, or design slices are added
- **THEN** the plan-builder must update the same plan root unless the user explicitly requests or approves a new plan

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

## Acceptance Checks

- <observable verification point>
- <runtime / UX / API / operator-visible acceptance check>
