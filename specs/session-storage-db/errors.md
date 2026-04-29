# Errors: session-storage-db

## Error Catalogue

Every thrown error type below has a stable identifier, a user-visible message template, a recovery strategy, and a responsible layer.

### `StorageCorruptionError`

- **Code**: `STORAGE_CORRUPTED`
- **Layer**: SqliteStore (raised by IntegrityChecker after `PRAGMA integrity_check` returns non-`ok`)
- **Message template**: `Session storage database <sid>.db failed integrity check. Daemon refused to load it.`
- **Payload fields**: `sessionID` (string), `integrityCheckOutput` (string), `dbPath` (string), `timestamp` (epoch ms)
- **Recovery (user-driven)**:
  1. Check log + Bus event for `session.storage.corrupted` payload
  2. Run `opencode session-inspect check <sid>` to reproduce verdict
  3. Restore `<sid>.db` from a known-good rsync snapshot, or
  4. Run `sqlite3 <sid>.db ".recover"` and review output before importing into a fresh DB
  5. As last resort: delete `<sid>.db` (session is lost)
- **Auto-repair**: NEVER. DR-3 contract.
- **Silent fallback to LegacyStore**: NEVER. DD-13.
- **Triggers**: corrupt page detected at runtime; partial write from non-WAL writer; disk-level fault
- **Emits**: Bus event `session.storage.corrupted`; structured log at ERROR

### `SchemaVersionTooNewError`

- **Code**: `SCHEMA_VERSION_TOO_NEW`
- **Layer**: SqliteStore on open
- **Message template**: `Session storage <sid>.db schema version <N> is newer than this daemon expects (<M>). Upgrade the daemon binary.`
- **Payload fields**: `sessionID`, `dbVersion` (integer), `runtimeVersion` (integer), `dbPath`
- **Recovery (user-driven)**:
  1. Upgrade the opencode daemon binary
  2. Or: revert the binary version that wrote this DB if intentional rollback is desired (DB stays usable; older daemon refuses to open it deliberately to avoid corruption)
- **Auto-repair**: NEVER (forward-compat is not the v1 contract; never run unknown future migration in reverse)
- **Triggers**: user downgrades daemon binary, or different daemon versions across users on the same shared filesystem
- **Emits**: structured log at ERROR; refuse to load

### `SchemaMigrationFailedError`

- **Code**: `SCHEMA_MIGRATION_FAILED`
- **Layer**: MigrationRunner
- **Message template**: `Migration of <sid>.db from schema v<N> to v<N+1> failed. Database remains at v<N> in read-only mode.`
- **Payload fields**: `sessionID`, `fromVersion`, `toVersion`, `error` (serialized inner error), `dbPath`
- **Recovery (user-driven)**:
  1. File a bug — every shipped migration ships with forward + rollback unit tests; production failure means a real edge case slipped through
  2. Stay on the current daemon (DB is read-only but readable) until a fix lands
  3. Or: manually run the rollback SQL from `migrations/v<N+1>.ts` to restore writability if the user understands the risk
- **Auto-repair**: NEVER
- **Triggers**: bug in migration SQL; environmental constraint (e.g. disk full mid-transaction)
- **Emits**: Bus event `session.storage.migration_failed`; structured log at ERROR

### `MigrationRowCountMismatchError`

- **Code**: `MIGRATION_ROW_COUNT_MISMATCH`
- **Layer**: DreamingWorker (DR-4 verification stage)
- **Message template**: `Migration of <sid> aborted: SQLite row count <X> does not match legacy message count <Y>.`
- **Payload fields**: `sessionID`, `legacyCount`, `sqliteCount`, `tmpDbPath`
- **Recovery (automatic)**:
  1. Delete `<sid>.db.tmp`
  2. Leave legacy `<sid>/` intact (still serves reads via LegacyStore)
  3. Requeue the session for next idle tick
- **Auto-repair**: yes — within the DR-4 contract: tmp deletion + retry are not "fixes", they are the documented recovery path
- **Triggers**: legacy directory mutated during the read pass (rare; daemon is idle); bug in encode/decode
- **Emits**: Bus event `session.storage.migration_failed` with stage=`row_count_mismatch`; log at WARN

### `MigrationIntegrityCheckFailedError`

- **Code**: `MIGRATION_INTEGRITY_FAILED`
- **Layer**: DreamingWorker (DR-4 verification stage)
- **Message template**: `Migration of <sid> aborted: tmp database failed integrity check.`
- **Payload fields**: `sessionID`, `integrityCheckOutput`, `tmpDbPath`
- **Recovery (automatic)**: same as `MigrationRowCountMismatchError` — delete tmp, retain legacy, requeue
- **Triggers**: SQLite write path bug; disk fault during tmp write
- **Emits**: Bus event `session.storage.migration_failed` with stage=`integrity_failed`; log at ERROR

### `LegacyDebrisError`

- **Code**: `LEGACY_DEBRIS_DETECTED`
- **Layer**: Router on open
- **Message template**: `Session <sid> has both <sid>.db and <sid>/. SqliteStore takes precedence; legacy directory will be cleaned up at next idle.`
- **Payload fields**: `sessionID`, `dbPath`, `legacyPath`
- **Recovery (automatic)**: ship the read-through-SqliteStore; queue legacy directory deletion at next idle
- **NOT actually thrown as an error** — surfaced as INFO log + Bus event for observability. Listed here for completeness of the storage-state vocabulary.

### `StorageReadError` / `StorageWriteError`

- **Code**: `STORAGE_READ_FAILED` / `STORAGE_WRITE_FAILED`
- **Layer**: SqliteStore (wraps underlying `bun:sqlite` errors)
- **Message template**: `Failed to <read|write> session <sid>: <inner-error-message>`
- **Payload fields**: `sessionID`, `operation` (string), `innerError` (serialized)
- **Recovery (caller-driven)**:
  1. Caller receives the error and decides retry policy (most callers do not retry — daemon's runloop owns retry semantics elsewhere)
  2. Persistent errors trigger DR-3 path on next open
- **Auto-repair**: NEVER. DD-13 (no silent fallback to LegacyStore).
- **Triggers**: filesystem unavailable; disk full; permission error; SQLite I/O error
- **Emits**: structured log at ERROR; Bus event `session.storage.read_failed` or `session.storage.write_failed`

### `SessionInspectError`

- **Code**: `SESSION_INSPECT_INVALID_ARGS` / `SESSION_INSPECT_NOT_FOUND`
- **Layer**: session-inspect CLI
- **Message template**: `Session <sid> not found at <storage-root>/session/.` or `Invalid arguments: <details>.`
- **Payload fields**: command-line context
- **Recovery (user-driven)**: re-run with correct sessionID or argument shape
- **Triggers**: typo in sessionID, session deleted, invalid subcommand
- **Emits**: stderr, exit code 2

## Error-to-Bus-event mapping

| Error | Bus event |
|---|---|
| `StorageCorruptionError` | `session.storage.corrupted` |
| `SchemaMigrationFailedError` | `session.storage.migration_failed` |
| `MigrationRowCountMismatchError` | `session.storage.migration_failed` (stage=`row_count_mismatch`) |
| `MigrationIntegrityCheckFailedError` | `session.storage.migration_failed` (stage=`integrity_failed`) |
| `LegacyDebrisError` (info-only) | `session.storage.legacy_debris_resolved` |
| `StorageReadError` | `session.storage.read_failed` |
| `StorageWriteError` | `session.storage.write_failed` |
| `SchemaVersionTooNewError` | (none — fatal startup-time error; surfaced via daemon's standard fatal-error path) |
| `SessionInspectError` | (none — user-facing CLI error only) |
