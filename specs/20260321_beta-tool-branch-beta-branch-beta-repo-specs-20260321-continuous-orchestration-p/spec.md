# Spec: Continuous Orchestration

## Purpose

- Define the behavior contract for non-blocking subagent dispatch and automatic Orchestrator continuation.

## Requirements

### Requirement: Task dispatch returns immediately
The system SHALL return a successful `task()` tool result immediately after the child session / worker dispatch is established.

#### Scenario: dispatching a coding subagent
- **GIVEN** the Orchestrator invokes `task()` with a valid child-session payload
- **WHEN** the child session and worker process are created successfully
- **THEN** the tool result SHALL return dispatch metadata without waiting for the worker to finish

### Requirement: Parent Orchestrator resumes on task completion
The system SHALL resume the parent Orchestrator session when a subagent completes or fails.

#### Scenario: worker completes successfully
- **GIVEN** a subagent has been dispatched from a parent Orchestrator session
- **WHEN** the runtime receives the corresponding completion event
- **THEN** the system SHALL inject a synthetic continuation message into the parent session and enqueue the parent session for execution

#### Scenario: worker fails
- **GIVEN** a subagent has been dispatched from a parent Orchestrator session
- **WHEN** the runtime receives the corresponding failure event
- **THEN** the system SHALL inject an actionable failure summary into the parent session and enqueue the parent session for recovery handling

### Requirement: No silent fallback to blocking orchestration
The system SHALL fail fast if completion evidence or parent-session identity is missing instead of silently reverting to the old blocking behavior.

#### Scenario: completion event lacks required identity
- **GIVEN** the completion handler cannot prove the parent session or task identity
- **WHEN** it evaluates whether to resume the Orchestrator
- **THEN** it SHALL surface an explicit error path rather than block silently or guess a target session

### Requirement: Runtime todo derives from planner tasks
The system SHALL treat planner `tasks.md` unchecked checklist items as the runtime todo seed.

#### Scenario: build mode starts from this plan
- **GIVEN** planner artifacts are execution-ready
- **WHEN** implementation begins
- **THEN** runtime todo SHALL be derived from `tasks.md`, not from ad hoc conversational checklists

### Requirement: Completion includes retrospective review
The system SHALL produce a completion review that compares implementation results against the effective requirement description.

#### Scenario: implementation is declared complete
- **GIVEN** execution work has been finished
- **WHEN** the assistant prepares completion reporting
- **THEN** it SHALL provide requirement coverage, remaining gaps, and validation evidence without exposing raw internal chain-of-thought

## Acceptance Checks

- Dispatch metadata is returned before the child worker finishes.
- Successful task completion resumes the parent Orchestrator without user input.
- Failure completion resumes the parent Orchestrator with actionable error context.
- No code path silently falls back to blocking orchestration semantics.
- Tasks, event log, and architecture sync evidence are aligned at completion.
