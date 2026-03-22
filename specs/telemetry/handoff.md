# Handoff

## Execution Contract

- Read `implementation-spec.md` first.
- Read the rest of the telemetry package before coding.
- Treat current code as migration baseline only, not target truth.
- Build to the bus-first target even when current shortcuts suggest an easier patch.
- Do not ship a partial cutover that leaves duplicate telemetry authority alive.
- If the task touches context-sidebar telemetry cards, also read `context-sidebar-optimization/` and keep that work downstream of canonical telemetry ownership.

## Current State

- Runtime telemetry events exist.
- Supported telemetry events are persisted by the runtime subscriber.
- `SessionMonitor` and `session.top` currently expose telemetry-bearing snapshots.
- App currently refreshes and hydrates `session_telemetry` through monitor/snapshot-led paths.
- Hydration-first / monitor-first / page-hook-first steady-state still exists today and is wrong by target architecture.
- Context-sidebar optimization artifacts exist as a presentation-layer companion slice within this same root.

## Target State

- runtime emits telemetry events
- server-side projector owns authoritative telemetry read model
- app global-sync reducer owns canonical telemetry slice
- UI is pure consumer
- `session.top` is bootstrap / catch-up / degraded only
- context-sidebar optimization remains a pure consumer of canonical telemetry state

## Migration Path

1. baseline freeze
2. event contract
3. projector
4. reducer cutover
5. snapshot demotion
6. cleanup
7. validation

## Non-Negotiable Demotions

The following steady-state patterns must be removed or demoted:

- hydration-first telemetry authority
- monitor-first telemetry authority
- page-hook-first telemetry authority
- repeated snapshot refresh as primary telemetry channel
- local fallback that can overwrite canonical telemetry truth

## Stop Gates In Force

- Stop on duplicate authority.
- Stop on fallback promotion.
- Stop on partial migration hazards.
- Stop on architecture drift toward current shortcuts.
- Stop for approval if telemetry work expands beyond telemetry ownership boundaries.

## Companion Slice

- `context-sidebar-optimization/` contains the former telemetry optimization package under this root.
- Use it for context tab card regrouping, drag ordering, and sidebar validation expectations.
- If that slice conflicts with bus-first telemetry ownership, this root wins.

## Build Entry Recommendation

- Start by freezing the baseline and writing down every wrong current authority path.
- Do event contract before projector work.
- Do projector before reducer cutover.
- Do reducer cutover before snapshot demotion.
- Do cleanup before final validation proof.
- Do not start projector implementation until the minimum event matrix is written and accepted.
- Do not start reducer cutover until the minimum projector aggregate matrix is written and accepted.
- Do not declare cutover complete until the forbidden-writer list is enforced.

## Materialized Minimum Projector Aggregate Matrix

This artifact is now explicit for the first implementation slice. It is grounded in the current runtime/app baseline and is the minimum builder contract before reducer work starts.

| Aggregate           | Authoritative source                                                                                                | Minimum fields under projector ownership                                                                                                                                                                     | Downstream adapter-only fields / notes               | Baseline surprise affecting build order                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptSummary`     | `llm.prompt.telemetry` runtime events                                                                               | `sessionID`, prompt-scoped identity, provider/model/account identity, normalized block summaries, injected/skipped outcomes, per-block chars/tokens, prompt aggregate totals, event timestamp/order metadata | UI labels, presentation grouping, display formatting | Current event lacks an explicit prompt-composition identity; projector work must not assume dedupe/replay is solved until that identity lands |
| `roundSummary`      | `session.round.telemetry` runtime events                                                                            | `sessionID`, `roundIndex`, `requestId`, provider/model/account identity, finish reason, usage totals, budget/context fields, timestamp/order metadata                                                        | UI wording, cosmetic rollups                         | Current persisted round event is usable baseline, but explicit latency/duration is still absent                                               |
| `compactionSummary` | dedicated `session.compaction.telemetry` event or projector-owned derivation from authoritative runtime events only | `sessionID`, causal `roundIndex` and/or `requestId`, compaction attempt/count identity, result classification, draft token/size summary, timestamp/order metadata                                            | UI badges/status copy                                | No dedicated compaction event exists yet; current monitor/message heuristics are not valid projector authority                                |
| `sessionSummary`    | projector-owned derivation from authoritative upstream events                                                       | `sessionID`, cumulative token/cost/request totals, latest round marker, latest compaction marker, session-wide evidence summary                                                                              | UI grouping/cards, local sorting                     | Current app computes this in `monitor-helper.ts`; that synthesis must move behind projector ownership before cutover                          |
| `freshness`         | projector lifecycle / delivery state                                                                                | projector version or sequence, last-updated timestamp, last-applied event marker, bootstrap-needed marker, catch-up-needed marker, degraded-state marker                                                     | relative time strings, loading skeletons             | No projector lifecycle state exists yet, so bootstrap/catch-up semantics must be designed with projector introduction                         |

### Aggregate authority rule

- Everything in the third column is projector authority and may be mirrored downstream but never invented downstream.
- Monitor rows, `session.top`, reducer actions, and UI selectors are adapters/consumers only.
- If reducer or UI code still has to synthesize any missing field above, projector work is incomplete and reducer cutover must stop.

## Materialized Forbidden-Writer List For Reducer Cutover

### Cutover point

Legacy writers become forbidden the moment a session has projector-owned telemetry delivery wired into the canonical app reducer path for steady-state updates. After that point, only projector → reducer may write canonical `session_telemetry` truth for that session.

### Forbidden steady-state writers after cutover

| Forbidden writer path                          | Real current entrypoint                                                                                                                              | Why it is forbidden after cutover                                                          | Allowed degraded-only role                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Page-level forced telemetry hydration          | `packages/app/src/pages/session/session-telemetry-ui.ts` via `useSessionTelemetryHydration()` calling `sync.session.telemetry(..., { force: true })` | Re-promotes page-hook-first authority and bypasses projector ownership                     | May trigger bootstrap fetch only if it does not write canonical steady-state truth directly             |
| App-local telemetry projection writer          | `packages/app/src/context/sync.tsx` `session.telemetry()` writing `session_telemetry[sessionID] = buildSessionTelemetryProjection(...)`              | Reconstructs canonical telemetry inside app state from local messages/monitor inputs       | Temporary bootstrap adapter only if rewritten to accept projector-owned payload without local synthesis |
| Monitor-helper authority synthesis             | `packages/app/src/pages/session/monitor-helper.ts` `buildSessionTelemetryProjection()`, `readRoundSummary()`, `readSessionSummary()`                 | Synthesizes round/session truth from monitor entries, message history, and local fallbacks | Read-only adapter/selectors may remain only after synthesis logic is removed                            |
| Monitor snapshot telemetry synthesis           | `packages/opencode/src/session/monitor.ts` `buildTelemetry()` and `telemetry:` attachment on monitor rows                                            | Invents telemetry fields from session/message state instead of projector-owned aggregate   | Monitor may expose projector-fed fields as a transport/view, not compute them                           |
| Snapshot refresh as live telemetry writer      | `packages/app/src/pages/session/use-status-monitor.ts` polling `session.top` and feeding hydration                                                   | Keeps `session.top` in steady-state authority loop                                         | Bootstrap/catch-up/reconnect/degraded transport only                                                    |
| `session.top` snapshot route as primary source | `packages/opencode/src/server/routes/session.ts` `GET /session/top` returning `SessionMonitor` telemetry-bearing rows                                | Encourages snapshot-first authority if consumed as canonical truth                         | Secondary transport backed by projector-owned state only                                                |
| Local monitor fallback construction            | `packages/app/src/context/sync.tsx` fallback `buildMonitorEntries({ raw: [], ... })` when telemetry sync has no server payload                       | Lets empty/local monitor state recreate telemetry truth                                    | Bootstrap placeholder only; must not commit canonical telemetry aggregates                              |

### Enforcement rule

- Reducer cutover is incomplete if any path above can still mutate canonical `session_telemetry` during steady-state.
- `session.top`/monitor/page hooks may remain only as bootstrap, reconnect, catch-up, buffer-miss, or degraded transports backed by projector-owned payloads.
- Any fallback that writes synthesized telemetry into canonical reducer state after cutover is a stop-gate failure.

## Builder Bias

- Prefer rewrite-to-target over preserve-current-shape.
- Do not preserve monitor/hydration/page-hook telemetry writers for convenience.
- Do not let companion UI work recreate authority via local projection.
- If a path cannot be proven secondary-only, treat it as conflicting authority.

## Ready-to-Start Checklist

- [ ] Current state is documented separately from target state
- [ ] Migration order is explicit
- [ ] Stop gates are explicit
- [ ] `session.top` demotion is explicit
- [ ] Reducer ownership is explicit
- [ ] Projector authority is explicit
- [ ] Minimum event matrix is explicit
- [x] Minimum projector aggregate matrix is explicit
- [x] Forbidden-writer list is explicit
- [ ] Product-purpose traceability for A111/A112 is explicit
- [x] Companion context-sidebar slice is colocated under this telemetry root
