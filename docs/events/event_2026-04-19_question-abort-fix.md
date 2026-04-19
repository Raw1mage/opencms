# Event — 2026-04-19 question-tool-abort-fix

Implementation log for [specs/question-tool-abort-fix/](../../specs/question-tool-abort-fix/).

## Context

User reported a reproducible failure mode on the webapp: after answering an `AskUserQuestion` dialog carefully, the UI shows a red "Tool execution aborted" banner and the AI re-asks the same question. Happened consecutively across several questions. Root cause triage in conversation pointed to three independent issues:

- (A) `Question.ask()` didn't listen to `AbortSignal`, so stream abort left pending questions orphaned
- (B) `QuestionDock` cached user input by `request.id`, which changes on AI re-ask
- (C) `prompt-runtime.cancel()` didn't carry a reason label, so logs can't tell which caller triggered the abort

Spec package created via `plan-builder` at `specs/question-tool-abort-fix/` (state=planned). Beta branch `beta/question-tool-abort-fix` created from `main@0e3730f8f`.

## Phase 1 — Server Foundation (Requirement A)

**Done**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7

**Key decisions**:
- DD-1 applied: `Question.ask` gained optional `abort?: AbortSignal`; reuse `RejectedError` for both manual reject and stream abort so processor's `instanceof RejectedError` path is untouched.
- Pre-aborted signal short-circuit publishes `question.rejected` but skips `question.asked` to avoid ghost dialog flash.
- `dispose()` closure attached per pending entry; called from `reply` / `reject` / abort handler to remove the abort listener deterministically.
- `RejectedError` gained optional `detail` constructor arg (e.g. `"aborted: rate-limit-fallback"`) for debugging; default message unchanged.

**Validation**:
- `bun test packages/opencode/src/question/index.test.ts` → 6/6 pass (703 ms, 18 expect calls)
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` → no new errors on `question/index.ts` or `tool/question.ts` (pre-existing errors elsewhere unrelated to this change)

**Drift**: none — `plan-sync.ts` reports clean.

**Remaining**: Phase 2 (cancel reason enum), Phase 3 (webapp cache key), Phase 4 (docs/SSOT), Phase 5 (E2E), Phase 6 (finalize).

## Phase 2 — Cancel Reason Telemetry (Requirement C)

**Done**: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6.1, 2.6.2, 2.6.4, 2.6.5, 2.6.8, 2.6.9, 2.6.10, 2.6.11, 2.7

**Cancelled (documented in tasks.md)**:
- 2.6.3 processor rate-limit rotation — uses `continue`, not cancel; no site. If the real trigger turns out to be here, amend with new `stream-error-restart` enum value.
- 2.6.6 monitor.ts — does not call cancel today.
- 2.6.7 ACP `session.abort` — goes through HTTP route, covered transitively by 2.6.1.

**Key decisions**:
- Enum `CancelReason` in [prompt-runtime.ts](../../packages/opencode/src/session/prompt-runtime.ts): `manual-stop | rate-limit-fallback | monitor-watchdog | instance-dispose | replace | session-switch | killswitch | parent-abort | unknown`. Added `parent-abort` beyond the spec's original 7-value list after surveying [tool/task.ts](../../packages/opencode/src/tool/task.ts) subagent cascade sites.
- `cancel(sessionID, reason)` required; `controller.abort(reason)` carries the enum value to the AbortSignal consumer (incl. `Question.ask` abort handler from Phase 1).
- `SessionPrompt.cancel` keeps stopReason = `"manual_interrupt"` for workflow gate compatibility; the `reason` is surfaced only via telemetry log, not workflow state.
- Caller stack-top captured via `new Error().stack` line 3 (`log.info("cancel", { sessionID, reason, caller })`).

**Validation**:
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` → no new errors on touched files
- `bun test src/question/ src/session/prompt-runtime.test.ts` → 7/7 pass
- `grep 'reason=' ~/.local/share/opencode/log/debug.log` pattern ready for next E2E

**Drift**: none — `plan-sync.ts` clean on Phase 2 files.

## Phase 3 — Webapp Content-hashed Cache (Requirement B)

**Done**: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8

**Key decisions**:
- DD-2 amended v1 → v2: FNV-1a sync replaces SHA-1 async. Reason: SolidJS `createStore(initial)` requires sync cache lookup; async SHA-1 would introduce a "typing-gets-overwritten" race worse than the original bug.
- `questionCacheKey` extracted into standalone [question-cache-key.ts](../../packages/app/src/components/question-cache-key.ts) for unit-testability.
- canonical JSON: recursive key-sort + `undefined` omission, so semantically-equal question arrays hash identically regardless of Bus payload key order.

**Validation**:
- `bun test src/components/question-cache-key.test.ts` → 13/13 pass (canonicalJson 4 + fnv1a32 3 + questionCacheKey 6 covering TV4/TV5/TV6 + option order + key-order insensitivity + flags)
- `bun run test` full app suite → 370/373 pass (3 pre-existing skips; no regression)

**Drift**: `plan-sync.ts` flagged Phase 1's `index.test.ts` file not explicitly listed in `design.md`'s Critical Files — minor, test files are implicit. No action needed.

**Remaining**: Phase 4 (architecture.md SSOT + event log update), Phase 5 (E2E validation on live webapp), Phase 6 (finalize: fetch-back, merge, state=verified, cleanup).

## References

- Spec: [specs/question-tool-abort-fix/spec.md](../../specs/question-tool-abort-fix/spec.md)
- Design: [specs/question-tool-abort-fix/design.md](../../specs/question-tool-abort-fix/design.md)
- Branch: `beta/question-tool-abort-fix` @ opencode-beta worktree
