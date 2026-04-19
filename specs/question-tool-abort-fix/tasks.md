# Tasks — question-tool-abort-fix

## 1. Server Foundation — AbortSignal on Question.ask (Requirement A)

- [ ] 1.1 Extend `Question.ask` signature to accept optional `abort?: AbortSignal`
- [ ] 1.2 Store `dispose` handler on `pending[id]`; run on reply/reject/abort paths
- [ ] 1.3 Implement abort listener: delete pending + `Bus.publish(Event.Rejected)` + reject promise with `RejectedError`
- [ ] 1.4 Handle pre-aborted signal: short-circuit, no `question.asked` publish
- [ ] 1.5 Add `log.info("aborted", { id, reason })` reading `signal.reason`
- [ ] 1.6 Update `tool/question.ts` to pass `ctx.abort` into `Question.ask`
- [ ] 1.7 Unit tests: stream-abort, late-abort (reply wins), pre-aborted signal, double-trigger idempotency

## 2. Server Telemetry — Cancel Reason (Requirement C)

- [ ] 2.1 Define `CancelReason` union type in `prompt-runtime.ts` (or a dedicated `cancel-reason.ts`)
- [ ] 2.2 Change `prompt-runtime.cancel(sessionID)` → `cancel(sessionID, reason: CancelReason)` (required arg)
- [ ] 2.3 Pass reason into `controller.abort(reason)` in cancel / cleanupState / replace paths
- [ ] 2.4 Add caller-stack-top log: `log.info("cancel", { sessionID, reason, caller })` using `new Error().stack`
- [ ] 2.5 Update `SessionPrompt.cancel` wrapper to take + forward reason
- [ ] 2.6 Update all call sites:
  - [ ] 2.6.1 `server/routes/session.ts` `/session/:id/abort` → `"manual-stop"`
  - [ ] 2.6.2 `server/routes/session.ts` `/session/abort-all` → `"manual-stop"`
  - [ ] 2.6.3 `session/processor.ts` rate-limit fallback rotation abort → `"rate-limit-fallback"`
  - [ ] 2.6.4 `prompt-runtime.ts` `start({ replace: true })` internal abort → `"replace"`
  - [ ] 2.6.5 `prompt-runtime.ts` `cleanupState` per-session abort → `"instance-dispose"`
  - [ ] 2.6.6 Any session monitor / watchdog that aborts → `"monitor-watchdog"`
  - [ ] 2.6.7 ACP `session.abort` caller → `"session-switch"` or `"manual-stop"` based on trigger
- [ ] 2.7 TypeScript tsc pass: exhaustive reason argument enforcement

## 3. Webapp — Content-hashed QuestionDock Cache (Requirement B)

- [ ] 3.1 Add canonical JSON serializer (key-sorted recursive) helper
- [ ] 3.2 Add hash helper: SHA-1 via `crypto.subtle.digest` with FNV-1a fallback (non-secure context / SSR)
- [ ] 3.3 Change `cache: Map<string, CacheEntry>` key from `request.id` to `${sessionID}:${hex(hash(canonical(questions)))}`
- [ ] 3.4 Pre-compute `cacheKey` memo at component mount (async hash ok — seed after resolve)
- [ ] 3.5 `cache.get(cacheKey)` lookup in `createStore` init path
- [ ] 3.6 `cache.delete(cacheKey)` on replied=true path
- [ ] 3.7 `onCleanup` writes `cache.set(cacheKey, snapshot)` only when not replied
- [ ] 3.8 Unit test (or Playwright): same session + identical questions → restore; different session → no leak; different questions → miss

## 4. Docs & SSOT Sync

- [ ] 4.1 Append `## Question Tool Abort Lifecycle` section to `specs/architecture.md`
- [ ] 4.2 Write `docs/events/event_2026-04-19_question-abort-fix.md` recording: bug chain, fix map (A/B/C), DD-1..DD-5 references
- [ ] 4.3 Update `AGENTS.md` Enablement Registry? → NO (no new tool/capability exposed to LLM)
- [ ] 4.4 Run `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/question-tool-abort-fix/` and log clean result

## 5. E2E Validation

- [ ] 5.1 Happy path: ask → answer → reply flows end-to-end (no regression)
- [ ] 5.2 Bug reproduction path: trigger rate-limit fallback rotation while question pending; confirm dialog disappears at abort moment
- [ ] 5.3 AI re-ask path: after 5.2, confirm new dialog auto-fills previous draft
- [ ] 5.4 Manual Stop path: click Stop during pending question → confirm log shows `reason="manual-stop"` with caller stack
- [ ] 5.5 Confirm no duplicate `question.rejected` events on single abort
- [ ] 5.6 tsc + unit tests green

## 6. Finalize

- [ ] 6.1 Stage changes with explicit file list (no `git add -A`)
- [ ] 6.2 Commit with message referencing spec slug and DD decisions
- [ ] 6.3 Promote `implementing` → `verified` once tasks 1–5 checked + handoff.md validation evidence filled
- [ ] 6.4 Promote `verified` → `living` once merged to main
