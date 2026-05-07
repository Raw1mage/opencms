# Tasks: codex-update

Canonical execution checklist. Each phase ends with a `plan-sync.ts` checkpoint and a phase-summary in the docs event log. Phases are sized so a single bun-test run validates each before moving on.

## 1. Header semantics — session_id / thread_id / x-client-request-id (A1)

- [ ] 1.1 Extend `BuildHeadersOptions` in [headers.ts](packages/opencode-codex-provider/src/headers.ts) with `threadId?: string`; preserve all existing fields
- [ ] 1.2 In `buildHeaders()`: emit `thread_id` header sourced from `options.threadId ?? options.sessionId` (only when at least one is present); keep `session_id` emission unchanged (INV-1)
- [ ] 1.3 In `buildHeaders()`: switch `x-client-request-id` source from `options.conversationId` to `options.threadId ?? options.sessionId` (INV-2). Remove the `conversationId` parameter from `BuildHeadersOptions` since it has no remaining consumers — verify with grep first; if any caller still passes it, deprecate inline rather than remove.
- [ ] 1.4 Add `threadId?: string` to the relevant request-input shape in [types.ts](packages/opencode-codex-provider/src/types.ts) (find via grep where buildHeaders callers live; minimal additive change)
- [ ] 1.5 Add 5 test cases to [headers.test.ts](packages/opencode-codex-provider/src/headers.test.ts) per TV-1, TV-2, TV-3, TV-4, TV-5 (test-vectors.json)
- [ ] 1.6 Run `bun test packages/opencode-codex-provider/src/headers.test.ts` — must be green
- [ ] 1.7 Run `bun run /home/pkcs12/.claude/skills/plan-builder/scripts/plan-sync.ts specs/codex-update/`; record result

## 2. prompt_cache_key sourcing (A2)

- [ ] 2.1 Locate the `cacheKey` derivation site in [provider.ts:157-158](packages/opencode-codex-provider/src/provider.ts#L157-L158) and switch source from `sessionId` to `threadId ?? sessionId`
- [ ] 2.2 Plumb `threadId` from provider input through to the body builder; preserve the existing `providerOptions.promptCacheKey` override path (INV-3)
- [ ] 2.3 Update or replace existing prompt_cache_key tests in [provider.test.ts](packages/opencode-codex-provider/src/provider.test.ts) to cover TV-6 and TV-7
- [ ] 2.4 Run `bun test packages/opencode-codex-provider/src/provider.test.ts` — must be green
- [ ] 2.5 Run plan-sync; record result

## 3. WS send-side idle timeout (A3)

- [ ] 3.1 In [transport-ws.ts:571](packages/opencode-codex-provider/src/transport-ws.ts#L571), wrap `ws.send(...)` so it returns a Promise that settles via the `(err) => …` callback form of `ws.send`
- [ ] 3.2 Race that promise against a `setTimeout(WS_IDLE_TIMEOUT_MS)` that rejects with reason `"ws_send_timeout"`
- [ ] 3.3 On timeout: set `wsObs.wsErrorReason = "ws_send_timeout"`, close the ws, call `endStream()` (INV-4)
- [ ] 3.4 Confirm `WS_IDLE_TIMEOUT_MS` is the same constant used by the receive-side idle timer (no new constant)
- [ ] 3.5 Add the new value to the union type for `wsErrorReason` (Δ6 in data-schema.json)
- [ ] 3.6 Add 2 test cases to [transport-ws.test.ts](packages/opencode-codex-provider/src/transport-ws.test.ts) per TV-8 (stalled callback) and TV-9 (normal callback). Use a low override of `WS_IDLE_TIMEOUT_MS` (~100ms) for the stall case to keep test fast.
- [ ] 3.7 Add `[CODEX-WS] WS send timeout session=<id> thread=<id> err=ws_send_timeout` log line per observability.md
- [ ] 3.8 Run `bun test packages/opencode-codex-provider/src/transport-ws.test.ts` — must be green
- [ ] 3.9 Run plan-sync; record result

## 4. Empty-turn classifier transient extension (A4)

- [ ] 4.1 In [empty-turn-classifier.ts](packages/opencode-codex-provider/src/empty-turn-classifier.ts), add `ws_send_timeout` to the same handling branch as `first_frame_timeout` (transient, retry recovery)
- [ ] 4.2 Add 1 test case to [empty-turn-classifier.test.ts](packages/opencode-codex-provider/src/empty-turn-classifier.test.ts) per TV-10
- [ ] 4.3 Run `bun test packages/opencode-codex-provider/src/empty-turn-classifier.test.ts` — must be green
- [ ] 4.4 Run plan-sync; record result

## 5. Full provider package validation

- [ ] 5.1 Run full provider test suite: `bun test packages/opencode-codex-provider/` — every test green
- [ ] 5.2 Run repo type check via the provider package's local tsc invocation if applicable
- [ ] 5.3 Run plan-sync against the entire spec; expected `clean` (no drift)

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
