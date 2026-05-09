# M7 Validation Evidence — 2026-05-09

## Spec

`compaction/user-msg-replay-unification`. Implementation completed on `beta/user-msg-replay-unification` (worktree `~/projects/opencode-beta`). 6 milestone commits + 1 deep-integration commit (M7-pre-fetch-back evidence).

## Beta branch state (pre-fetch-back)

```
TBD-deep   test(session): M7 deep integration — defaultWriteAnchor → _replayHelper wiring (5 cases)
6552c3036  M6 — integration tests for replay wiring across observed conditions
715efb48f  M5 — register compaction.enable_user_msg_replay flag
0e0443842  M4 — thread observed through publish + fix recentEvents:"unknown"
41cbf955d  M3 — runtime Continue-injection gate replaces static INJECT_CONTINUE
697d8b043  M2 — wire user-msg-replay helpers across 4 compaction commit paths
04232d6bc  M1 — extract user-msg-replay helpers from inline 5/5 hotfix
```

## Automated test evidence

### Spec 1 dedicated tests

| File | Purpose | Result |
|------|---------|--------|
| `compaction-replay-helpers.test.ts` | Unit-level: snapshotUnansweredUserMessage + replayUnansweredUserMessage helper behavior | 23 / 23 pass |
| `compaction-replay-integration.test.ts` | M6 integration: SessionCompaction.run threads snapshot to WriteAnchorInput | 6 / 6 pass |
| `compaction-replay-deep.test.ts` | M7 deep integration: defaultWriteAnchor → \_replayHelper wiring (does NOT mock anchor writer; runs through compactWithSharedContext with mocked storage) | 5 / 5 pass |

Total Spec-1 dedicated test coverage: **34 cases, all passing.**

### Existing compaction-suite no-regression

```
$ bun test packages/opencode/src/session/compaction
75 pass / 0 fail / 249 expect() calls / 8 files
```

The 75 includes all my new tests + the existing 41 cases (`compaction.test.ts`, `compaction-run.test.ts`, `compaction.regression-2026-04-27.test.ts`, `compaction.phase-a-wiring.test.ts`).

### Pre-existing failures NOT introduced by Spec 1

Validated by `git stash` test (running same suite against `main` HEAD before applying my commits → identical 18 failures + 1 import error). Catalogued for transparency:

- `deriveObservedCondition` rebind 3 cases (DD-12 subagent / accountId differs / identity drift) — pre-existing logic bug in `deriveObservedCondition`, unrelated to replay.
- `ExecutionIdentity` `activeImageRefs` schema 4 cases (DD-20) — attachment-lifecycle spec, unrelated.
- `Session.getUsage` cache reuse + by-request 2 cases — billing telemetry, unrelated.
- `prepareCommandPrompt` subtask 1 case — command preparation, unrelated.
- `session execution identity` revision 1 case — identity tracking, unrelated.
- `compaction-run.test.ts` Phase 4 5 cases — **only fail in wider suite run, pass when scoped (70/70 vs 65/70)**. Mock-leakage between tests, pre-existing test brittleness.
- `session storage hardening` DR-5 1 case — storage forward-rollback, unrelated.
- `captureTurnSummaryOnExit not found` import error — broken import in another test file, unrelated.

### TypeScript

`bun run --cwd packages/opencode tsc --noEmit` is **clean**. M4 also fixed a pre-existing TS2339 at `compaction.ts:1402` (the missing `observed` field in `runLlmCompactionAgent` input shape).

## What was tested

### M7-1 ✅ — full compaction test suite

```
$ bun test packages/opencode/src/session/compaction
75 pass, 0 fail
```

### M7-2 ⚠️ — prompt tests

```
$ bun test packages/opencode/src/session/prompt
36 pass, 4 fail (all pre-existing per stash test) + 1 import error
```

The 4 fails are all `deriveObservedCondition` rebind tests, pre-existing on `main`. Confirmed by reverting working tree to `main` HEAD via `git stash` and re-running → identical failure set.

### M7-3 deferred → fetch-back

Manual reproduction of the 2026-05-09 rebind incident requires a live daemon serving the beta build. Per memory `feedback_restart_daemon_consent.md`, daemon restart needs explicit user consent. Deferred to the fetch-back validation step (per beta-workflow §7) where the test branch will be running and the user can drive a real session through it.

The deep integration tests (`compaction-replay-deep.test.ts` cases 1-3) cover the equivalent assertion at the unit level — they exercise the full `defaultWriteAnchor → _replayHelper` chain through SessionCompaction.run, with storage operations captured via mocks. The chain that was missing on `main` (the pre-fix silent-exit) is shown to invoke `_replayHelper` correctly under the same `observed` conditions that triggered the production incident.

### M7-4 deferred → fetch-back

`/compact` end-to-end flow. M3 logic is tested at the unit level via `shouldInjectContinue` paths in `compaction-replay-deep.test.ts`. Live UI verification deferred.

### M7-5 ✅ via deep tests

`compaction.user_msg_replay` telemetry surface verified at unit level — every helper branch (replayed / skipped:already-after-anchor / skipped:no-unanswered / skipped:flag-off / error) emits via `emitUserMsgReplayTelemetry` with full payload (sessionID, step, observed, originalUserID, newUserID?, anchorMessageID, hadEmptyAssistantChild, partCount, errorMessage?). Asserted in `compaction-replay-helpers.test.ts` cases 11-15.

### M7-6 ✅ via deep test

`compaction-replay-deep.test.ts` case 4 ("publishCompactedAndResetChain receives observed (DD-5 cosmetic side-fix)") asserts that after `SessionCompaction.run({ observed: "overflow" })`, `Session.appendRecentEvent` is called with `kind: "compaction"` AND `compaction.observed === "overflow"` AND **NOT** `"unknown"`.

## Summary

| Acceptance check | Status |
|------------------|--------|
| 1. All 4 call sites covered (helper invocation) | ✅ M6 + M7-deep verify all observed conditions thread snapshot |
| 2. 5/5 hotfix tests still pass | ✅ Inline replay block deleted; equivalent flow now via helper |
| 3. Idempotency | ✅ Unit test (compaction-replay-helpers.test.ts case "skipped:no-unanswered") |
| 4. Subagent compatibility | ✅ Unit test handles parentID-set sessions |
| 5. Telemetry fields complete | ✅ All branches verified |
| 6. recentEvents.observed never "unknown" from prod paths | ✅ M7-deep case 4 asserts |
| 7. Feature flag rollback | ✅ Unit + integration tests cover flag-off path |
| 8. No regression in `loop:no_user_after_compaction` callsite | ✅ Diagnostic log line preserved; replay path makes it unreachable when snapshot exists |

**Gate decision**: Spec 1 implementation is **automated-test-complete**. Live-daemon validation (M7-3 / M7-4) is deferred to the fetch-back step. Ready for fetch-back authorization.
