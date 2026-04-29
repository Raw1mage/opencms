# Phase 3 — session-storage-db (Router dual-track dispatcher)

**Date**: 2026-04-29
**Spec**: `/specs/session-storage-db/`
**State**: implementing (phase 3 closed)
**Branch**: `beta/session-storage-db` (beta worktree)

## Done

- **3.1** `storage/router.ts` — `Router` implements `SessionStorage.Backend`. Per-call `detectFormat(sessionID)` reads the live filesystem state (no caching) and picks `SqliteStore` or `LegacyStore`. Five outcomes: only-`.db` → sqlite; only-legacy-dir → legacy; neither (fresh session) → sqlite; both-without-tmp → sqlite + debris flag; both-with-tmp → legacy (DR-4 mid-migration).

- **3.2** Debris queue: when format detection sees both formats present without a migration tmp (post-rename, pre-legacy-delete state from sequence.json P4), Router queues the legacy directory for deletion via `noteLegacyDebris(sessionID)`. Cleanup happens out-of-band via `drainLegacyDebris()` which dreaming-mode worker (task 5.x) calls on each idle tick. Synchronous cleanup is **not** done inside read/write hot path. `drainLegacyDebris` re-validates state before deleting (defensive; a session that flipped back during the wait window is silently dropped from the queue).

- **3.3** DD-13 no-silent-fallback: Router only chooses *which* backend serves a call. Any error from the chosen backend propagates. Tests assert this with a corrupted `.db` — Router still dispatches to SqliteStore (because the file exists), the integrity_check throw bubbles up, and the pool stays empty (no leaked entry, courtesy of Phase 2's onColdOpen try/catch).

- **3.4** `router.test.ts` — 13 tests, all green. Covers the five-row format detection matrix, dispatch correctness for both backends, debris queue scheduling + drain, drain idempotency when state flipped between schedule and drain, and the explicit `parts(messageID)` no-sessionID fall-through behavior.

- **3.5** Wired the public surface (`MessageV2.stream` / `MessageV2.parts` / `MessageV2.get` / `MessageV2.updateMessage` / `MessageV2.updatePart`, `Session.deleteSession` cleanup loops in `session/index.ts`) through `StorageRouter` instead of direct `LegacyStore` calls. Dropped the now-unused `LegacyStore` import from `message-v2.ts`. `session/index.ts` keeps `readMessageInfo` / `removeMessageInfo` / `removePartFile` helpers (still used by debounce flush + delete code paths that key on the on-disk filesystem path; those will get their own dispatch wiring in Phase 5 alongside Dreaming-mode storage-state changes).

- **3.6** `MessageV2.filterCompacted` token-budget guard rewritten: assistant messages contribute their stored `tokens.total` (or computed fallback from `input + output + cache.{read,write}`); user messages estimate from text-part lengths. Eliminates the multi-MB-per-round `JSON.stringify(msg)` that previously dominated the hot path on long sessions (INV-5 / DD-6).

## Key Decisions (no new DDs)

- **`StorageRouter` import as alias** — imported as `Router as StorageRouter` to disambiguate from the unrelated `Router` symbol that other parts of the codebase use (HTTP routing). The runtime symbol stays `Router` exported from `storage/router.ts`.

- **Drain timing**: Router schedules debris but does NOT delete inside the read/write call. Decoupling cleanup from hot path means a buggy delete can never break a successful read; worst case it leaves debris in place a little longer (next dreaming tick gets another shot).

## Validation

- `bun test packages/opencode/src/session/storage/`: **38 pass / 0 fail / 74 expects** (12 legacy + 13 sqlite + 13 router).
- `bunx tsc --noEmit`: clean for the storage modules + `message-v2.ts` (pre-existing unrelated errors in `tui/routes/session/index.tsx` and `message-v2.ts:920-926` are untouched).

## Drift

`plan-sync` not invoked yet; expected to flag the same 7 unrelated files from Phase 1's drift report. None caused by Phase 3.

## Remaining

- **Phase 4** — Hot path swap: new sessions default to SQLite. **GATE**: smoke test + benchmark.
- **Phase 5** — Dreaming mode worker (idle sweep + DR-4 startup cleanup).
- **Phase 6** — Debug CLI (`opencode session-inspect`).
- **Phase 7** — Observability wiring.
- **Phase 8** — Hardening: fault injection + perf benchmark on 2253-message session. **GATE** before destructive tests.
- **Phase 9** — Cleanup gates.

Phase 4 enters the GATE territory described in `handoff.md § Stop Gates In Force`. The first time `Session.create` allocates a `<sid>.db` for a new session in production, that **should** be safe per design (fresh DB = empty file under tmp-isolated test env), but the smoke test (4.4) needs to pass cleanly before we let it serve real traffic. Daemon rebuild + restart is part of 4.4's protocol.

Next phase rolls over immediately per autorun mode.
