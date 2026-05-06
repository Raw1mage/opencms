# Tasks

Execution checklist for codex-empty-turn-recovery. Phased per design.md DD-12 so each phase ships a coherent, testable slice. Per plan-builder §16.1, only the current phase's unchecked items should be materialized into TodoWrite at any time — not the whole file at once.

Numbering follows IDEF0 traceability (A1-A6 from idef0.json) where applicable; phase numbers are the rhythmic unit per §16.5.

## 1. Log infrastructure + binary empty detection (Phase 1, load-bearing per D-2)

This phase ships the empty-turn LOG mechanism and a skeleton classifier returning `unclassified` for every empty turn. Single ship target: production data starts flowing into `empty-turns.jsonl` so D-3 audit can begin. No real cause discrimination yet; no retry yet.

- [x] 1.1 Create [packages/opencode-codex-provider/src/empty-turn-log.ts](../../packages/opencode-codex-provider/src/empty-turn-log.ts) with `appendEmptyTurnLog(payload)` — opens append-only file handle to `<XDG_STATE_HOME>/opencode/codex/empty-turns.jsonl`, writes one JSON line per call; mkdirs the parent directory; idempotent on repeated calls
- [x] 1.2 Wire `appendEmptyTurnLog` to also publish on Bus channel `codex.emptyTurn` (non-load-bearing per DD-2); failure to publish is silent
- [x] 1.3 Add log-failure resilience: wrap file write + bus publish in try/catch; on failure emit single `console.error("[CODEX-EMPTY-TURN] log emission failed: <reason>")` breadcrumb; return successfully so caller never sees the failure
- [x] 1.4 Add `state.emittedTextDeltas: number` counter to SSE state in [packages/opencode-codex-provider/src/sse.ts](../../packages/opencode-codex-provider/src/sse.ts); increment on each `response.output_text.delta` event handled
- [x] 1.5 Add `state.terminalEventReceived: boolean` flag to WS state in [packages/opencode-codex-provider/src/transport-ws.ts](../../packages/opencode-codex-provider/src/transport-ws.ts); set true when one of `response.completed` / `response.incomplete` / `response.failed` / `error` is parsed
- [x] 1.6 Create [packages/opencode-codex-provider/src/empty-turn-classifier.ts](../../packages/opencode-codex-provider/src/empty-turn-classifier.ts) with `classifyEmptyTurn(snapshot)` — Phase 1 stub returns `{causeFamily: "unclassified", recoveryAction: "pass-through-to-runloop-nudge", suspectParams: []}` for every input
- [x] 1.7 Add monotonic `logSequence` counter in `empty-turn-log.ts` (process-scoped, starts at 0, increments per call); attach to every log entry and to classifier return value
- [x] 1.8 Hook classifier in `sse.ts` flush block: if `state.emittedTextDeltas === 0 && state.emittedToolCalls.size === 0`, call `classifyEmptyTurn(...)`, emit log, and use returned recovery to set finishReason (Phase 1: always `unknown` since stub returns `pass-through-to-runloop-nudge`); attach classification to `finish.providerMetadata.openai.emptyTurnClassification`
- [x] 1.9 Hook classifier in `transport-ws.ts` `ws.onclose` (replacing silent `endStream()` at line 422): if `state.status === "streaming"`, build wsState snapshot, call `classifyEmptyTurn(...)`, emit log, then `endStream()` with classification metadata threaded through to SSE flush via shared state; **first removal of the silent endStream pattern**
- [ ] 1.10 Unit test `empty-turn-log.test.ts`: log entry validates against `data-schema.json` JSON Schema; logSequence is monotonic across calls; failure to write to disk does not throw
- [ ] 1.11 Unit test `empty-turn-classifier.test.ts` (Phase 1 stub coverage): every input produces `unclassified` + `pass-through-to-runloop-nudge`; logSequence is attached
- [ ] 1.12 Integration test using `sse.test.ts` truncation case: stream ends with no text/tool deltas → empty turn detected → log entry emitted → finish part carries classification metadata
- [ ] 1.13 Smoke test (operator-driven): run live against codex backend for a short window; confirm `empty-turns.jsonl` accumulates entries; `tail -f` shows JSONL lines validating against schema

## 2. Cause-family discrimination (Phase 2)

Replace Phase 1 stub with real classifier predicates per design.md DD-9. No behavior change for terminal users (recovery still pass-through except for to-be-added retry in Phase 3); only log entries get richer cause attribution.

- [ ] 2.1 Implement `ws_truncation` predicate in classifier: matches when `wsFrameCount > 0 && !terminalEventReceived && wsCloseEvent === "onclose"` (selected from snapshot at WS-layer call site)
- [ ] 2.2 Implement `ws_no_frames` predicate: matches when `wsFrameCount === 0` (regardless of close vs error)
- [ ] 2.3 Implement `server_empty_output_with_reasoning` predicate: matches when `terminalEventType === "response.completed" && deltasObserved.text === 0 && (requestOptionsShape.hasReasoningEffort || requestOptionsShape.includeFields.includes("reasoning.encrypted_content"))`; populate `suspectParams` with the matched param names
- [ ] 2.4 Implement `server_incomplete` predicate: matches when `terminalEventType === "response.incomplete" && deltasObserved.text === 0`; capture `incomplete_details.reason` into `serverErrorMessage`
- [ ] 2.5 Implement `server_failed` predicate: matches when `terminalEventType === "response.failed" || terminalEventType === "error"`; capture verbatim message into `serverErrorMessage`
- [ ] 2.6 Add request-options-shape extraction at A1 boundary: in `provider.ts`, after `buildResponsesApiRequest`, derive sanitized `requestOptionsShape` (hash `prompt_cache_key`, byte-size `instructions`, count `input` items + tools); thread through to WS transport so classifier can read it
- [ ] 2.7 Update finish-reason mapping per DD-9 table: `unknown` for ws_*; `other` for server_empty_output_with_reasoning; `length` if max_output_tokens, else `other` for server_incomplete; `error` for server_failed
- [ ] 2.8 Add classifier predicate ordering test: scenarios from spec.md `Cause-family classification covers every empty turn` Requirement → expected `(causeFamily, recoveryAction, suspectParams)` tuples; one test per scenario
- [ ] 2.9 Add schema-drift unit test: assert `empty-turn-classifier.ts` `causeFamily` enum values exactly match the `enum` array in `data-schema.json` `causeFamily` property
- [ ] 2.10 Update integration test to assert per-cause classification (uses synthetic SSE streams from `sse.test.ts` patterns)

## 3. Retry implementation (Phase 3)

Add the `retry-once-then-soft-fail` recovery action implementation. Concentrated entirely in WS transport; no SSE-pipeline changes beyond receiving the second attempt's frames as if first.

- [ ] 3.1 Factor WS open + frame-loop in `transport-ws.ts` into a callable function (preserve existing behavior; just enable invocation more than once)
- [ ] 3.2 Add `state.retryCount: number` (starts at 0; max 1 per DD-7); add `state.previousLogSequence: number | null` to thread first-attempt log id into second attempt's classification call
- [ ] 3.3 Implement retry dispatcher: when classifier returns `recoveryAction === "retry-once-then-soft-fail" && state.retryCount === 0`, increment retryCount, reopen WS with same body, re-enter frame loop; cap firmly at 1 (no exponential, no second retry)
- [ ] 3.4 On second-attempt empty turn: classifier called with `retryAttempted: true`; recovery action becomes `pass-through-to-runloop-nudge` (the soft-fail half); log entry includes `retryAttempted: true, retryAlsoEmpty: true, previousLogSequence: <first-attempt-sequence>`
- [ ] 3.5 Add `synthesize-from-deltas` recovery action implementation (DD-8 dormant): assemble accumulated text-delta payloads into a single text part; emit text-start + single text-delta + text-end; current cause-family logic does NOT select this, but the action must be operational for future use
- [ ] 3.6 Update `providerMetadata.openai.emptyTurnClassification` shape per DD-11: include `retryAttempted`, `retryAlsoEmpty`, `logSequence`
- [ ] 3.7 Unit test `retry-then-soft-fail-end-to-end.test.ts`: simulate WS truncation → retry → second attempt also empty → verify exactly one retry + soft-fail finish + two log entries linked via `previousLogSequence`
- [ ] 3.8 Unit test `synthesize-from-deltas-dormant.test.ts`: directly invoke synthesize action with synthetic deltas; assert text-part assembly correctness; assert classifier never selects this action under any current cause-family scenario
- [ ] 3.9 Re-run smoke test from 1.13; confirm retry-pair entries appear in JSONL when ws_truncation fires; confirm pair links via `previousLogSequence`

## 4. Documentation + acceptance check (Phase 4)

- [ ] 4.1 Append paragraph to [specs/architecture.md](../architecture.md) describing empty-turn classifier path inside codex provider; reference spec slug + JSONL log location
- [ ] 4.2 Document JSONL log path in operator runbook (or wherever logrotate config lives) per DD-3; suggest weekly rotation + 90-day retention as starting point
- [ ] 4.3 Run all 7 spec.md Acceptance Checks A1-A7; record results in handoff.md validation evidence section
- [ ] 4.4 24-hour smoke test against real codex backend with classifier active across all 3 phases; collect log distribution; verify (a) zero hard-error exits, (b) all six cause-family values appear OR are documented as not-yet-observed, (c) no exception escaped SSE pipeline (per A6)
- [ ] 4.5 Capture log distribution snapshot in event log (`docs/events/event_<YYYYMMDD>_codex-empty-turn-distribution.md`); informs whether D-3 `extend` revision is needed for OpenHands B/C parameter omission
- [ ] 4.6 Promote spec to `verified` once 4.3 + 4.4 + 4.5 evidence captured

## Per-phase ship gates

- **Phase 1 ship gate**: 1.1-1.13 all checked, smoke test confirms JSONL accumulating, finish part carries classification metadata. Phase 1 is independently shippable; Phase 2/3 not required to ship Phase 1.
- **Phase 2 ship gate**: 2.1-2.10 checked, all six cause-family values producible via unit tests, schema-drift test passes
- **Phase 3 ship gate**: 3.1-3.9 checked, retry pair observable in production logs, second attempt soft-fails cleanly
- **Phase 4 ship gate**: 4.1-4.6 checked, spec promoted to `verified`
