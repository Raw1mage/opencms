# Spec

## Purpose

定義 telemetry 從 current-state snapshot/hydration reality 遷移到 bus-messaging-first target 的需求、ownership、stop gates、與 builder 驗收標準，並將 context-sidebar telemetry card optimization 納入同一語義 spec root 的 companion slice。

## Current State

- Runtime telemetry emission exists.
- Runtime telemetry persistence exists for supported event types.
- `session.top` currently exposes telemetry-bearing monitor snapshots.
- App currently hydrates `session_telemetry` from snapshot/monitor helpers.
- Context sidebar optimization planning exists as a separate UI-oriented slice, but it must remain downstream of canonical telemetry ownership.
- Current state is migration baseline only.

## Target State

The target architecture SHALL be:

- runtime emits telemetry events
- server-side projector owns the authoritative telemetry read model
- app global-sync reducer owns the canonical telemetry slice
- UI is a pure consumer
- `session.top` is bootstrap / catch-up / degraded only
- context-sidebar telemetry cards consume reducer-owned telemetry without becoming authority owners

## Migration Path

The implementation path SHALL be ordered as:

1. baseline freeze
2. event contract
3. projector
4. reducer cutover
5. snapshot demotion
6. cleanup
7. validation

## Requirements

### Requirement: Documents must separate current state, target state, and migration path

The planning package SHALL describe current state, target state, and migration path as distinct sections.

#### Scenario: Builder reads the package without misreading baseline as target

- **GIVEN** the branch still contains snapshot refresh and hydration-led telemetry paths
- **WHEN** builder reads the package
- **THEN** those paths are described only as current-state baseline and migration hazards, not as target design

### Requirement: Telemetry rewrite must preserve original product purpose

The system SHALL preserve telemetry's original product purpose while rewriting the architecture.

#### Scenario: Builder rewrites architecture without losing telemetry usefulness

- **GIVEN** telemetry rewrite work is focused on DDS ownership
- **WHEN** builder defines event contracts, projector aggregate, and reducer slice
- **THEN** the resulting system must still support A111 prompt composition evidence and A112 round/session/compaction evidence

### Requirement: Telemetry steady-state must be bus-messaging-first

The system SHALL define telemetry steady-state as runtime event flow into a server-side projector and then into app global-sync reducer state.

#### Scenario: Runtime fact reaches UI

- **GIVEN** runtime emits prompt / round / compaction telemetry
- **WHEN** telemetry changes during steady-state
- **THEN** the update path is runtime event → server projector → app reducer → UI consumer

### Requirement: Event contract must be explicit before build cutover

The system SHALL define telemetry event contract details before projector or reducer implementation begins.

#### Scenario: Builder needs stable runtime facts before downstream ownership is built

- **GIVEN** builder is about to implement telemetry rewrite
- **WHEN** builder enters event-contract work
- **THEN** the plan must specify at minimum event classes, producer boundaries, identity fields, replay assumptions, and downstream aggregate expectations

### Requirement: Server projector must be the sole telemetry authority

The system SHALL define the server-side projector as the only authoritative telemetry read-model owner.

#### Scenario: Downstream consumers need telemetry

- **GIVEN** monitor rows, `session.top`, or any other transport need telemetry data
- **WHEN** they read telemetry
- **THEN** they consume projector-owned state and do not recreate telemetry authority outside the projector

### Requirement: Projector aggregate shape must be explicit

The system SHALL define the minimum authoritative telemetry aggregate shape owned by the projector.

#### Scenario: Builder needs a stable server-side read model

- **GIVEN** server-side telemetry projector is being designed
- **WHEN** builder defines the read model
- **THEN** the plan must at minimum describe prompt telemetry, round telemetry, compaction telemetry, session summary, freshness metadata, and degraded/catch-up metadata boundaries

### Requirement: App global-sync reducer must own canonical telemetry slice

The system SHALL define app `global-sync` reducer ownership for canonical telemetry state.

#### Scenario: UI reads telemetry

- **GIVEN** telemetry cards, context panels, or runner surfaces need telemetry
- **WHEN** app state is consumed
- **THEN** UI reads reducer-owned `session_telemetry` and does not derive separate steady-state truth in page hooks or helpers

### Requirement: Hydration-first, monitor-first, and page-hook-first steady-state are invalid

The system SHALL treat hydration-first, monitor-first, and page-hook-first telemetry steady-state as architecturally wrong.

#### Scenario: Legacy path remains after cutover

- **GIVEN** old snapshot refresh, hydration projection, or monitor helper still writes canonical telemetry during steady-state
- **WHEN** validation runs
- **THEN** the result is a failure, not an acceptable intermediate state

### Requirement: session.top must be secondary only

The system SHALL retain `session.top` only for bootstrap, catch-up, reconnect, and degraded recovery.

#### Scenario: Client boots or misses events

- **GIVEN** a new client, reconnect, or SSE gap
- **WHEN** the app needs recovery data
- **THEN** it may call `session.top`, but steady-state updates must not depend on repeated snapshot refresh

### Requirement: Reducer cutover must be explicit and one-way

The system SHALL define the cutover condition after which legacy page-level and helper-level telemetry writers are forbidden from steady-state writes.

#### Scenario: Builder reaches reducer cutover

- **GIVEN** reducer-owned `session_telemetry` is available
- **WHEN** builder performs cutover
- **THEN** the plan must state which legacy writers are removed, replaced, or degraded-only, and forbid them from writing steady-state truth after cutover

### Requirement: Rewrite may replace conflicting legacy glue

The system SHALL allow builder to delete, demote, or replace current telemetry glue that conflicts with the target architecture.

#### Scenario: Existing helper conflicts with ownership contract

- **GIVEN** a current helper preserves snapshot/hydration authority
- **WHEN** builder executes the rewrite
- **THEN** builder may remove or demote that helper without preserving its steady-state role

### Requirement: Context-sidebar optimization must remain downstream of telemetry authority

The system SHALL treat context-sidebar / telemetry-card optimization as a presentation-layer companion slice under the same telemetry spec root.

#### Scenario: Sidebar optimization is implemented alongside telemetry rewrite

- **GIVEN** the context sidebar is reorganized into cards or reorderable sections
- **WHEN** that work reads telemetry data
- **THEN** it must consume projector/reducer-owned telemetry and must not introduce new telemetry authority or fallback promotion

### Requirement: Stop gates must block incorrect intermediate states

The planning package SHALL define stop gates for duplicate authority, fallback promotion, partial migration hazards, and architecture drift.

#### Scenario: Projector exists but legacy writer still survives

- **GIVEN** projector and reducer are present
- **WHEN** an old hydration or fallback path can still overwrite canonical telemetry
- **THEN** the migration must stop until duplicate authority is removed

## Acceptance Checks

- All package docs explicitly separate current state, target state, and migration path.
- All package docs define the same target pipeline: runtime events → server projector → app reducer → UI consumer.
- All package docs describe `session.top` as bootstrap/catch-up/degraded only.
- All package docs mark hydration-first / monitor-first / page-hook-first steady-state as invalid and demoted/removed.
- `tasks.md` follows the required builder order: baseline freeze → event contract → projector → reducer cutover → snapshot demotion → cleanup → validation.
- `implementation-spec.md` preserves the required section order and includes strong stop gates.
- `handoff.md` is concrete enough for a build agent to start without reinterpreting ownership.
- The package explicitly preserves telemetry's original product purpose: A111 prompt composition evidence and A112 round/session/compaction evidence.
- The plan defines event-contract expectations with enough precision that builder does not have to invent basic identity/replay/ownership rules.
- The plan defines projector aggregate boundaries and one-way reducer cutover conditions clearly enough to prevent duplicate authority by interpretation.
- The consolidated root includes a companion context-sidebar optimization slice that remains presentation-only.
