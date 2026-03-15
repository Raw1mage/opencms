# Spec: autorunner planner retarget

## Purpose

- 定義 autorunner bootstrap、planner artifact、與 runner prompt contract 的可觀測行為，使 autonomous execution 不再被多餘常駐 skills 拉回顧問式回合制。

## Requirements

### Requirement: Bootstrap only loads workflow-critical defaults

The system SHALL stop treating `model-selector`, `software-architect`, `mcp-finder`, and `skill-finder` as default bootstrap loads for main-agent autorunner work.

#### Scenario: main agent starts a non-trivial development or autorunner task

- **GIVEN** the session enters a planning-first or execution-first development flow
- **WHEN** bootstrap guidance is read from AGENTS and prompt templates
- **THEN** only the workflow-critical default contract remains mandatory
- **AND** removed skills are described as on-demand capabilities rather than startup requirements

### Requirement: Planner hardcodes architecture-thinking fields

The system SHALL encode architecture/constraint/trade-off thinking inside planner artifacts and templates instead of depending on a default `software-architect` skill load.

#### Scenario: planner creates or refines an autorunner implementation spec

- **GIVEN** a planner artifact package under `/specs`
- **WHEN** the plan is updated for autorunner work
- **THEN** proposal/design/implementation-spec/tasks/handoff must contain explicit constraints, boundaries, decisions, risks, and delegation-aware execution slices

### Requirement: Agent workflow is delegation-first for autorunner

The system SHALL describe `agent-workflow` and runner continuation in terms of delegation-first, gate-driven execution.

#### Scenario: autonomous build-mode continuation advances planned work

- **GIVEN** an approved mission and planner-derived runtime todo
- **WHEN** the runner continues execution
- **THEN** it must prefer continuing the current actionable step or starting the next dependency-ready delegated step
- **AND** narration must not itself imply a user handoff unless a stop gate is active

### Requirement: Removed default skills remain on-demand only

The system SHALL preserve removed bootstrap skills as optional capabilities without representing them as always-loaded operational dependencies.

#### Scenario: capability routing evaluates a request outside the default workflow path

- **GIVEN** a task that truly needs MCP discovery, skill discovery, architecture consultation, or explicit model strategy
- **WHEN** routing guidance is consulted
- **THEN** the system may still recommend those skills on-demand
- **BUT** it must not claim they are part of the default autorunner startup contract

### Requirement: Planner todo seed reflects delegation-aware execution

The system SHALL materialize runtime todo from planner tasks using names and slices that support delegated execution, integration, and validation.

#### Scenario: plan_exit materializes todos for autorunner implementation

- **GIVEN** `tasks.md` contains execution-ready checklist items
- **WHEN** runtime todo is seeded from planner artifacts
- **THEN** the visible todo names must align with planner tasks
- **AND** the sequence must expose delegation/integration/validation steps instead of collapsing all work into generic implementation bullets

## Acceptance Checks

- `AGENTS.md` and `templates/AGENTS.md` no longer require default loading of `model-selector`, `software-architect`, `mcp-finder`, or `skill-finder`.
- Planner templates generated through `plan.ts` encode delegation-aware execution and architecture-thinking fields without placeholder-only wording.
- `runner.txt` and plan/build prompt surfaces explicitly separate narration from pause and describe delegation-first continuation.
- `enablement.json` and template prompts describe removed skills as optional/on-demand rather than preferred default routing for standard autorunner development flow.
