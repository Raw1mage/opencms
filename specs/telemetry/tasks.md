# Tasks

## 1. Baseline freeze

- [x] 1.1 Confirm the real current telemetry path from runtime event emission through server snapshot/hydration to UI consumption.
- [x] 1.2 Record current-state facts separately from previous planning assumptions.
- [x] 1.3 Mark each existing path as inventory-only, recovery-only, or wrong steady-state authority.
- [x] 1.4 List every helper, monitor heuristic, hydration path, and fallback that must be demoted, replaced, or removed.

## 2. Event contract

- [x] 2.1 Define authoritative runtime telemetry event shapes for prompt, round, compaction, and future telemetry facts.
- [x] 2.2 Define event identity, ordering, replay, and idempotency semantics.
- [x] 2.3 Define which projector-owned updates are delivered downstream to the app.
- [x] 2.4 Reject any event contract that requires UI-side or page-hook-side telemetry synthesis.
- [x] 2.5 Write a minimum event matrix that lists event classes, producer boundaries, required identity fields, and replay assumptions.
- [x] 2.6 Map each event class back to the original product purpose: A111 prompt evidence or A112 round/session/compaction evidence.

## 3. Projector

- [x] 3.1 Define the server-side telemetry projector as the sole authoritative read-model owner.
- [x] 3.2 Define projector aggregate shape, lifecycle, and session scoping.
- [x] 3.3 Route monitor and `session.top` to projector-owned state without allowing them to regain authority.
- [x] 3.4 Add a hard stop gate if any downstream surface still needs to recreate telemetry truth outside the projector.
- [x] 3.5 Write a minimum projector aggregate matrix covering prompt telemetry, round telemetry, compaction telemetry, session summary, freshness metadata, and degraded/catch-up metadata.
- [x] 3.6 Explicitly mark which fields belong to projector authority and which belong only to downstream adapters.

## 4. Reducer cutover

- [x] 4.1 Define `global-sync` reducer actions and canonical `session_telemetry` shape.
- [x] 4.2 Define the UI surfaces that must read reducer-owned telemetry as pure consumers.
- [x] 4.3 Remove, replace, or degrade old page-hook, hydration, and monitor-helper writers.
- [x] 4.4 Define the exact cutover point after which legacy writers are forbidden from steady-state telemetry writes.
- [x] 4.5 Write an explicit forbidden-writer list covering every legacy page-level, helper-level, snapshot-level, and fallback-level telemetry writer after cutover.
- [x] 4.6 Define degraded-only behavior so fallback paths cannot silently become steady-state writers.
- [x] 4.7 Attach the forbidden-writer list to the implementation slice and verify it is enforced before declaring cutover complete.

## 5. Snapshot demotion

- [x] 5.1 Keep `session.top` only for bootstrap, reconnect, catch-up, buffer miss, and degraded recovery.
- [x] 5.2 Remove repeated page-level snapshot refresh as a steady-state dependency.
- [x] 5.3 Add a hard failure condition if any fallback silently re-promotes snapshot/hydration authority.

## 6. Cleanup

- [x] 6.1 Remove conflicting legacy helpers, heuristics, and fallback glue after authority cutover.
- [x] 6.2 Remove duplicate telemetry writers and any path that can recreate them.
- [x] 6.3 Sync consolidated telemetry docs and event logs to the final authority model.
- [x] 6.4 Stop if cleanup reveals architecture drift toward current-code shortcuts.

## 7. Validation

- [x] 7.1 Prove steady-state propagation follows runtime event → projector → reducer → UI consumer.
- [x] 7.2 Prove `session.top` is used only as bootstrap/catch-up/degraded transport.
- [x] 7.3 Prove hydration-first, monitor-first, and page-hook-first steady-state have been removed or demoted.
- [x] 7.4 Prove no duplicate authority, fallback promotion, partial migration hazard, or architecture drift remains.
- [x] 7.5 Prove A111 can answer prompt composition evidence questions using the final telemetry pipeline.
- [x] 7.6 Prove A112 can answer round/session/compaction evidence questions using the final telemetry pipeline.
- [x] 7.7 Record a validation matrix that ties each proof to a concrete command, fixture, or runtime evidence source.
- [x] 7.8 Record a final evidence table that combines architecture proof, product proof, and migration proof in one closeout artifact.

## 8. Companion context-sidebar slice alignment

- [x] 8.1 Consolidate context-sidebar optimization artifacts under `specs/telemetry/context-sidebar-optimization/`.
- [x] 8.2 Preserve the UI slice as presentation-only and subordinate to reducer-owned telemetry authority.
- [x] 8.3 Ensure consolidated telemetry docs point builders at the companion slice when working on context-sidebar telemetry cards.
