# 2026-05-08 — codex-update execution log

Spec: [specs/codex-update/](../../specs/codex-update/)
Branch: `beta/codex-update` (off `main` `eecb3d4b3`)
State track: `proposed → designed → planned → implementing` (Phase 1 done)

## Phase 1 — session_id / thread_id header split

**Done**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7

**Commit**: `7d05f1070` (`beta/codex-update`)

**Key decisions**:
- DD-1, DD-2 implemented as written. Default-equality (`threadId := sessionId` when omitted) keeps single-thread callers wire-compatible.
- DD-1 fallback chain extended one tail step beyond what spec.md literally said: `threadId ?? sessionId ?? conversationId(deprecated)`. Reason: the existing internal caller `transport-ws.ts:747` (and ultimately `provider.ts:206`) still references `WsTransportInput.conversationId`. Removing that surface mid-plan would ripple into provider.ts and beyond, which is out of scope; the deprecated tail of the chain absorbs it without contradicting INV-2 (threadId or sessionId always wins when set).
- Pre-existing gap discovered & fixed: the WS path's `buildHeaders` call (`transport-ws.ts:742`) was not passing `sessionId` at all, so the `session_id` header was previously never emitted on WS requests. Adding it satisfies TV-1 and INV-1; this is in scope.

**Validation**:
- `bun test packages/opencode-codex-provider/` → 113 pass / 0 fail (10 in `headers.test.ts`, includes 6 new cases: TV-1..TV-5 + back-compat)
- plan-sync: `clean` (history entry recorded)

**Drift**: none.

## Phase 2 — prompt_cache_key sources from threadId

**Done**: 2.1, 2.2, 2.3, 2.4, 2.5

**Commit**: `eed2453e5` (`beta/codex-update`)

**Key decisions**:
- DD-2 implemented as written. The composite cache key shape `codex-{accountId}-{threadId}` was preserved (was `codex-{accountId}-{sessionId}`); since `threadId` defaults to `sessionId` per DD-1, single-thread opencode callers see no behavioral change. Account-namespacing intentionally retained (separate from upstream's plain `thread_id` body field — opencode adds account scoping).
- New `x-opencode-thread-id` header recognized in doStream as the way callers can supply a distinct threadId. Default = sessionId (DD-1).

**Validation**:
- `bun test packages/opencode-codex-provider/` → 115 pass / 0 fail
- plan-sync: `clean`

**Drift**: none.

## Phase 3 — WS send-side idle watchdog

**Done**: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9

**Commit**: `2dbeebf52` (`beta/codex-update`)

**Key decisions**:
- WHATWG WebSocket has no callback completion, so the upstream Rust `tokio::time::timeout(idle_timeout, ws_stream.send(...))` was adapted by polling `ws.bufferedAmount` after the idle window. Helper extracted as `armSendStallWatchdog` (exported) for direct unit-testability.
- Fire gate: `bufferedAmount > 0 && frameCount === 0 && state.status === "streaming"`. If a frame arrived between arming and deadline, the receive-side timer owns the path → no fire.
- INV-4 satisfied: shared `WS_IDLE_TIMEOUT_MS` (protocol.ts:42) used for both directions; no new constant.

**Validation**: `bun test` → 119/0. plan-sync clean.
**Drift**: none.

## Phase 4 — Classifier coverage for ws_send_timeout

**Done**: 4.1, 4.2, 4.3, 4.4

**Commits**: `5bf9c2299` (Phase 4 tests) + `526ed9a1e` (Phase 5 tsc-fix follow-up)

**Key decisions**:
- No production-code change. The existing `wsFrameCount === 0` branch in `classifyEmptyTurn` already routes ALL receive-and-send failures (including the new `ws_send_timeout`) to `WS_NO_FRAMES` + `RETRY_ONCE_THEN_SOFT_FAIL`. INV-5 satisfied transparently.
- INV-13 (cause-family enum closure) preserved by routing the new sub-cause via the snapshot-level `wsErrorReason` field instead of expanding the enum. Forensic JSONL gets the discrimination; classifier outputs stay closed-set.

**Validation**: `bun test` → 121/0. plan-sync clean.
**Drift**: none.

## Phase 5 — Full provider validation

**Done**: 5.1, 5.2, 5.3

**Commits**: rolled into `526ed9a1e` (tsc fix) + this docs commit

**Key results**:
- `bun test packages/opencode-codex-provider/` → 121 pass / 0 fail (14 new cases across phases 1-4)
- `bunx tsc --noEmit -p packages/opencode-codex-provider/` → 50 errors, all pre-existing env-level (`bun:test`, `@types/node`); identical to `main` baseline. Zero regressions.
- plan-sync against entire codex-update spec: `clean`

**Drift**: none.

## Status: 4 product commits + 1 fix commit on `beta/codex-update`

```
526ed9a1e fix(codex-provider): codex-update Phase 5 — drop extra args in classifier test
5bf9c2299 test(codex-provider): codex-update Phase 4 — classifier coverage for ws_send_timeout
2dbeebf52 feat(codex-provider): codex-update Phase 3 — WS send-side idle watchdog
eed2453e5 feat(codex-provider): codex-update Phase 2 — prompt_cache_key sources from threadId
7d05f1070 feat(codex-provider): codex-update Phase 1 — session_id / thread_id header split
```

**Net change**: 6 source files + 4 test files modified; +295 / -19 lines (excluding spec).

## Phase 6 — Live smoke (DEFERRED)

User decision: defer to organic observation. The new log line `[CODEX-WS] WS send timeout …` is in place; the paired `session_id` / `thread_id` headers are emitted on every WS request. If anything looks wrong in production, revisit via `revise` mode.

## Phase 7 — Fetch-back

**Done**: 7.1, 7.2, 7.3

- Fetch-back: `git checkout -b test/codex-update main && git merge --no-ff beta/codex-update` (merge commit `458a16ec4`)
- Validation on `test/codex-update`: `bun test packages/opencode-codex-provider/` → 121 / 0
- Concurrency surprise: while validation was in progress, user landed 4 unrelated commits on `test/codex-update` (working-cache reasoning channel, UI collapsible reasoning, app file tree refresh, L5 diagram regen) plus 16 dirty WT files. Per user direction "我全都要留。分別提交，全部合併", the dirty WT was committed in 3 narrow commits (`385d34098` paralysis detector, `28f23fde9` SDK regen, `7405786a5` L5 regen) and the entire `test/codex-update` was merged into `main`.
- Finalize: `git merge --no-ff test/codex-update` into `main` at commit `9314982dc`. Bun test 121/0 post-merge.

## Phase 8 — Promote spec to living

**Done**: 8.1, 8.2

- `implementing → verified` (validation evidence attached)
- `verified → living` (codex-update is now current code state)
- Disposable branches deleted: `beta/codex-update`, `test/codex-update`
- Permanent beta worktree retained: `/home/pkcs12/projects/opencode-beta` (per memory `feedback_beta_workspace_persistent`)

## Final state

| | |
|---|---|
| spec state | `living` |
| main HEAD | `9314982dc Finalize: merge test/codex-update into main` |
| codex-update product commits | 5 (Phases 1–5) |
| user's parallel commits absorbed | 4 prior + 3 narrowly-committed by Claude on user's behalf |
| disposable branches | deleted |
| beta worktree | retained (off-branch, detached HEAD at `526ed9a1e`) |
| total tests | 121 pass / 0 fail |
