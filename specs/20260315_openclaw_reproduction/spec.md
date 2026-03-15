# Spec: openclaw_reproduction

## Purpose

- 定義單一 OpenClaw reproduction 主計畫，將 benchmark 與 implementation planning 收斂為同一 authority。

## Requirements

### Requirement: Single planning authority

The OpenClaw-aligned runner work SHALL be tracked through a single active plan package.

#### Scenario: multiple historical openclaw plans exist

- **GIVEN** earlier benchmark and substrate plan packages exist
- **WHEN** the workstream is consolidated
- **THEN** a single active plan must become the execution authority and the older packages must be treated as reference history only

### Requirement: Benchmark and implementation slices coexist in the same plan

The active plan SHALL contain both benchmark conclusions and phased implementation slices.

#### Scenario: user asks what to build next

- **GIVEN** OpenClaw research has already been done
- **WHEN** the active plan is consulted
- **THEN** it must explain both the benchmark findings and the recommended build entry slice

### Requirement: First build slice remains lowest-risk

The consolidated plan SHALL keep Trigger + Queue substrate as the first implementation slice.

#### Scenario: build mode starts from consolidated plan

- **GIVEN** the user wants implementation after consolidation
- **WHEN** build handoff is prepared
- **THEN** the plan must still nominate Trigger + Queue substrate as the first build slice unless explicitly expanded
