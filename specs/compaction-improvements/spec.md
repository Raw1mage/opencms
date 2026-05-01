# Spec: compaction-improvements

## Purpose

Improve the compaction subsystem so high-context sessions recover before provider cache loss becomes an outage, while keeping runtime responsibility limited to safety boundaries, explicit evidence, and provider-aware routing.

## Requirements

### Requirement: R1 cache-loss-aware trigger inventory

#### Scenario: predicted cache miss at high context

- **GIVEN** a session has durable message-stream state and recent usage metadata
- **WHEN** the runtime evaluates compaction predicates before the next model call
- **THEN** it walks an explicit precedence-ordered trigger inventory with boundary guards for last user presence, assistant-turn completion, cooldown, and child compaction loops.

### Requirement: R2 codex server-side compaction priority

#### Scenario: codex subscription prefers server-side compaction

- **GIVEN** the active execution provider is codex with OAuth subscription credentials
- **WHEN** context is high enough for server-side compaction to be cost-effective
- **THEN** codex inline context management and low-cost-server chain ordering are preferred without changing non-codex provider economics.

### Requirement: R3 edge cleanup safety

#### Scenario: edge cleanup uses durable evidence

- **GIVEN** cooldown, empty output, provider switch, rebind, or narrative-summary edge cases occur
- **WHEN** compaction logic runs
- **THEN** state is derived from durable stream/session evidence where possible and never fails by silently skipping a safer fallback.

### Requirement: R4 context budget surfacing

#### Scenario: previous provider usage is surfaced to the LLM

- **GIVEN** the previous provider response included server-confirmed usage metadata
- **WHEN** the next user-message envelope is assembled
- **THEN** the LLM receives a cache-safe context budget block with status labels and no behavioral prescription.

### Requirement: R5 telemetry and observability

#### Scenario: runtime decisions emit bounded telemetry

- **GIVEN** predicates, chain resolution, budget surfacing, or boundary routing are evaluated
- **WHEN** the runtime makes a decision
- **THEN** structured telemetry records the inputs and outcome without leaking raw attachment content or secrets.

### Requirement: R6 big content boundary handling

#### Scenario: oversized content crosses a runtime boundary

- **GIVEN** user uploads or subagent returns would inject oversized raw content into the main context
- **WHEN** the boundary is crossed
- **THEN** raw content is routed to session-scoped storage and the main context receives a lightweight reference plus query tools.

## Acceptance Checks

- Trigger inventory unit tests cover precedence and boundary guards.
- Kind-chain tests prove codex subscription reordering and non-codex parity.
- Edge cleanup tests cover provider-switched replay-tail fallback and stale token refresh.
- Budget surfacing tests prove user-message injection is last-message scoped and cache-safe.
- Big-content tests prove oversized content is stored by reference and raw bodies do not enter main context.
