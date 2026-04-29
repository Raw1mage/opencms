# Phase 2 — session-storage-db (SQLite store v1: primitives + Backend)

**Date**: 2026-04-29
**Spec**: `/specs/session-storage-db/`
**State**: implementing (phase 2 closed)
**Branch**: `beta/session-storage-db` (beta worktree)
**Commits**: `29c010d5d` (2.1-2.4 primitives) + `aba0a8a0c` (2.5-2.9 Backend + tests)

## Done

- **2.1** `storage/migrations/v1.ts` — initial schema mirroring `data-schema.json` verbatim. `messages` / `parts` / `meta` tables with the indexes documented in the spec. `applyV1` + `rollbackV1` forward+rollback pair so the unit-test contract for DR-5 starts at v1 (rollback is a no-op for the initial schema, but the ceremony pair is in place).

- **2.2** `storage/pool.ts` — `ConnectionPool`: bounded LRU keyed by sessionID. `acquire(sessionID, mode)` opens a writer handle (or fresh read-only handle for `mode: "ro"`), runs the `onColdOpen` hook on first acquire, then caches. Idle close after `CONNECTION_IDLE_MS` (default 60s). Cap 32 (DD-10). LRU eviction enforced. Sweep timer is `unref`-ed so it never keeps the daemon alive on its own.

- **2.3** `storage/integrity.ts` — `runIntegrityCheck` runs `PRAGMA integrity_check` exactly once per `(connection lifetime, sessionID)` and caches the verdict (INV-3). On non-`ok` verdict: publishes `session.storage.corrupted` Bus event and throws `StorageCorruptionError`. DD-13 — never silently fall back to legacy on corruption. `runIntegrityCheckUncached` is the explicit-recheck escape for `session-inspect check`.

- **2.4** `storage/migration-runner.ts` — `ensureSchema(db, sessionID, dbPath)`: reads `PRAGMA user_version`, walks `MIGRATIONS` table forward step by step, wraps each step in a transaction. Failure → `ROLLBACK`, publish `session.storage.migration_failed` Bus event, throw `SchemaMigrationFailedError`. Refuses to load DBs with `user_version > target` (`SchemaVersionTooNewError`). INV-8 monotonic forward-only — `rollbackTo` exists for unit tests only.

- **2.5** `storage/sqlite.ts` — `SqliteStore` implementing `SessionStorage.Backend`. `acquireRW` threads through `ConnectionPool` with `onColdOpen` running `ensureSchema` then `runIntegrityCheck`. `parts(messageID, sessionID?)` requires sessionID and throws when absent (Backend signature widened, LegacyStore ignores the new arg). `upsertPart` reuses the original `sequence` on REPLACE so streaming-delta replays don't reorder. Encode/decode is lossless via promoted columns + `info_extra_json` / `payload_json`.

- **2.6** Pragmas (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`) applied on every connection open in `pool.ts`.

- **2.7** Message info ↔ row encode: promoted columns (`tokens_*`, `finish`, `mode`, `cost`, `summary`, `error_json`, `model_id`/`provider_id`/`account_id`) mirror `data-schema.json`. Residue (role-specific fields like `path`, `system`, `tools`, `format`, `variant`, `summary` body, `pendingSubagentNotices`, …) round-trips via `info_extra_json`. `tokens_total` derived if not provided.

- **2.8** Part payload ↔ row encode: full `MessageV2.Part` body to `payload_json`. `sequence` assigned at insert as `MAX(sequence)+1` per message; preserved across REPLACE upserts. `id`, `message_id`, `type` extracted as columns.

- **2.9** `storage/sqlite.test.ts` — 13 tests, all green. Covers CRUD round-trip, streaming-delta replay, cross-session isolation, `parts(no-sessionID)` throw path, schema bootstrap, `integrity_check` ok, `ensureSchema` idempotency, DR-3 corruption rejection (with pool-leak verification — adding the `try/catch` in `pool.ts` around `onColdOpen` was necessary to make this test pass), INV-6 transaction rollback, `deleteSession` semantics.

## Key Decisions (no new DDs added)

No changes to design.md. One implementation refinement worth noting:

- **Backend.parts signature widened** to `parts(messageID, sessionID?)`. SqliteStore requires sessionID; LegacyStore ignores it. Router (task 3.1) will always thread sessionID. The widened signature is back-compat for LegacyStore callers and surfaces an explicit error path for SqliteStore-only paths that forget to thread it.

- **Pool onColdOpen failure path**: added try/catch around `onColdOpen` in `pool.ts` so a thrown integrity / migration error closes the leaked Database handle and does NOT insert a pool entry. Verified by `DR-3` test in `sqlite.test.ts` (`ConnectionPool.stats().size === 0` after corruption rejection).

## Validation

- `bunx tsc --noEmit` on `packages/opencode/`: clean for storage modules. Pre-existing unrelated errors elsewhere in the beta branch are untouched.
- `bun test packages/opencode/src/session/storage/`: **25 pass / 0 fail / 50 expects** (12 from `legacy.test.ts` + 13 from `sqlite.test.ts`).
- All tests run under `NODE_ENV=test` which pins XDG to a per-pid tmpdir per `Global.ts` — so writes never touch real `~/.local/share/opencode/` (per Beta XDG Isolation memory).

## Drift

`plan-sync.ts` not run in this batch; doing so on a fresh acquire of the spec right now would still flag the same 7 unrelated files as in Phase 1's drift report. None caused by Phase 2; documented and dismissed.

## Remaining

- **Phase 3** — Router dual-track dispatcher (3.1-3.6)
- **Phase 4** — Hot path swap: new sessions default to SQLite (gate)
- **Phase 5** — Dreaming mode worker
- **Phase 6** — Debug CLI (`opencode session-inspect`)
- **Phase 7** — Observability wiring
- **Phase 8** — Hardening (fault injection + perf, gate)
- **Phase 9** — Cleanup gates / legacy retirement plan

Next phase rolls over immediately per autorun mode.
