# Tasks

Phased execution checklist. Each phase is a coherent slice that can be implemented, tested, and committed independently. Within a phase, items are listed in dependency-ready order. `tasks.md` is the canonical task source for `beta-workflow` and TodoWrite materialization.

## 1. Foundation — extract LegacyStore as a verbatim module

- [ ] 1.1 Create `packages/opencode/src/session/storage/` directory; add `index.ts` exporting a placeholder `SessionStorage` namespace
- [ ] 1.2 Move existing per-message / per-part filesystem logic from `message-v2.ts` (`stream`, `parts`, `get`) and `Session` (`updateMessage`, `updatePart`) into `storage/legacy.ts` as `LegacyStore`; preserve exact behavior; keep callers on the original API names via thin re-export
- [ ] 1.3 Add `legacy.test.ts` covering current behavior on a synthetic session fixture: list, read, update, append part, delete; tests must pass against pre-extraction baseline
- [ ] 1.4 Wire `Storage.list/read/write` for `["message", sid]` and `["part", mid]` paths through `LegacyStore` so the rest of the codebase is unchanged

## 2. SQLite store v1 — schema, pool, integrity, migration runner

- [ ] 2.1 Add `storage/migrations/v1.ts` containing the DDL + indexes from `data-schema.json`; export `applyV1(db)` and `rollbackV1(db)` (rollback is a no-op for the initial schema but the unit-test pair contract starts here)
- [ ] 2.2 Add `storage/pool.ts` (`ConnectionPool`): bounded LRU keyed by sessionID, `acquire(sessionID, mode: "rw" | "ro")`, `release()`, idle close after `CONNECTION_IDLE_MS` (default 60s), pool cap 32
- [ ] 2.3 Add `storage/integrity.ts` (`IntegrityChecker`): runs `PRAGMA integrity_check`, caches per-connection result, publishes `session.storage.corrupted` Bus event on failure (event payload defined in `observability.md`)
- [ ] 2.4 Add `storage/migration-runner.ts` (`MigrationRunner`): reads `meta.schema_version`, dispatches to `migrations/vN.ts`, wraps in transaction, ROLLBACK on error, publishes `session.storage.migration_failed` event
- [ ] 2.5 Add `storage/sqlite.ts` (`SqliteStore`) implementing the LegacyStore interface contract: `list(sessionID)`, `get(sessionID, messageID)`, `parts(messageID)`, `upsertMessage(...)`, `upsertPart(...)`, `deleteSession(sessionID)`; opens via Pool, runs IntegrityChecker on first acquire, runs MigrationRunner if schema_version mismatches
- [ ] 2.6 Apply pragmas (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`) on every connection open
- [ ] 2.7 Implement message info ↔ row encode/decode: promote `tokens.total` etc. to columns (DD-6); fall through `info_extra_json` for fields without a column
- [ ] 2.8 Implement part payload ↔ row encode/decode: full part body to `payload_json`; preserve part `id` and message `sequence`
- [ ] 2.9 Add `sqlite.test.ts` covering CRUD round-trips, schema_version handshake, integrity_check pass/fail, transaction atomicity (per-message commit), pool warm/cold acquire

## 3. Router — dual-track dispatcher

- [ ] 3.1 Add `storage/router.ts` (`Router`) exporting the same surface as LegacyStore + SqliteStore; per-call format detection: `<sid>.db` exists → SqliteStore, else `<sid>/messages/` exists → LegacyStore, else create new SqliteStore
- [ ] 3.2 Implement debris-resolution rule from spec.md § "Both formats present (post-crash debris)": if both `<sid>.db` AND `<sid>/messages/` exist AND `<sid>.db.tmp` does NOT exist → SqliteStore wins, schedule `<sid>/` for deletion at next idle
- [ ] 3.3 Enforce DD-13 no-silent-fallback: any error from SqliteStore propagates; never re-attempt via LegacyStore
- [ ] 3.4 Add `router.test.ts` covering format detection matrix (only-legacy / only-sqlite / both / neither / tmp-present), debris resolution, no-silent-fallback enforcement
- [ ] 3.5 Update `Session.messages`, `Session.updateMessage`, `Session.updatePart`, `MessageV2.stream`, `MessageV2.parts`, `MessageV2.get`, `MessageV2.filterCompacted` to call Router (signature unchanged; DD-9)
- [ ] 3.6 Make `MessageV2.filterCompacted` consume `tokens_total` directly from row data when available (DD-6); fall back to existing logic only for legacy-format sessions

## 4. Hot path swap — new sessions use SqliteStore

- [ ] 4.1 Default `Session.create` to allocate `<sid>.db` (not `<sid>/messages/`) for new sessions
- [ ] 4.2 Adjust session lifecycle hooks (`Session.delete`, recycle-bin, export, stats) to recognize `.db` files alongside the legacy directory pattern
- [ ] 4.3 Adjust `script/sync-config-back.sh` and any backup-side glob patterns to include `*.db` files
- [ ] 4.4 Run end-to-end smoke test: create new session, send 5 messages, kill daemon, restart, verify all messages survive and finish-step transitions are intact
- [ ] 4.5 Benchmark per-round runloop wall time on a synthetic 2000-message session: SQLite path vs LegacyStore path; record numbers in handoff.md validation evidence

## 5. Dreaming mode — idle-time legacy migration

- [ ] 5.1 Add `storage/dreaming.ts` (`DreamingWorker`): periodic timer (default 5000ms tick), idle detector (no message-write in `IDLE_THRESHOLD_MS`), legacy-session inventory scanner
- [ ] 5.2 Implement three-stage atomic migration: read legacy → write `<sid>.db.tmp` → integrity_check + row count assertion → POSIX `rename` → delete legacy directory; one session per tick (DD-8)
- [ ] 5.3 Implement DR-4 startup cleanup: on daemon boot, scan for orphaned `<sid>.db.tmp` files; delete them; ensure their parent legacy `<sid>/` is intact
- [ ] 5.4 Publish `session.storage.migrated` Bus event on success; `session.storage.migration_failed` on failure (with stage marker)
- [ ] 5.5 Make `IDLE_THRESHOLD_MS` and `CONNECTION_IDLE_MS` tunable via `/etc/opencode/tweaks.cfg` (per existing memory rule on tunable thresholds)
- [ ] 5.6 Add `dreaming.test.ts` covering: happy path migration, simulated crash before rename (legacy preserved), simulated crash after rename before legacy delete (router debris path engages), row count mismatch (tmp deleted), integrity_check fail (tmp deleted)
- [ ] 5.7 Verify that user opening a legacy session before dreaming reaches it does NOT trigger immediate migration (router serves via LegacyStore; no preempt)

## 6. Debug CLI — opencode session-inspect

- [ ] 6.1 Add `cli/cmd/session-inspect.ts` with subcommands `list <sid>`, `show <sid> <mid>`, `check <sid>`
- [ ] 6.2 `list`: tabular stdout of message id, role, time_created, finish, tokens_total
- [ ] 6.3 `show`: JSON dump of one message info + all its parts ordered by sequence
- [ ] 6.4 `check`: run IntegrityChecker; print verdict; exit code 0 if ok else 1
- [ ] 6.5 Wire CLI through Router so it works on both SQLite and legacy sessions
- [ ] 6.6 Document subcommands in `--help`; add `session-inspect.test.ts` for output shape stability

## 7. Observability — events, metrics, logs

- [ ] 7.1 Define Bus event payloads in `observability.md`: `session.storage.corrupted`, `session.storage.migrated`, `session.storage.migration_failed`, `session.storage.migration_started`, `session.storage.legacy_debris_resolved`
- [ ] 7.2 Add metrics: `session_open_ms` (histogram), `migrate_duration_ms` (histogram, tagged stage), `integrity_check_ms` (histogram), `connection_pool_size` (gauge), `legacy_sessions_pending_count` (gauge)
- [ ] 7.3 Add structured logs at INFO for migration lifecycle and ERROR for failure paths; ensure `sessionID` + `stage` are always present
- [ ] 7.4 Surface `session.storage.corrupted` to admin panel (toaster + persistent banner); user can click to open `session-inspect check` output

## 8. Hardening — fault injection + perf

- [ ] 8.1 Fault injection test: simulate SIGKILL during message commit; verify next start opens cleanly with at most the in-flight message lost (DR-1)
- [ ] 8.2 Fault injection test: simulate power loss via abrupt process exit + remount fixture; verify integrity_check passes on next open (DR-2)
- [ ] 8.3 Fault injection test: corrupt a `<sid>.db` byte; verify next open hits IntegrityChecker → Bus event → refuse load (DR-3); session-inspect check reproduces same verdict
- [ ] 8.4 Fault injection test: kill daemon at each migration stage; verify recovery per DR-4 startup cleanup; legacy intact at every interruption point
- [ ] 8.5 Schema migration test: ship a synthetic v2 migration that adds a column; verify v1 → v2 forward + rollback unit-test pair (DR-5 / R-5)
- [ ] 8.6 rsync race test: take rsync snapshot of running session, verify integrity_check on the snapshot — expect either ok or known-flagged inconsistency (R-1 documentation)
- [ ] 8.7 Performance benchmark: 2253-message reference session; per-round runloop wall time must drop ≥ 70% vs LegacyStore baseline (acceptance check from spec.md)

## 9. Cleanup gates — eventual legacy retirement

- [ ] 9.1 Add `legacy_sessions_pending_count` metric to Grafana / admin panel; document the "0 = ready to retire LegacyStore" milestone
- [ ] 9.2 Add admin command `opencode storage migrate-now <sid>` for users who want to force-migrate without waiting for idle sweep (R-6 mitigation)
- [ ] 9.3 After the user's installation reports `legacy_sessions_pending_count == 0` for ≥ 7 days, schedule a follow-up amend to delete LegacyStore + Router's legacy branch (separate spec lifecycle iteration; tracked via `/schedule`)
