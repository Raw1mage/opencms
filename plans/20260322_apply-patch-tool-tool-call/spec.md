# Spec

## Purpose

- Ensure `apply_patch` is observable during execution so operators can inspect a running patch card before completion.
- Preserve the current completed-state diff/diagnostics experience while adding execution-phase visibility.

## Requirements

### Requirement: Running-State Expandability

The system SHALL render `apply_patch` as an expandable block card while the tool is still running.

#### Scenario: Running card can be expanded before file metadata is complete

- **GIVEN** an `apply_patch` tool part is in `pending` or `running` state
- **WHEN** the session route renders the tool invocation
- **THEN** the UI shows a block-style card with expandable content instead of only a non-expandable inline placeholder

### Requirement: Execution-Phase Metadata

The system SHALL expose explicit `apply_patch` execution phases through tool metadata.

#### Scenario: Backend reports stable execution checkpoints

- **GIVEN** the backend has started processing a patch
- **WHEN** it reaches parse, plan, approval, apply, diagnostics, completion, or failure checkpoints
- **THEN** the tool metadata includes a phase label representing the current execution stage

### Requirement: Evidence-Backed Progress Display

The system SHALL only display progress derived from actual execution evidence.

#### Scenario: File progress is shown when known

- **GIVEN** the backend has computed the number of files to change and the current file being processed
- **WHEN** the TUI renders the `apply_patch` card
- **THEN** it shows total files, completed files, and current file only from emitted metadata, without guessing percentages or fabricated progress

### Requirement: Completed-State Compatibility

The system SHALL preserve final per-file diff and diagnostics rendering after the patch finishes.

#### Scenario: Completed patch still renders final diff data

- **GIVEN** an `apply_patch` execution finishes successfully
- **WHEN** the UI renders the completed tool part
- **THEN** it still shows per-file diff previews and diagnostics using the final metadata payload

### Requirement: Failure Visibility

The system SHALL expose failed patch state instead of leaving the card visually ambiguous.

#### Scenario: Patch application fails after partial progress

- **GIVEN** the backend encounters a patch failure after parsing or partial application
- **WHEN** the tool part updates to an error path
- **THEN** the metadata and card body identify the failure phase and surface any available partial file evidence

## Acceptance Checks

- A multi-file `apply_patch` card can be expanded before completion.
- Running-state UI visibly distinguishes at least `parsing`, `applying`, and `diagnostics`.
- Approval wait, if triggered, is shown as an explicit waiting phase rather than a silent static card.
- Completed-state rendering still shows file diffs and diagnostics.
- Failed-state rendering shows an error/failed phase instead of only an inert placeholder.
