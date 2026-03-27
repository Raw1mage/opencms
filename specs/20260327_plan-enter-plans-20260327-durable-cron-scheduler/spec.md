# Spec

## Purpose

- 將 durable cron scheduler 的當前真實能力與剩餘缺口轉成可執行的 build/validation contract，避免後續任務重複把已解決的 durability 問題當成未知數。

## Requirements

### Requirement: Consolidate Durable Scheduler Baseline

The system SHALL represent durable cron scheduling according to current implementation truth, including persisted cron job state, boot-time schedule recovery, minute-level heartbeat cadence, and real daemon lifecycle wiring.

#### Scenario: Planning from existing repo evidence

- **GIVEN** the repo already contains `scheduler-channels` specs and 2026-03-27 cron bugfix event logs
- **WHEN** a new durable scheduler plan is created
- **THEN** the plan records those artifacts as the baseline instead of rewriting the scheduler from zero

### Requirement: Preserve Fail-Fast Runtime Verification

The system SHALL treat missing runtime execution evidence as a blocking validation failure rather than patching over it with fallback behavior.

#### Scenario: Live cron execution still has no run log

- **GIVEN** the daemon starts and a cron job becomes due
- **WHEN** live validation does not produce run-log JSONL or `/system/tasks` execution history
- **THEN** the build must stop for renewed investigation instead of adding compensating fallback behavior

### Requirement: Focus Follow-up Work on Remaining Gaps

The system SHALL scope follow-up implementation to hardening and validation gaps unless a new explicit planning decision expands the architecture boundary.

#### Scenario: Builder encounters channel-related old spec content

- **GIVEN** historical specs also describe channel and kill-switch extensions
- **WHEN** the builder executes this durable scheduler plan
- **THEN** the builder only touches those broader areas if the user explicitly reopens that scope

## Acceptance Checks

- Planner artifacts explicitly state which scheduler durability slices are already considered baseline-complete.
- Validation section requires both targeted tests and live operator-visible run evidence.
- Stop gates explicitly block fallback-based concealment of missing runtime behavior.
