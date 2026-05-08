# Tasks

Execution checklist for fix-empty-response-rca. Phased per design.md DD-4 so Phase 1 ships independently before Phase 2 touches compaction. Per plan-builder §16.1, only the current phase's unchecked items should be materialized into TodoWrite at any time — not the whole file at once.

Numbering follows IDEF0 traceability (A1-A7 from idef0.json) where applicable; phase numbers are the rhythmic unit per §16.5.

## 1. Throw-leak closure + rotation guard (Phase 1, DD-2 + DD-3 + DD-5)

This phase plugs the L2 root cause: WS-layer empty turns no longer throw exceptions that processor.ts misinterprets as temporary backend errors. Rotation rate from empty turns drops to zero. No compaction touching. Independent ship target.

- [x] 1.1 Add `wsErrorReason: string | null` field to `WsObservation` interface in [packages/opencode-codex-provider/src/transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts); default `null`; reset on retry attempt 2 alongside `wsObs.frameCount`
- [x] 1.2 Add `wsErrorReason: string | null` field to exported `TransportSnapshot` interface (DD-5); update `getSnapshot()` to include it in the explicit field list
- [x] 1.3 Replace `endWithError(new Error("WebSocket error"))` at `transport-ws.ts:472` (`ws.onerror` frameCount=0 path) with: set `wsObs.wsErrorReason = "WebSocket error"`; call `endStream()` instead
- [x] 1.4 Replace `endWithError(new Error("WS closed before response"))` at `transport-ws.ts:495` (`ws.onclose` frameCount=0 path) with: set `wsObs.wsErrorReason = "WS closed before response"`; call `endStream()` instead
- [x] 1.5 Replace `controller.error(new Error("Codex WS: first_frame_timeout"))` at `transport-ws.ts:289` (idle timer frameCount=0 path) with: set `wsObs.wsErrorReason = "first_frame_timeout"`; call `endStream()` (mid_stream_stall stays as `endStream()` already; only first_frame_timeout was throwing)
- [x] 1.6 Update `MapResponseStreamOptions.getTransportSnapshot` callback type in [packages/opencode-codex-provider/src/sse.ts](../../packages/opencode-codex-provider/src/sse.ts) to include `wsErrorReason: string | null`; thread it into `EmptyTurnSnapshot` construction in the flush block
- [x] 1.7 Update `EmptyTurnSnapshot` interface in [packages/opencode-codex-provider/src/empty-turn-classifier.ts](../../packages/opencode-codex-provider/src/empty-turn-classifier.ts) with `wsErrorReason: string | null`; thread it into `buildClassificationPayload()` so log payload carries it
- [x] 1.8 Update [packages/opencode-codex-provider/src/empty-turn-log.ts](../../packages/opencode-codex-provider/src/empty-turn-log.ts) data-schema field list reference; no code change required (additive field per data-schema.json)
- [x] 1.9 Add DD-3 guard at top of `isModelTemporaryError()` in [packages/opencode/src/session/processor.ts](../../packages/opencode/src/session/processor.ts) at lines 149-181: read `lastFinish?.providerMetadata?.openai?.emptyTurnClassification?.causeFamily` (opaque metadata access, no codex-provider type import per INV-16); return `false` when present
- [x] 1.10 Update caller at `processor.ts:1447` to pass the most recent assistant finish part's providerMetadata into `isModelTemporaryError()`; verify no signature breaks downstream
- [x] 1.11 Unit test in `packages/opencode-codex-provider/src/transport-ws.test.ts` (or a new file): simulate `ws.onerror` frame=0 → assert no exception escapes wsRequest; getSnapshot() returns `wsErrorReason: "WebSocket error"`
- [x] 1.12 Unit test in `packages/opencode-codex-provider/src/sse.test.ts`: extend the existing boundary regression block — verify wsErrorReason field round-trips into JSONL log entry (numeric `wsFrameCount: 0` + string `wsErrorReason: "..."` + `causeFamily: ws_no_frames`)
- [x] 1.13 Unit test for DD-3 guard: `processor.ts isModelTemporaryError` returns `false` when lastFinish carries `providerMetadata.openai.emptyTurnClassification.causeFamily`; returns existing pattern-match result when it does not. New test file `packages/opencode/test/session/processor-empty-turn-rotation-guard.test.ts`
- [x] 1.14 Smoke test (operator-driven, post-deploy): tail empty-turns.jsonl + count rotation events within 60s windows of empty-turn classifications. Pre-fix baseline: rotations occurred. Post-fix expectation: zero. Document via M9 query in observability.md

## 2. Compaction predictedCacheMiss derivation (Phase 2, DD-1)

This phase breaks the L1 cache equilibrium. Touches compaction-adjacent code; ship after Phase 1 is stable in production. cache-aware compaction trigger frequency is expected to drop; verify total context-window usage stays healthy (R1 mitigation).

- [ ] 2.1 Extract `derivePredictedCacheMiss(sessionExec, lastFinished)` helper in [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts); replace inline ternary at line 1884 with a call to the helper
- [ ] 2.2 Helper logic per design.md DD-1: `if (!continuationInvalidatedAt) return "unknown"; if (lastFinished?.tokens?.cache?.read > 0) return "hit"; return "miss"`
- [ ] 2.3 Add cache-equilibrium-detector in [packages/opencode/src/session/prompt.ts](../../packages/opencode/src/session/prompt.ts) (or sibling): track last N (default 3) cache.read values per session; emit `CacheEquilibriumDetectionEvent` per data-schema.json when N consecutive identical values observed
- [ ] 2.4 Wire cache-equilibrium-detector to write JSONL line at `<state>/codex/cache-equilibrium.jsonl` (mirror empty-turn-log.ts injection pattern: caller injects file path + bus publish function; no Global.Path import in detector)
- [ ] 2.5 Add operator runbook entry for the new JSONL channel in [docs/runbooks/codex-empty-turn-log-runbook.md](../../docs/runbooks/codex-empty-turn-log-runbook.md): file location, schema, M8 jq query
- [ ] 2.6 Unit test `packages/opencode/test/session/compaction-cache-equilibrium.test.ts`: feed synthetic sessionExec + lastFinished combinations, assert derivePredictedCacheMiss returns hit/miss/unknown per the rule table (also verify N-consecutive-identical detection threshold)
- [ ] 2.7 Regression test for cache-aware compaction: confirm Phase 2 does NOT prevent compaction from firing when context truly grows (R1 mitigation — gate at prompt.ts:474 `isCacheAware()` still works as backup)
- [ ] 2.8 Smoke test (operator-driven, post-deploy): replay ses_204499 pattern; cache_read should NOT lock at a constant value across ≥ 3 consecutive turns. Document via M8 query

## 3. Documentation + acceptance check (Phase 3)

- [ ] 3.1 Append paragraph to [specs/architecture.md](../architecture.md) Codex empty-turn classifier + forensic log section: extend with throw-leak closure (DD-2), rotation guard (DD-3), wsErrorReason field (DD-5), and compaction predictedCacheMiss derivation (DD-1). Cross-reference fix-empty-response-rca spec slug.
- [ ] 3.2 Update [docs/runbooks/codex-empty-turn-log-runbook.md](../../docs/runbooks/codex-empty-turn-log-runbook.md) operator queries with M8 (cache equilibrium), M9 (rotation suppression watchdog), M10 (wsErrorReason cluster). Add section on cache-equilibrium.jsonl operations.
- [ ] 3.3 Run all 6 spec.md Acceptance Checks A1-A6; record results in handoff.md validation evidence section
- [ ] 3.4 Live deploy + 24-hour soak: zero new account-rotation events caused by empty-turn errors (A2 + A5). Operator joins empty-turns JSONL with rotation logs over the soak window.
- [ ] 3.5 Capture distribution snapshot in event log (`docs/events/event_<YYYYMMDD>_fix-empty-response-rca-soak.md`): pre-fix vs post-fix rotation rate, pre-fix vs post-fix cache_read equilibrium count, wsErrorReason cluster.
- [ ] 3.6 Promote spec to `verified` once 3.3 + 3.4 + 3.5 evidence captured

## Per-phase ship gates

- **Phase 1 ship gate**: 1.1-1.13 all checked; unit tests pass; no exception escapes WS-layer empty-turn paths in any test scenario. Phase 1 is independently shippable; Phase 2/3 not required to ship Phase 1.
- **Phase 2 ship gate**: 2.1-2.7 checked; cache-equilibrium-detector emits as expected on the synthetic ses_204499 replay; cache-aware compaction still triggers when context legitimately grows.
- **Phase 3 ship gate**: 3.1-3.6 checked; spec promoted to `verified`.
