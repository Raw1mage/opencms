# Spec

## Purpose

- Define how the telemetry branch context sidebar display should be reorganized into a consistent, draggable card layout without breaking current data ownership boundaries.

## Requirements

### Requirement: Context sidebar legacy information is card-grouped

The system SHALL present the older context sidebar information as three grouped cards (`摘要 / Breakdown / Prompt`) instead of a loose text list.

#### Scenario: context tab renders legacy context information

- **GIVEN** the context sidebar contains existing non-telemetry context information
- **WHEN** the user opens the context sidebar/tab
- **THEN** that information must be organized into the `摘要 / Breakdown / Prompt` cards

### Requirement: Context sidebar layout stays visually consistent with telemetry cards

The system SHALL make the context sidebar feel like one unified card-based surface rather than a mixed old/new layout.

#### Scenario: telemetry cards and legacy context cards render together

- **GIVEN** the context sidebar contains both telemetry cards and older context information
- **WHEN** the user views the sidebar
- **THEN** the old and new sections must follow a consistent card-style layout

### Requirement: Context sidebar cards are reorderable

The system SHALL allow the user to drag and reorder context sidebar cards, aligned with the task status sidebar interaction model.

#### Scenario: user changes card order

- **GIVEN** the context sidebar shows multiple cards
- **WHEN** the user drags one card above or below another
- **THEN** the sidebar must reflect the new order and preserve it according to the chosen layout persistence contract

### Requirement: Display layer stays within current data boundaries

The system SHALL reorganize the context sidebar display without inventing new backend authority or fallback behavior.

#### Scenario: card layout refactor is implemented

- **GIVEN** existing context metrics and telemetry data sources remain available
- **WHEN** the sidebar is refactored into draggable cards
- **THEN** the implementation must continue consuming existing state boundaries rather than introducing new hidden data synthesis paths

### Requirement: Runtime todo derives from planner tasks

The system SHALL treat planner `tasks.md` unchecked checklist items as the runtime todo seed.

#### Scenario: plan is approved for execution

- **GIVEN** planner artifacts are execution-ready
- **WHEN** the plan is materialized into runtime execution
- **THEN** runtime todo must be derived from `tasks.md`, not from ad hoc conversational checklists

### Requirement: Same workstream extends the same plan

The system SHALL extend the existing plan root for the same workstream instead of creating a new sibling plan by default.

#### Scenario: a new idea or bug appears within the same workstream

- **GIVEN** an existing telemetry spec root already captures the active workstream
- **WHEN** follow-up scope, fixes, or design slices are added
- **THEN** the planner must update the same semantic root unless the user explicitly requests or approves a new split

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

- Context sidebar legacy information is grouped into `摘要 / Breakdown / Prompt` three-card layout.
- Context sidebar and telemetry area now read as a single card-based layout.
- Card drag ordering works for the context sidebar.
- Targeted app validation covers the touched context sidebar render/order path.
