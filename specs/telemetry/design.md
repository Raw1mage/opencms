# Design

## Context

Telemetry currently exists, but not as a single authoritative DDS pipeline. Runtime emits facts, monitor/snapshot surfaces can expose telemetry, and app code hydrates `session_telemetry` from snapshot/monitor-derived data. That means authority is still split.

This design treats the current branch as migration baseline only. The target is a bus-first rewrite contract, not an optimization of snapshot-led behavior.

This semantic root also consolidates the context-sidebar telemetry card optimization slice so telemetry workstream artifacts do not remain split across dated roots.

## Current State

1. Runtime emits telemetry-related events from session/runtime processing.
2. Supported telemetry events are persisted by the runtime telemetry subscriber.
3. `SessionMonitor` builds telemetry-bearing monitor rows and `session.top` exposes them as snapshots.
4. App uses `use-status-monitor.ts` plus `sync.tsx` / `monitor-helper.ts` to hydrate `session_telemetry` from snapshot/monitor data.
5. UI mostly consumes telemetry, but steady-state truth is still influenced by hydration-first / monitor-first / page-hook-first paths.
6. Context sidebar optimization exists as a UI slice and must consume, not redefine, telemetry ownership.

## Target State

1. Runtime emits telemetry events as the source facts.
2. A server-side telemetry projector subscribes to those events and owns the authoritative session-scoped telemetry read model.
3. Downstream server transports publish projector-owned updates or projector-owned snapshots.
4. App `global-sync` reducer owns the canonical `session_telemetry` slice.
5. UI surfaces are pure consumers of reducer state.
6. `session.top` is used only for bootstrap, catch-up, reconnect, and degraded recovery.
7. Context-sidebar cards and telemetry-card ordering are downstream presentation behavior only.

## Architecture Decisions

- **AD-1**: Current state, target state, and migration path must never be mixed in the same descriptive layer.
- **AD-2**: Runtime owns fact emission only; it does not own app hydration or UI truth.
- **AD-3**: Server projector is the only authoritative telemetry read-model owner.
- **AD-4**: App `global-sync` reducer is the only canonical app telemetry owner.
- **AD-5**: UI is read-only and never reconstructs steady-state telemetry authority.
- **AD-6**: `session.top` is not a steady-state channel; it is a bootstrap/catch-up/degraded transport.
- **AD-7**: Hydration-first / monitor-first / page-hook-first steady-state is architecturally wrong and must be removed or demoted.
- **AD-8**: Event contract precedes projector design; projector design precedes reducer cutover; reducer cutover precedes snapshot demotion.
- **AD-9**: Builder must preserve telemetry's original product purpose: A111 prompt composition evidence and A112 round/session/compaction evidence.
- **AD-10**: Context-sidebar optimization remains a companion slice under `specs/telemetry/context-sidebar-optimization/` and must not override AD-1 through AD-9.

## Event Matrix

This section is the minimum builder-facing event contract. Builder must materialize it before projector work starts.

### E1. Prompt telemetry event

- **Purpose**: A111 prompt composition evidence
- **Producer boundary**: runtime prompt assembly / LLM preparation boundary
- **Minimum payload fields**:
  - session identity
  - prompt composition identity
  - block collection
  - block-level source / block kind / policy
  - block-level injected-vs-skipped outcome
  - block-level estimated size / token metadata
  - timestamp / ordering metadata
- **Identity requirements**:
  - session-scoped identity
  - prompt-scoped identity stable enough for projector dedupe/replay
- **Downstream expectation**:
  - projector can reconstruct authoritative prompt composition evidence without UI-side synthesis

### E2. Round telemetry event

- **Purpose**: A112 round/session evidence
- **Producer boundary**: runtime session/processor round boundary
- **Minimum payload fields**:
  - session identity
  - round identity
  - request identity
  - provider/account/model identity
  - token / usage summary
  - latency / duration summary where available
  - timestamp / ordering metadata
- **Identity requirements**:
  - round identity stable enough for projector replay/idempotency
  - request identity linkable to round/session summary
- **Downstream expectation**:
  - projector can answer which round/request caused growth without page-hook heuristics

### E3. Compaction telemetry event

- **Purpose**: A112 compaction evidence
- **Producer boundary**: runtime compaction boundary
- **Minimum payload fields**:
  - session identity
  - round identity or causal request identity
  - compaction draft size / token summary
  - compaction result classification
  - compaction count / attempt index where applicable
  - timestamp / ordering metadata
- **Identity requirements**:
  - event must correlate back to round/session summary
- **Downstream expectation**:
  - projector can answer when compaction happened and what result it produced

### E4. Session summary event or projector-derived summary

- **Purpose**: cross-round session evidence
- **Producer boundary**: either runtime summary emit or projector-owned derivation from authoritative upstream events
- **Minimum payload/result fields**:
  - session cumulative telemetry summary
  - freshness metadata
  - degraded / catch-up metadata
- **Constraint**:
  - if summary is projector-derived, derivation must remain inside projector ownership, not UI helpers

### Event-contract rules

- Builder must define ordering / replay / idempotency semantics before projector coding.
- Builder must map each event class back to A111 or A112 product evidence purpose.
- Any missing identity field that would force UI/helper-side authority synthesis is a design failure.

## Projector Aggregate Matrix

This section defines the minimum authoritative read-model shape. Builder must materialize it before reducer cutover starts.

### P1. Prompt telemetry summary

- authoritative source: prompt telemetry events
- minimum contents:
  - prompt composition identity
  - normalized block summaries
  - injected/skipped outcomes
  - per-block size/token contribution
  - prompt-level aggregate summary
- downstream note:
  - monitor/snapshot may adapt this view, but must not own or repair it

### P2. Round telemetry summary

- authoritative source: round telemetry events
- minimum contents:
  - round identity
  - request identity
  - provider/account/model identity
  - usage summary
  - duration/latency summary where available

### P3. Compaction telemetry summary

- authoritative source: compaction telemetry events
- minimum contents:
  - causal round/request reference
  - draft size summary
  - result classification
  - compaction count/attempt metadata

### P4. Session cumulative summary

- authoritative source: projector-owned derivation from upstream authoritative events
- minimum contents:
  - cumulative telemetry totals
  - latest round marker
  - latest compaction marker
  - session-wide evidence summary

### P5. Freshness / degraded metadata

- authoritative source: projector lifecycle and delivery state
- minimum contents:
  - last-updated metadata
  - bootstrap-needed / catch-up-needed marker
  - degraded-state marker

### Projector aggregate rules

- Fields in P1–P5 belong to projector authority unless explicitly marked downstream-adapter-only.
- Monitor rows, snapshot routes, and reducer updates are consumers of projector authority.
- If a downstream surface must invent missing P1–P5 fields, the aggregate is underspecified and build must stop.

## Companion UI Optimization Slice

- Context sidebar regrouping, drag ordering, and telemetry-card alignment are stored under `specs/telemetry/context-sidebar-optimization/`.
- That slice may refine layout-state, card grouping, and validation expectations for `packages/app`.
- It must continue consuming canonical `session_telemetry` and persisted layout state only; no authority synthesis is allowed there.

## App reducer slice

The canonical app slice must at minimum support:

- session-scoped telemetry aggregate
- freshness / loading source markers
- degraded / recovery markers
- enough normalized structure for sidebar/context surfaces to read without local authority synthesis

## Ownership Boundaries

### Runtime

- emits telemetry facts
- publishes telemetry events
- does not own read-model aggregation for app/UI

### Server Projector

- subscribes to runtime telemetry events
- maintains authoritative telemetry read model
- feeds downstream monitor/snapshot/event-delivery surfaces
- prevents downstream consumers from becoming telemetry authority

### App Global-Sync Reducer

- receives projector-owned updates
- maintains canonical `session_telemetry`
- is the only app-side telemetry writer in steady-state

### UI

- reads canonical telemetry state
- does not hydrate, synthesize, or promote fallback authority

## Migration Path

### 1. Baseline freeze

- Freeze and document the real current telemetry path.
- Mark every legacy authority path that still writes telemetry truth.

### 2. Event contract

- Define runtime telemetry event schema for prompt / round / compaction / future telemetry facts.
- Define ordering, identity, replay, and idempotency expectations.
- Reject any contract that requires UI-side synthesis to recover authority.

### 3. Projector

- Define projector aggregate shape and session-scoped ownership.
- Route monitor and snapshot surfaces to projector-owned state.
- Remove monitor-derived authority heuristics from steady-state.

### 4. Reducer cutover

- Define reducer actions and canonical `session_telemetry` shape.
- Move steady-state writes into global-sync reducer only.
- Demote or remove page-level hydration writers.
- Make cutover one-way: after cutover, legacy page-level and helper-level telemetry writers must not be allowed to re-enter steady-state authority.

### 5. Snapshot demotion

- Keep `session.top` only for bootstrap / catch-up / reconnect / degraded recovery.
- Remove steady-state dependence on repeated snapshot refresh.

### 6. Cleanup

- Remove conflicting helpers, hydration shortcuts, and authority duplication.
- Ensure no legacy fallback can re-promote snapshot/monitor/page-hook authority.

### 7. Validation

- Prove runtime event → projector → reducer → UI consumer flow.
- Prove `session.top` is secondary only.
- Prove no duplicate authority remains.

## Cutover Conditions

A reducer cutover is only considered complete when all of the following are simultaneously true:

- projector-owned updates can supply the canonical telemetry slice for steady-state
- UI surfaces can render from reducer-owned state without page-level truth synthesis
- legacy hydration/page-hook/helper paths are either removed or explicitly degraded-only
- `session.top` remains available only as bootstrap/catch-up/degraded transport
- no downstream consumer can silently promote fallback data into canonical telemetry truth

## Stop Gates

- **Duplicate authority**: stop if more than one steady-state writer can set canonical telemetry truth.
- **Fallback promotion**: stop if `session.top`, monitor hydration, or local fallback becomes a normal steady-state writer.
- **Partial migration hazards**: stop if projector/reducer land but old page/hydration writers still survive.
- **Architecture drift**: stop if implementation bends toward current shortcuts instead of bus-first ownership.

## Validation Matrix

### Architecture proof

Builder must prove:

- runtime facts flow through event contract before downstream state changes
- projector is the only telemetry read-model authority
- reducer is the only app-side canonical telemetry writer
- UI is read-only consumer
- `session.top` is not used as steady-state primary channel

### Product proof

Builder must prove at least these product questions can be answered:

- **A111**
  - which prompt blocks were injected vs skipped
  - what each block cost or contributed
  - which blocks dominate prompt budget
- **A112**
  - which round/request caused growth
  - when compaction happened
  - what compaction result and draft magnitude were
  - how session cost accumulates over time

### Migration proof

Builder must prove:

- old hydration-first steady-state no longer writes canonical telemetry
- old monitor-first/page-hook-first authority paths are removed or degraded-only
- no duplicate authority survives cutover
- degraded mode cannot silently become steady-state

### Companion slice proof

Builder must prove:

- context-sidebar optimization consumes reducer-owned telemetry only
- drag/persist behavior stays within layout-state boundaries
- no UI optimization patch recreates telemetry truth synthesis

## Builder Guidance

- Replace conflicting glue instead of preserving it.
- Do not use monitor output as the telemetry source of truth.
- Do not keep page hooks as long-term telemetry writers after reducer cutover.
- If recovery behavior cannot be clearly separated from steady-state behavior, stop and re-scope before coding.
