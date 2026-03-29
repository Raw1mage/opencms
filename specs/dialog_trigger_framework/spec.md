# Spec

## Purpose

定義 `dialog_trigger_framework` 在 opencode 中的正式語意與 runtime 邊界，讓 planner / prompt / tool-surface / approval 相關行為不再只存在於分散實作與 dated plans 中。

## Requirements

### Requirement: Trigger Decisions Are Rule-First And Deterministic

The system SHALL treat first-version dialog trigger decisions as deterministic runtime policy, not free-form model improvisation.

#### Scenario: Round-boundary trigger evaluation
- **GIVEN** a user message arrives at a round boundary
- **WHEN** the runtime evaluates planning/workflow triggers
- **THEN** the decision is derived from explicit detector + policy logic rather than an implicit in-flight governor model

#### Scenario: No hidden classifier fallback
- **GIVEN** trigger intent is ambiguous
- **WHEN** the first-version framework cannot classify it confidently with explicit rules
- **THEN** the system does not invent hidden fallback orchestration and must remain conservative

### Requirement: Detector / Policy / Action Layers Stay Distinct

The system SHALL preserve a three-layer contract for trigger handling.

#### Scenario: Detector role
- **GIVEN** input wording and runtime state
- **WHEN** detector logic runs
- **THEN** it identifies candidate trigger intent without directly mutating planner/runtime state

#### Scenario: Policy role
- **GIVEN** a candidate trigger and current workflow context
- **WHEN** policy evaluation runs
- **THEN** it decides whether the trigger is allowed, blocked, deferred, or should stop for approval/decision

#### Scenario: Action role
- **GIVEN** a permitted trigger decision
- **WHEN** action routing executes
- **THEN** it invokes the appropriate planner/workflow behavior at the correct boundary rather than blending decision and mutation logic together

### Requirement: Next-Round Rebuild Is The First-Version Capability Surface Contract

The system SHALL treat capability/tool-surface changes as dirty-flag plus next-round rebuild, not in-flight hot swap.

#### Scenario: Tool surface changes
- **GIVEN** MCP/app/runtime capability state changes during or between rounds
- **WHEN** the framework recognizes the surface as dirty
- **THEN** the runtime rebuilds the tool surface on the next resolution cycle instead of mutating the active in-flight round substrate

#### Scenario: No in-flight tool hot reload
- **GIVEN** a first-version framework decision
- **WHEN** capabilities change mid-round
- **THEN** the framework does not claim same-round hot reload semantics it cannot enforce safely

### Requirement: Replan Boundary Stays Narrow In V1

The system SHALL keep `replan` conservative in the first version.

#### Scenario: Replan requires active execution context
- **GIVEN** the user says wording similar to replan or direction change
- **WHEN** there is no active execution context
- **THEN** the system does not escalate that message into a `replan` workflow trigger automatically

#### Scenario: Replan requires material direction change
- **GIVEN** there is active execution context
- **WHEN** the user expresses a real direction/scope change rather than a status check or casual mention
- **THEN** the framework may treat it as `replan`

### Requirement: Approval Boundary Is Centralized But Intentionally Limited In V1

The system SHALL centralize approval detection/routing without overclaiming deeper orchestration beyond what the runtime currently enforces.

#### Scenario: Approval wait-state routing
- **GIVEN** the workflow is already waiting on approval
- **WHEN** approval-like user wording arrives
- **THEN** the framework routes it through the centralized approval decision surface

#### Scenario: No false deep orchestration claim
- **GIVEN** approval-like wording appears outside the relevant wait state
- **WHEN** the system evaluates it
- **THEN** the framework stays conservative and does not synthesize deeper runtime orchestration it does not formally own yet

### Requirement: plan_enter Naming Repair Is A First-Class Slice

The system SHALL treat `plan_enter` active-root naming repair as part of the framework contract, not as incidental UI cleanup.

#### Scenario: Slug derivation alignment
- **GIVEN** a new planning package is created
- **WHEN** `plan_enter` derives the active plan root name
- **THEN** the derived slug should align with the actual task topic instead of drifting to a generic or misleading template name

#### Scenario: No silent lifecycle rewrite
- **GIVEN** naming repair work is implemented
- **WHEN** it touches planner root derivation
- **THEN** it must remain within explicit slug/topic alignment scope unless a broader lifecycle redesign is separately planned and approved

## Canonical References

- `specs/dialog_trigger_framework/design.md`
- `specs/dialog_trigger_framework/handoff.md`
- `specs/architecture.md`
- Historical execution package:
  - `plans/20260327_plan-enter-plans-20260327-durable-cron-scheduler/`
