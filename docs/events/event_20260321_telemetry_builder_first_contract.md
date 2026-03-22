# Event: Telemetry Builder-First Contract Rewrite

**Date**: 2026-03-21
**Scope**: telemetry planning package, `specs/architecture.md`
**Status**: Completed

## Problem

The telemetry planning package had already moved away from snapshot-first language, but it still left too much room for builders to reinterpret ownership around the current implementation.

That ambiguity left four hazards alive:

- current state could still be mistaken for target state
- migration order could still be improvised during implementation
- hydration-first / monitor-first / page-hook-first steady-state could survive as “temporary” architecture
- `session.top` could still be re-promoted from recovery path to primary telemetry path

## Decision

Rewrite the package as a bus-messaging-first execution contract.

The package now explicitly separates:

- **Current State** — migration baseline only
- **Target State** — runtime emits telemetry events → server projector owns authoritative read model → app global-sync reducer owns canonical slice → UI is pure consumer → `session.top` is bootstrap/catch-up/degraded only
- **Migration Path** — baseline freeze → event contract → projector → reducer cutover → snapshot demotion → cleanup → validation

The package also explicitly demotes hydration-first, monitor-first, and page-hook-first steady-state as architecturally wrong and subject to removal or downgrade.

## Consequences

- Builders now have a single rewrite contract instead of a descriptive plan.
- Duplicate authority, fallback promotion, partial migration hazards, and architecture drift are documented as hard stop gates.
- `tasks.md` is now ordered as a builder checklist from baseline to target.
- `implementation-spec.md` now keeps exact execution-facing section order and stronger stop gates.
- `specs/architecture.md` now records current state separately from target telemetry ownership.
- The package now explicitly preserves the original product purpose: A111 prompt composition evidence and A112 round/session/compaction evidence.
- The package now requires an explicit minimum event matrix, projector aggregate matrix, and forbidden-writer list before cutover can be considered valid.

## Related Artifacts

- `specs/telemetry/proposal.md`
- `specs/telemetry/spec.md`
- `specs/telemetry/design.md`
- `specs/telemetry/implementation-spec.md`
- `specs/telemetry/tasks.md`
- `specs/telemetry/handoff.md`
- `specs/architecture.md`

## Builder Entry Clarification

The next builder should not start by patching monitor/snapshot/hydration code.

The next builder should start by producing three explicit planning outputs from the package:

1. minimum event matrix
2. minimum projector aggregate matrix
3. forbidden-writer list after reducer cutover

If any of those three are still implicit, the builder should stop and finish the planning output before coding.

## Baseline Freeze Evidence

The current branch baseline was re-checked against runtime and app code before starting projector work.

### Confirmed runtime facts

- `packages/opencode/src/session/llm.ts` publishes `llm.prompt.telemetry` with:
  - session/provider/model/account identity
  - final system prompt aggregate counts
  - per-block `{ key, chars, tokens, injected, policy }`
  - timestamp
- `packages/opencode/src/session/processor.ts` publishes `session.round.telemetry` with:
  - session/round/request/provider/model/account identity
  - usage totals
  - compaction-related fields (`needsCompaction`, `compactionResult`, `compactionDraftTokens`, `compactionCount`)
  - timestamp
- `packages/opencode/src/bus/subscribers/telemetry-runtime.ts` persists only two runtime telemetry event types today:
  - `llm.prompt.telemetry`
  - `session.round.telemetry`
- No dedicated `compaction` telemetry bus event is persisted yet; compaction evidence currently rides inside `session.round.telemetry` and monitor/message-derived summaries.

### Confirmed server/app authority facts

- `packages/opencode/src/session/monitor.ts` synthesizes `telemetry` onto monitor rows from session/message state (`roundIndex`, `requestId`, `compactionResult`, `compactionDraftTokens`, `compactionCount`) rather than replaying a projector-owned read model.
- `packages/opencode/src/server/routes/session.ts` exposes that monitor snapshot through `GET /session/top`.
- `packages/app/src/pages/session/use-status-monitor.ts` polls `session.top` and treats it as a live refresh source.
- `packages/app/src/context/sync.tsx` writes `session_telemetry[sessionID]` by calling `buildSessionTelemetryProjection(...)` locally in the app store.
- `packages/app/src/pages/session/monitor-helper.ts` reconstructs round/session telemetry from monitor entries plus message history.
- `packages/app/src/pages/session/session-telemetry-ui.ts` forces page-level hydration via `sync.session.telemetry(sessionID, { force: true, ... })`.

### Current-path classification

- **Inventory/runtime fact emission**: `session/llm.ts`, `session/processor.ts`
- **Inventory/runtime persistence**: `bus/subscribers/telemetry-runtime.ts`
- **Wrong steady-state authority**:
  - `session/monitor.ts`
  - `server/routes/session.ts` (`session.top`)
  - `pages/session/use-status-monitor.ts`
  - `context/sync.tsx` local `session_telemetry` write path
  - `pages/session/monitor-helper.ts`
  - `pages/session/session-telemetry-ui.ts`

## Materialized Minimum Event Matrix

This is the builder-facing matrix for the first implementation slice. It is anchored to the real current runtime baseline above and is the required contract before projector work starts.

| Event class                                              | Product purpose                   | Current runtime source                       | Producer boundary                                                                                  | Required identity                                                                                                   | Minimum projector-consumed payload                                                                             | Ordering / replay / idempotency                                                                                                                   | Baseline status                                                                                                 |
| -------------------------------------------------------- | --------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `llm.prompt.telemetry`                                   | A111 prompt composition evidence  | `packages/opencode/src/session/llm.ts`       | Prompt assembly / LLM preparation boundary                                                         | `sessionID`, `providerId`, `modelId`, prompt-scoped composition identity **TBD**, optional `accountId`, `timestamp` | Prompt block collection with per-block source/kind/policy/outcome/token estimate plus prompt aggregate totals  | Session-scoped ordering by emission time; projector replay requires a stable prompt identity because current payload only has timestamp + session | **Partially present** — emitted/persisted now, but missing explicit prompt identity and richer block provenance |
| `session.round.telemetry`                                | A112 round/session evidence       | `packages/opencode/src/session/processor.ts` | Session processor round completion boundary                                                        | `sessionID`, `roundIndex`, `requestId`, `providerId`, `modelId`, optional `accountId`, `timestamp`                  | Usage totals, finish reason, latency/duration when available, context/budget fields, compaction linkage fields | Replay/idempotency keyed by session + round/request identity; current event is the only persisted round fact surface                              | **Present** — emitted/persisted now; latency/duration is still not explicit                                     |
| `session.compaction.telemetry`                           | A112 compaction evidence          | Not emitted yet                              | Runtime compaction boundary                                                                        | `sessionID`, causal `roundIndex` and/or `requestId`, compaction attempt identity/index, `timestamp`                 | Draft size/token summary, result classification, attempt/count metadata                                        | Must be replay-safe per compaction attempt; cannot rely on UI/helper synthesis                                                                    | **Missing** — currently approximated from `session.round.telemetry` + monitor/message heuristics                |
| `session.summary.telemetry` or projector-derived summary | A112 cross-round session evidence | Not emitted as dedicated runtime event       | Projector-owned derivation from authoritative upstream events (or future runtime summary boundary) | `sessionID`, freshness marker, degraded/catch-up marker                                                             | Cumulative totals, latest round marker, latest compaction marker, session-wide evidence summary                | Projector owns derivation and replay; downstream consumers must not synthesize this summary                                                       | **Projector-only for now** — current app summary is synthesized locally in `monitor-helper.ts`                  |

### Contract notes for this slice

- Builder may use current runtime names as the baseline contract surface, but projector work must not assume prompt identity is solved until prompt-scoped identity is added.
- Compaction evidence is a hard gap in the current runtime baseline; builder must either add a dedicated compaction event or formalize a projector-owned derivation rule before claiming A112 coverage.
- Session summary is explicitly **not** a UI/helper responsibility; current app-side synthesis is baseline evidence of wrong authority, not an acceptable target design.
- `session.top` remains baseline-only evidence for this slice and must not be treated as the event matrix artifact or future authority surface.

## Validation

- Verified the package now separates current state, target state, and migration path.
- Verified the target architecture is consistently recorded as runtime events → server projector → app reducer → UI consumer.
- Verified `session.top` is consistently documented as bootstrap/catch-up/degraded only.
- Verified hydration-first / monitor-first / page-hook-first steady-state is explicitly marked as invalid and subject to demotion/removal.
- Verified the package now preserves original A111/A112 product-purpose traceability.
- Verified the package now requires explicit event-matrix / aggregate-matrix / forbidden-writer planning outputs before cutover work.
- Verified the current runtime baseline still emits and persists only `llm.prompt.telemetry` and `session.round.telemetry`.
- Verified compaction/session summary authority is still synthesized downstream today rather than owned by a projector.

## Materialized Minimum Projector Aggregate Matrix

The minimum projector aggregate matrix now lives in `specs/telemetry/handoff.md` under `## Materialized Minimum Projector Aggregate Matrix`.

It fixes the previously implicit second builder output by grounding each required aggregate in the real baseline:

- `promptSummary` from `llm.prompt.telemetry`
- `roundSummary` from `session.round.telemetry`
- `compactionSummary` from a missing dedicated compaction event or projector-only derivation
- `sessionSummary` as projector-only derivation
- `freshness` as projector lifecycle/delivery metadata

The matrix also makes the authority boundary explicit: projector owns the aggregate fields; monitor/`session.top`/reducer/UI are adapters only.

## Materialized Forbidden-Writer List

The forbidden-writer list now lives in `specs/telemetry/handoff.md` under `## Materialized Forbidden-Writer List For Reducer Cutover`.

It names the real current writer/synthesis entrypoints that must be removed, rewritten, or degraded-only after reducer cutover:

- `packages/app/src/pages/session/session-telemetry-ui.ts`
- `packages/app/src/context/sync.tsx`
- `packages/app/src/pages/session/monitor-helper.ts`
- `packages/opencode/src/session/monitor.ts`
- `packages/app/src/pages/session/use-status-monitor.ts`
- `packages/opencode/src/server/routes/session.ts`

## Implementation Slice Closeout

- Added stable prompt-scoped identity on `llm.prompt.telemetry` via `promptId` so projector replay/dedupe no longer depends on timestamp-only identity.
- Added dedicated `session.compaction.telemetry` emission/persistence so compaction evidence has its own bus event path instead of monitor/message synthesis.
- Added server-side telemetry projector aggregation from persisted runtime events and routed `SessionMonitor` / `session.top` telemetry payloads through projector-owned summaries.
- Added projector-owned `session.telemetry.updated` delivery so app `global-sync` can own canonical `session_telemetry` updates without rebuilding steady-state telemetry from monitor/message history.
- Demoted app-local telemetry synthesis by switching `sync.session.telemetry()` to projector payload ingestion and gating page hydration to bootstrap/catch-up behavior.
- Removed steady-state `session.top` → `sync.session.telemetry()` writes from `use-status-monitor.ts`; status polling now refreshes monitor UI only, while canonical telemetry stays reducer-owned via `session.telemetry.updated`.
- Restricted `useSessionTelemetryHydration()` / `sync.session.telemetry()` to bootstrap-only behavior when canonical telemetry is absent, preventing page-hook refresh loops from re-promoting snapshot authority after reducer cutover.
- Fixed stale-cache risk by ensuring the bootstrap path can recover from early empty projector state without reviving page-level steady-state authority.

## Final Validation Evidence

### Architecture proof

- Runtime fact path is now event-first: `llm.prompt.telemetry`, `session.round.telemetry`, and `session.compaction.telemetry` feed server-side runtime persistence and projector aggregation.
- Projector-owned summaries now feed `SessionMonitor` / `session.top` instead of monitor-side telemetry truth synthesis.
- App canonical telemetry is now updated by projector-owned delivery (`session.telemetry.updated`) rather than repeated snapshot/hydration writes.
- `use-status-monitor.ts` no longer performs steady-state `session.top` → canonical telemetry writes.

### Product proof

- A111 prompt composition evidence now preserves prompt-scoped identity and block-level evidence suitable for projector replay and downstream consumption.
- A112 round/session/compaction evidence now includes a dedicated compaction telemetry path instead of relying on monitor/message heuristics alone.

### Migration proof

- Hydration-first, monitor-first, and page-hook-first steady-state authority paths were removed or degraded to bootstrap-only behavior.
- Forbidden-writer list was materialized and enforced as cutover guidance.
- No remaining reviewed path is allowed to silently promote snapshot/hydration back into steady-state telemetry truth.

### Commands / fixtures / evidence sources

- `bun test --preload ./happydom.ts ./src/context/sync-optimistic.test.ts ./src/context/global-sync/event-reducer.test.ts ./src/pages/session/monitor-helper.test.ts` (`packages/app`)
- `bun test ./src/system/runtime-event-service.test.ts` (`packages/opencode`)
- `bun run typecheck` (`packages/app`)
- review evidence from app sync / use-status-monitor / session-telemetry-ui / monitor-helper / session-side-panel / tool-page / session monitor / runtime subscriber

## Closeout Status

The previously identified build-order blockers for this rewrite slice were addressed during implementation:

1. `llm.prompt.telemetry` now has stable prompt-scoped identity (`promptId`) for projector replay/dedupe.
2. Dedicated `session.compaction.telemetry` now exists, so compaction evidence is no longer forced to rely on monitor/message heuristics.
3. App-local canonical telemetry synthesis was replaced/demoted, so reducer cutover no longer depends on local helper authority.

## Remaining Limitation

- `session.top` still exists as bootstrap/catch-up/degraded transport and has not been removed from the route lifecycle entirely; this is acceptable for the current target as long as it does not regain steady-state authority.
