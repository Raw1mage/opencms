# Spec

## Purpose

- Define how missing old `cms` functionality is decomposed and reconstructed on top of latest `main` without overwriting user-redone areas or blindly replaying git history.

## Requirements

### Requirement: Approved buckets restore selectively

The system SHALL restore only the buckets explicitly approved by the user for this plan.

#### Scenario: a missing bucket was approved during planning

- **GIVEN** the user approved a restore bucket in planning mode
- **WHEN** build execution begins
- **THEN** that bucket may be analyzed and restored according to this plan

### Requirement: User-redone areas stay skipped

The system SHALL not restore old commits for areas the user said were already redone.

#### Scenario: provider manager bucket appears in old missing commit history

- **GIVEN** provider manager changes exist in missing old commits
- **WHEN** execution builds the restore matrix
- **THEN** that bucket must be marked skipped instead of restored from old history

### Requirement: Restore is diff-first

The system SHALL compare current `main` behavior against old commit behavior before each restore slice.

#### Scenario: a bucket may already be partially present

- **GIVEN** a restore bucket was approved
- **WHEN** execution starts that bucket
- **THEN** it must first identify what is still truly missing before modifying code

### Requirement: Missing commits are translated into reconstruction problems

The system SHALL convert raw missing commits into feature-oriented reconstruction problems before build execution.

#### Scenario: planning prepares build work on latest `HEAD`

- **GIVEN** the repo is on latest `main` / `HEAD`
- **WHEN** planning analyzes missing commits
- **THEN** it must group them into larger reconstruction problems that can be implemented as new work on current `HEAD`

### Requirement: Reconstruction problems are decomposed before build

The system SHALL decompose each reconstruction problem into subproblems, dependencies, and keep-deprecated criteria before build execution begins.

#### Scenario: a reconstruction problem mixes multiple historical concerns

- **GIVEN** a reconstruction problem aggregates multiple commits or mixed-bucket history
- **WHEN** planning refines the problem map
- **THEN** it must split that problem into smaller subproblems, identify overlaps/dependencies, and record when a slice may be intentionally kept deprecated

### Requirement: Reconstruction targets newest workable result

The system SHALL treat the historical chain as an iteration path whose target is the newest workable result, not any earlier intermediate patch.

#### Scenario: later commits revise earlier implementations

- **GIVEN** an earlier missing commit was later revised, overridden, or superseded
- **WHEN** build execution reconstructs that feature on current `HEAD`
- **THEN** it must aim for the newest workable end state and preserve supersession evidence instead of replaying the older patch verbatim

### Requirement: Better present-day replacements may keep old features deprecated

The system SHALL allow a historical feature to remain deprecated when current `HEAD` offers a demonstrably better replacement.

#### Scenario: old feature is inferior to current mainline design

- **GIVEN** a missing historical feature is analyzed against the latest `HEAD`
- **WHEN** evidence shows the current solution is better integrated or more capable
- **THEN** the plan may classify the old feature as intentionally not restored, with explicit evidence and rationale recorded

### Requirement: Document artifacts follow same reconstruction rule

The system SHALL reconstruct `plans/`, `specs/`, and `docs/events/` artifacts to their newest coherent usable state.

#### Scenario: multiple docs commits evolved the same artifact

- **GIVEN** a document evolved across multiple missing commits
- **WHEN** planning/build restores documentation state
- **THEN** the target must be the final coherent document state rather than an arbitrary intermediate wording snapshot

### Requirement: Visible branding regression is first-class

The system SHALL treat the browser-title/icon branding regression as a restore target.

#### Scenario: current app shell still shows old branding

- **GIVEN** `packages/app/index.html` and `packages/ui/src/components/favicon.tsx` still show `OpenCode` / old favicon routes
- **WHEN** the branding bucket is executed
- **THEN** the restored behavior must align with the approved `TheSmartAI` branding direction

### Requirement: Completion includes retrospective review

The system SHALL produce a post-implementation review that compares execution results against the plan's approved buckets.

#### Scenario: restore execution is declared complete

- **GIVEN** approved restore slices have finished
- **WHEN** the assistant reports completion
- **THEN** it must provide bucket-by-bucket coverage, skipped items, deferred items, and validation evidence

## Acceptance Checks

- The plan clearly separates approved, skipped, and diff-first restore buckets.
- The plan contains a reconstruction-problem map derived from the missing commits.
- The plan decomposes each reconstruction problem into subproblems and dependencies.
- The plan allows explicit "keep deprecated" outcomes when current `HEAD` is better, with recorded evidence.
- Provider manager is recorded as skipped due to user rebuild work.
- Branding/browser-tab is recorded as an approved restore target.
- Validation/reporting requires bucket-by-bucket evidence instead of commit-count claims alone.
