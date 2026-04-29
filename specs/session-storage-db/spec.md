# Spec: session-storage-db

## Purpose

Replace per-message / per-part filesystem layout (`~/.local/share/opencode/storage/session/<sid>/messages/<mid>/{info.json, parts/<pid>.json}`) with a single SQLite file per session (`~/.local/share/opencode/storage/session/<sid>.db`). Provide a background dreaming-mode worker for legacy migration and a dual-track reader so legacy and SQLite formats coexist during rollout.

## Requirements

### Requirement: Session messages persist in a single SQLite file
Storage layer creates and maintains one `.db` file per session. All message info, parts, and session-scoped metadata live inside that file.

#### Scenario: New session starts
- **GIVEN** no prior storage entity exists for `sessionID`
- **WHEN** the daemon writes the first message
- **THEN** `<storage-root>/session/<sid>.db` is created
- **AND** the file contains `messages`, `parts`, `meta` tables per `data-schema.json`
- **AND** `meta.schema_version` matches the runtime's expected version
- **AND** `PRAGMA journal_mode = WAL` is set
- **AND** `PRAGMA synchronous = NORMAL` is set

#### Scenario: Existing SQLite session opened
- **GIVEN** `<sid>.db` exists with `meta.schema_version = N`
- **WHEN** daemon attempts to open the session
- **THEN** if `N` equals runtime version: open succeeds with read+write
- **AND** if `N < runtime version`: schema migration runs in transaction; on success open proceeds; on failure DB stays at old version and is opened read-only with a Bus error event published
- **AND** if `N > runtime version`: open fails with explicit error (older daemon must not corrupt newer schema)

### Requirement: Disaster resilience matches DR-1 through DR-5
The five failure domains in `proposal.md § Disaster Resilience Contract` are all enforced. No silent fallback.

#### Scenario: DR-1 daemon killed mid-write
- **GIVEN** daemon is writing a message + parts to `<sid>.db`
- **WHEN** daemon process is SIGKILL'd between two transactions
- **THEN** committed transactions remain in WAL; uncommitted transactions are lost
- **AND** next daemon start opens the DB cleanly with no corruption
- **AND** the lost message either does not appear or appears with all parts (atomic per-message commit)

#### Scenario: DR-2 power loss with synchronous=NORMAL
- **GIVEN** active writes to `<sid>.db`
- **WHEN** machine loses power
- **THEN** on next boot at most one un-checkpointed commit may be lost
- **AND** the file remains a valid SQLite database (no torn pages)

#### Scenario: DR-3 corruption detected on open
- **GIVEN** `<sid>.db` is corrupt (manually or due to disk fault)
- **WHEN** daemon opens it and runs `PRAGMA integrity_check`
- **THEN** the check returns non-`ok`
- **AND** daemon refuses to load the session
- **AND** publishes `session.storage.corrupted` Bus event with `sessionID` + integrity_check output
- **AND** logs an error visible to the user
- **AND** does NOT auto-repair

#### Scenario: DR-4 dreaming mode crash mid-migrate
- **GIVEN** dreaming mode is migrating `<sid>/messages/` → `<sid>.db.tmp`
- **WHEN** daemon is killed before atomic rename
- **THEN** on next start the legacy `<sid>/` directory still exists intact
- **AND** the partial `<sid>.db.tmp` is detected and deleted
- **AND** the session can be opened via legacy reader path
- **AND** dreaming mode requeues the session for retry

#### Scenario: DR-5 schema migration failure
- **GIVEN** runtime expects schema version N+1, DB has version N
- **WHEN** the migration SQL inside the transaction errors
- **THEN** SQLite ROLLBACK restores the DB to version N
- **AND** the session opens read-only
- **AND** a Bus error event is published

### Requirement: Per-round runloop reads use indexed SQL, not filesystem walk
The current cost (1 stream + 2253 disk reads + multi-MB JSON.stringify per round) is replaced by a single indexed query plus result deserialization.

#### Scenario: Read full session message stream
- **GIVEN** a session DB with K messages
- **WHEN** runloop calls the new `Session.messages(sessionID)` equivalent
- **THEN** the implementation issues exactly one SQL query plus per-message part fetches via index
- **AND** total time is bounded by row count, not message-content size

#### Scenario: filterCompacted no longer stringifies
- **GIVEN** the runloop walks messages back to the most recent anchor
- **WHEN** estimating accumulated tokens
- **THEN** the per-message contribution comes from the stored `tokens.total` column
- **AND** `JSON.stringify(msg).length / 4` is never called inside this path

### Requirement: Dual-track reader is transparent
While legacy directory-format sessions still exist, callers of the storage layer must not need to know which format any given session uses.

#### Scenario: Legacy session opened
- **GIVEN** `<sid>.db` does not exist but `<sid>/messages/` does
- **WHEN** any storage API is called for that session
- **THEN** the legacy directory reader handles the call
- **AND** the call signature and return shape are identical to the SQLite path

#### Scenario: Both formats present (post-crash debris)
- **GIVEN** `<sid>.db` AND `<sid>/messages/` both exist
- **AND** `<sid>.db.tmp` does NOT exist
- **WHEN** storage layer opens the session
- **THEN** the SQLite file wins (migration completed, debris not yet cleared)
- **AND** the legacy directory is scheduled for removal at next idle

### Requirement: Dreaming mode runs only when daemon is idle
Background migration must not contend with active session writes.

#### Scenario: Idle sweep picks up a legacy session
- **GIVEN** at least one legacy `<sid>/messages/` directory exists with no `<sid>.db`
- **AND** no session has had a message write in the last `IDLE_THRESHOLD_MS` (configurable, default 5000 ms)
- **WHEN** dreaming mode tick fires
- **THEN** exactly one legacy session is selected (oldest-touched first)
- **AND** the migration runs to completion or fails per DR-4
- **AND** no other session is migrated in the same tick

#### Scenario: User opens legacy session before dreaming mode reaches it
- **GIVEN** `<sid>/messages/` exists and has not yet been migrated
- **WHEN** the user opens that session in TUI / admin panel
- **THEN** reads succeed via the legacy reader path
- **AND** dreaming mode does NOT immediately migrate that session (avoids blocking the active read)
- **AND** the session is migrated later when it goes idle again

#### Scenario: Dreaming mode aborts when active write arrives
- **GIVEN** dreaming mode is mid-migration of `<sid>`
- **WHEN** an active write arrives for any session (including a different one)
- **THEN** the current migration completes its in-flight stage atomically
- **AND** subsequent stages defer to the next idle tick
- **AND** if the abort lands before the atomic rename, DR-4 path applies

### Requirement: session-inspect debug CLI
Provide a small CLI to recover the human-readable inspection capability lost when the directory layout went away.

#### Scenario: List messages
- **GIVEN** a session DB exists
- **WHEN** `opencode session-inspect list <sid>` runs
- **THEN** stdout shows one row per message with id, role, time, finish, token totals

#### Scenario: Show one message
- **GIVEN** a session DB exists
- **WHEN** `opencode session-inspect show <sid> <messageID>` runs
- **THEN** stdout is a JSON object with the message info plus all parts ordered by sequence

#### Scenario: Integrity check
- **GIVEN** a session DB exists
- **WHEN** `opencode session-inspect check <sid>` runs
- **THEN** the command runs `PRAGMA integrity_check` and prints the result
- **AND** exit code 0 if `ok`, non-zero otherwise

## Acceptance Checks

- [ ] All Scenarios above have a corresponding test vector in `test-vectors.json`
- [ ] All five DR scenarios pass under simulated fault injection
- [ ] Per-round runloop wall time on the 2253-message reference session drops by ≥ 70%
- [ ] Legacy session opened in dual-track mode produces byte-identical message+parts output to the SQLite path (modulo whitespace in JSON serialization)
- [ ] `opencode session-inspect` covers `list` / `show` / `check` and is documented in `--help`
- [ ] No code path silently falls back from SQLite to legacy on error (every fallback is logged + Bus-event-published)
