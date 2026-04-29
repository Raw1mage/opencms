# Invariants: session-storage-db

Cross-cut guarantees that hold across all lifecycle states (legacy, migrating, sqlite, corrupted, crashed). Each invariant has an enforcement point in code; violations are bugs, not degraded modes.

## INV-1: A session has at most one source of truth at any moment
- **Statement**: For any sessionID, exactly one of `<sid>/messages/` or `<sid>.db` is the authoritative store at any moment.
- **Edge cases**:
  - During DreamingWorker stages 1-3, both exist but `<sid>.db.tmp` (not `<sid>.db`) holds the in-progress copy → legacy is still authoritative
  - Between DreamingWorker stage 4a (rename) and 4b (legacy delete), both `<sid>.db` and `<sid>/messages/` exist → SQLite wins per Router debris rule (TV-8)
  - Crash between stages 1-3 → tmp is orphaned, legacy still authoritative (DR-4 startup cleanup deletes tmp)
- **Enforced at**: `Router.detectFormat()` (deterministic dispatch); `DreamingWorker.cleanupOrphanTmp()` (startup); never silently merges or chooses both

## INV-2: Tool-call format and conversation fidelity are unchanged by storage migration
- **Statement**: The migration `<sid>/messages/` → `<sid>.db` is byte-equivalent for every message info field and every part payload (modulo JSON whitespace).
- **Why**: Mid-conversation migration must not break in-flight tool calls or alter LLM context replay
- **Enforced at**: DreamingWorker stage 3 verifies row count; round-trip property test (legacy read → SQLite write → SQLite read = legacy read) is part of phase 5.6 test suite

## INV-3: Integrity is checked exactly once per (connection lifetime, sessionID)
- **Statement**: `PRAGMA integrity_check` runs on the first acquire of a connection for a given session in the daemon process; result is cached for the lifetime of that connection.
- **Why**: Cost is non-trivial on large DBs; running it per query would be wasteful
- **Enforced at**: `IntegrityChecker.run()` checks an in-memory map keyed by connection handle; pool eviction invalidates the cache (next acquire re-runs)
- **Exception**: `opencode session-inspect check` always runs the check fresh regardless of cache (debug surface)

## INV-4: SQLite errors never re-route to the legacy reader
- **Statement**: If `Router` dispatches a call to `SqliteStore` and the call throws, the error propagates to the caller. The Router does not catch and re-attempt via `LegacyStore`.
- **Why**: AGENTS.md rule 1 (no silent fallback). A SQLite error usually means corruption — falling back hides it.
- **Enforced at**: `Router` dispatch logic; integration test TV-14 verifies

## INV-5: tokens_total column is the only source of truth for compaction's token estimation
- **Statement**: `MessageV2.filterCompacted` (and any other consumer of accumulated tokens during runloop) reads `messages.tokens_total` from the row directly. `JSON.stringify(msg).length / 4` is never called inside this path on SQLite-format sessions.
- **Why**: DD-6 — the original cost was multi-MB per round on long sessions
- **Enforced at**: `filterCompacted` implementation (verified by TV-6 with instrumented stringify counter)

## INV-6: Per-message commit atomicity
- **Statement**: A single message + all its parts is written inside one SQLite transaction. Partial writes (message info without parts, or some parts without others) are impossible to observe from a successful commit.
- **Why**: DR-1 — daemon kill mid-write must not leave half-formed messages
- **Enforced at**: `SqliteStore.upsertMessage()` and the runloop's processor.ts `finish-step` handler; transaction boundary tests in 2.9

## INV-7: Pool entries always reflect the live filesystem state
- **Statement**: A pool entry for sessionID `X` always points at the file `<storage-root>/session/X.db` that exists on disk. If the file is moved / deleted by an external process, the next operation through that handle either succeeds (POSIX deferred unlink semantics, file still open) or surfaces a clean error — it never silently writes to a path that no longer logically belongs to that session.
- **Why**: External tools (rsync restore, manual `rm`) may interact with these files; pool must not paper over inconsistencies
- **Enforced at**: `ConnectionPool.acquire()` runs a `stat` precheck on first use; subsequent operations rely on the OS file handle (which is stable)

## INV-8: schema_version monotonically advances per session
- **Statement**: For any session DB, `meta.schema_version` only ever moves forward. A failed migration ROLLBACKs to the prior version (DR-5). There is no path that downgrades a v2 DB back to v1.
- **Why**: Forward-only migration simplifies reasoning; rollback unit tests validate the migration logic, not a runtime downgrade path
- **Enforced at**: `MigrationRunner.runForward()` ROLLBACK on failure; `SchemaVersionTooNewError` thrown if runtime sees a future version (refuses to load rather than guess at downgrade)

## INV-9: Legacy directory deletion is the last step of migration, not an intermediate one
- **Statement**: DreamingWorker only invokes `rm -rf <sid>/messages/` AFTER `rename(<sid>.db.tmp, <sid>.db)` has succeeded.
- **Why**: DR-4 requires legacy to remain readable until SQLite is committed and verified
- **Enforced at**: DreamingWorker stage ordering; phase 5.6 fault-injection tests cover the crash points

## INV-10: One DreamingWorker migration per tick, never overlapping
- **Statement**: At most one session is in stages 1-4 at any moment. The next idle-sweep tick does not begin a new migration if the previous one is still running.
- **Why**: DD-8 — bounds IO impact
- **Enforced at**: DreamingWorker uses an internal `inFlight: boolean` flag; ticks that fire while inFlight log `dreaming.skipped_active_writes` (or rather, `dreaming.skipped_in_flight`) and return immediately
