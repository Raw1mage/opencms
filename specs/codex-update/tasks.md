# Tasks: codex-update

Canonical execution checklist. Each phase ends with a `plan-sync.ts` checkpoint and a phase-summary in the docs event log. Phases are sized so a single bun-test run validates each before moving on.

## 1. Header semantics — session_id / thread_id / x-client-request-id (A1)

- [x] 1.1 Extend `BuildHeadersOptions` in [headers.ts](packages/opencode-codex-provider/src/headers.ts) with `threadId?: string`; preserve all existing fields
- [x] 1.2 In `buildHeaders()`: emit `thread_id` header sourced from `options.threadId ?? options.sessionId` (only when at least one is present); keep `session_id` emission unchanged (INV-1)
- [x] 1.3 In `buildHeaders()`: switch `x-client-request-id` source — chain is `options.threadId ?? options.sessionId ?? options.conversationId`; `conversationId` deprecated in JSDoc but kept as tail-of-chain back-compat (caller in transport-ws.ts:747 still references the old field via WsTransportInput.conversationId; deprecation prevents silent breakage)
- [x] 1.4 Threaded the new `threadId?: string` through `WsTransportInput` and the buildHeaders call site at transport-ws.ts:742; also added `sessionId: input.sessionId` to that call (was missing — `session_id` header was previously not emitted on the WS path). `types.ts` left untouched: WindowState.conversationId is window-lineage (separate concept) and out of scope per design.md.
- [x] 1.5 Added 6 test cases to [headers.test.ts](packages/opencode-codex-provider/src/headers.test.ts) per TV-1..TV-5 plus a back-compat case for legacy `conversationId`
- [x] 1.6 `bun test packages/opencode-codex-provider/` → 113 pass, 0 fail
- [x] 1.7 plan-sync checkpoint + commit (this entry)

## 2. prompt_cache_key sourcing (A2)

- [x] 2.1 Derived threadId in doStream from `x-opencode-thread-id` header (defaulting to sessionId per DD-1); switched cacheKey composite source from `sessionId` to `threadId`. Composite shape `codex-{accountId}-{threadId}` preserved (single-thread callers see no behavioral change).
- [x] 2.2 Plumbed `threadId` through both `tryWsTransport` call sites (initial + retry) and the HTTP `buildHeaders` call site (line 364 area) in provider.ts. INV-3 preserved (custom `providerOptions.promptCacheKey` override path untouched).
- [x] 2.3 Added TV-6 / TV-7 unit cases to provider.test.ts (using `buildResponsesApiRequest` direct invocation, since doStream-level testing requires a live network mock — covered separately by live smoke in Phase 6).
- [x] 2.4 `bun test packages/opencode-codex-provider/` → 115 pass / 0 fail
- [x] 2.5 plan-sync after commit (this entry)

## 3. WS send-side idle timeout (A3)

- [x] 3.1 WHATWG WebSocket has no callback completion form for `send()`, so the upstream `tokio::time::timeout(idle_timeout, ws_stream.send(...))` pattern was adapted: a watchdog timer polls `ws.bufferedAmount` after the idle window. Extracted as `armSendStallWatchdog` (exported helper) for direct unit testability.
- [x] 3.2 At deadline, fires only when `bufferedAmount > 0 && frameCount === 0 && state.status === "streaming"`. Otherwise no-op (receive-side timer owns those paths).
- [x] 3.3 `wsObs.wsErrorReason = "ws_send_timeout"`, `state.status = "failed"`, `ws.close()`, `endStream()`. INV-4 satisfied: same `WS_IDLE_TIMEOUT_MS` constant used.
- [x] 3.4 Confirmed: `WS_IDLE_TIMEOUT_MS` (protocol.ts:42) shared with receive-side idle timer at line 350.
- [x] 3.5 `wsErrorReason` is `string | null` (line 202) — no new union literal needed; the new value rides on the existing string type. Documented in observability.md (already merged).
- [x] 3.6 Added 4 cases to transport-ws.test.ts: TV-8 (stalled), TV-9 (drain), watchdog-cancellable, predicate-gate (frame arrival aborts fire).
- [x] 3.7 Log line emitted: `[CODEX-WS] WS send timeout session=<id> thread=<prefix> err=ws_send_timeout bufferedAmount=<n>`.
- [x] 3.8 `bun test packages/opencode-codex-provider/` → 119 pass / 0 fail
- [x] 3.9 plan-sync after commit (this entry)

## 4. Empty-turn classifier transient extension (A4)

- [x] 4.1 No code change needed — the existing `wsFrameCount === 0` branch in classifyEmptyTurn already routes ALL send-and-receive failures (including the new `ws_send_timeout`) to `WS_NO_FRAMES` + `RETRY_ONCE_THEN_SOFT_FAIL`. `wsErrorReason` is preserved verbatim on the snapshot for forensic JSONL discrimination per the existing fix-empty-response-rca DD-5 design (INV-13 cause-family enum stays untouched). INV-5 satisfied transparently.
- [x] 4.2 Added 2 cases to empty-turn-classifier.test.ts: TV-10 (ws_send_timeout → ws_no_frames + retry) plus a payload-flow test confirming wsErrorReason survives `buildClassificationPayload`.
- [x] 4.3 `bun test packages/opencode-codex-provider/` → 121 pass / 0 fail
- [x] 4.4 plan-sync after commit (this entry)

## 5. Full provider package validation

- [x] 5.1 `bun test packages/opencode-codex-provider/` → 121 pass / 0 fail (Phase 1: 6 new + Phase 2: 2 new + Phase 3: 4 new + Phase 4: 2 new = 14 new test cases)
- [x] 5.2 `bunx tsc --noEmit -p packages/opencode-codex-provider/`: 50 errors, all pre-existing environment-level (missing `bun:test` types, `@types/node` not configured for this standalone tsconfig). Baseline unchanged from `main`. Zero regressions introduced.
- [x] 5.3 plan-sync after final closeout commit (this entry)

## 6. Live smoke validation

- [ ] 6.1 Stop main opencode if running; identify a free codex test account (per memory: do not use the main `~/.config/opencode/`; use OPENCODE_DATA_HOME-isolated dir)
- [ ] 6.2 Start opencode in beta-workflow's beta worktree, run a single codex turn
- [ ] 6.3 Inspect `[CODEX-WS] REQ` log lines: confirm both `session_id=...` AND `thread_id=...` fields appear with equal values (default-pairing)
- [ ] 6.4 Verify `[CODEX-WS] USAGE` cached_tokens behavior is unchanged or improved (no regression in cache hit ratio)
- [ ] 6.5 If a `[CODEX-WS] WS send timeout` log appears organically during smoke, capture and attach to handoff.md as evidence

## 7. Beta-workflow fetch-back

- [ ] 7.1 All commits land on a beta branch (`beta/codex-update` or similar) per beta-workflow §7
- [ ] 7.2 After phases 1–6 are green, fetch-back into `~/projects/opencode` test branch (`test/codex-update-…`) per beta-workflow §7.1
- [ ] 7.3 Open PR / merge sequence per beta-workflow §7.2

## 8. Promote to verified, then living

- [ ] 8.1 With all checkboxes above marked, run `plan-promote.ts specs/codex-update/ --to verified`
- [ ] 8.2 After fetch-back lands on `main`, run `plan-promote.ts specs/codex-update/ --to living`
