# Spec: openspec-like planner

## Purpose

- Define an extensible planner package for this workstream, while preserving the broader rule that a repo may contain multiple plans.

## Requirements

### Requirement: One canonical plan root per evolving workstream

The system SHALL treat one planner package as the canonical root for the current workstream, rather than spawning a new sibling plan root for each follow-up slice.

#### Scenario: a new implementation slice appears during the same workstream

- **GIVEN** an existing approved planner package already captures the active workstream
- **WHEN** additional design/runtime slices are discovered
- **THEN** they must extend the same canonical plan root unless the workstream has materially changed

### Requirement: The main six planner files remain canonical

The system SHALL keep `proposal.md`, `spec.md`, `design.md`, `implementation-spec.md`, `tasks.md`, and `handoff.md` as the primary planner contract.

#### Scenario: extra artifacts are needed

- **GIVEN** deeper analysis requires additional docs
- **WHEN** those docs are created
- **THEN** they may live beside the main six files as supporting documents, not as a replacement sibling plan root

### Requirement: Runtime todo must derive from the canonical workstream package

The system SHALL continue to materialize runtime todo from the canonical package's `tasks.md`.

#### Scenario: build execution resumes

- **GIVEN** the canonical workstream plan package is the active planner root
- **WHEN** execution resumes
- **THEN** runtime todo must be derived from that package's `tasks.md`, not from ad hoc chat memory or a newer sibling package

### Requirement: Supporting docs may expand the same plan

The system SHALL allow runner, target-model, restart, and roadmap analyses to accumulate under the same plan root as supporting documents.

#### Scenario: runner/restart analysis deepens

- **GIVEN** the main planner package already exists
- **WHEN** the work needs runner contract or compatibility analysis
- **THEN** those documents should be added under the same plan root as supporting docs

### Requirement: Requirement history must be preserved for retrospective use

The system SHALL preserve the user's original requirement wording as close to verbatim as practical, plus a traceable history of later requirement changes, so post-implementation review has a stable baseline.

#### Scenario: the user changes direction mid-stream

- **GIVEN** a plan already contains earlier requirement wording
- **WHEN** the user adjusts, overturns, or narrows the request
- **THEN** the planner must record that revision explicitly rather than silently replacing the earlier requirement history

### Requirement: Completion must include a retrospective validation checklist

The system SHALL produce a post-implementation validation checklist derived from planner tasks, runtime todo state, implementation results, and executed validations.

#### Scenario: implementation is declared complete

- **GIVEN** the work has been implemented
- **WHEN** the assistant prepares the completion review
- **THEN** it must provide a concise, auditable checklist covering requirement satisfaction, remaining gaps, and validation evidence without exposing raw internal chain-of-thought

### Requirement: A repo may contain multiple plans only with user-approved branching

The system SHALL allow multiple planner roots in `/specs/`, but a new plan root may only be created when the user explicitly requests a new plan, or when the assistant proposes a new plan and the user explicitly approves it.

#### Scenario: a distinct workstream exists

- **GIVEN** another workstream has a different planning scope and evolution path
- **WHEN** the user explicitly asks for a separate plan, or explicitly approves the assistant's proposal to open one
- **THEN** it may exist as a separate `specs/<date>_<plan_title>/` root

#### Scenario: assistant notices a possible branch but no approval exists

- **GIVEN** the assistant detects adjacent ideas, bugs, or follow-up slices
- **WHEN** the user has not requested a new plan and has not approved creating one
- **THEN** the assistant must not open a new planner root on its own; it must extend the existing workstream plan or ask first

## Acceptance Checks

- `/specs/` contains a canonical planner root for this workstream: `20260315_openspec-like-planner`
- `/specs/` may also contain other distinct workstream roots
- The main six files exist in this root
- Supporting docs for this workstream live in the same root rather than separate sibling plan folders
- Runtime/path references point at the canonical workstream root instead of the fragmented predecessors
