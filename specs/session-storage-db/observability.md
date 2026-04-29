# Observability: session-storage-db

## Events

(Section name kept for plan-builder validator; subsections below split Bus events vs structured logs vs metrics.)

## Bus Events

All Bus events are published via the existing `Bus` infrastructure with `domain: "storage"`. Subscribers include the admin panel sidebar, the structured logger, and (where applicable) Grafana exporters.

### `session.storage.corrupted`
- **When**: IntegrityChecker detects non-`ok` integrity_check on first open of a SQLite session DB
- **Payload**: `{ sessionID: string, integrityCheckOutput: string, dbPath: string, timestamp: number }`
- **Severity**: ERROR
- **Consumer expectations**: admin panel surfaces persistent banner; user can click to view full integrity_check output

### `session.storage.migration_started`
- **When**: DreamingWorker begins the first stage of migrating a legacy session
- **Payload**: `{ sessionID: string, legacyMessageCount: number, timestamp: number }`
- **Severity**: INFO

### `session.storage.migrated`
- **When**: DreamingWorker successfully completes all four stages (read → tmp write → verify → atomic rename + legacy delete)
- **Payload**: `{ sessionID: string, legacyMessageCount: number, sqliteRowCount: number, durationMs: number, timestamp: number }`
- **Severity**: INFO

### `session.storage.migration_failed`
- **When**: any DreamingWorker stage aborts (integrity fail, row count mismatch, write error, schema migration in tmp DB fails)
- **Payload**: `{ sessionID: string, stage: "read" | "tmp_write" | "integrity_check" | "row_count" | "rename" | "legacy_delete", error: string, timestamp: number }`
- **Severity**: ERROR (or WARN for recoverable cases like row-count mismatch, which retries)

### `session.storage.legacy_debris_resolved`
- **When**: Router detects both `<sid>.db` and `<sid>/messages/` present without a `<sid>.db.tmp`; schedules legacy directory deletion
- **Payload**: `{ sessionID: string, deletedAt: number }`
- **Severity**: INFO

### `session.storage.read_failed`
- **When**: SqliteStore propagates an underlying read error (DD-13 — no silent fallback)
- **Payload**: `{ sessionID: string, operation: string, error: string, timestamp: number }`
- **Severity**: ERROR

### `session.storage.write_failed`
- **When**: SqliteStore propagates an underlying write error
- **Payload**: `{ sessionID: string, operation: string, error: string, timestamp: number }`
- **Severity**: ERROR

## Metrics

All metrics use the existing telemetry pipeline. Histogram bucket boundaries match the existing convention in `runtime-event-service.ts`.

### Histograms

- `session_storage_open_ms` — wall time of `SqliteStore.open()` including IntegrityChecker first-pass and any schema migration. Tagged: `format` ∈ {`sqlite`, `legacy`}, `cold_open` ∈ {`true`, `false`}.
- `session_storage_query_ms` — wall time of message+parts read for a session. Tagged: `format`, `message_count_bucket` ∈ {`<100`, `<500`, `<2500`, `>=2500`}.
- `session_storage_write_ms` — wall time of a single message-or-part write transaction. Tagged: `operation` ∈ {`upsert_message`, `upsert_part`, `delete_message`}.
- `session_storage_migrate_duration_ms` — wall time of one DreamingWorker session migration end-to-end. Tagged: `outcome` ∈ {`success`, `row_count_mismatch`, `integrity_failed`, `crashed`}.
- `session_storage_migrate_stage_ms` — per-stage duration. Tagged: `stage` ∈ {`read`, `tmp_write`, `integrity_check`, `rename`, `legacy_delete`}.
- `session_storage_integrity_check_ms` — wall time of `PRAGMA integrity_check`. Tagged: `result` ∈ {`ok`, `non_ok`}.

### Gauges

- `session_storage_connection_pool_size` — current ConnectionPool entry count
- `session_storage_connection_pool_capacity` — pool cap (currently 32)
- `session_storage_legacy_sessions_pending_count` — number of legacy `<sid>/messages/` directories without a corresponding `<sid>.db`. Updated each idle-sweep tick. **Hits 0 = LegacyStore retirement gate is open** (Phase 9.3 tracker).
- `session_storage_active_writers` — count of sessions with an in-flight write transaction (used by DreamingWorker's idle detector)

### Counters

- `session_storage_migrations_total` — incremented per migration attempt. Tagged: `outcome`.
- `session_storage_corrupted_total` — incremented per `session.storage.corrupted` Bus event.
- `session_storage_legacy_debris_resolved_total` — incremented per debris resolution.

## Structured Logs

All logs use the existing `Log.create({ service: "session.storage" })` namespace.

### Required fields on every log entry
- `sessionID` (string) — except daemon-startup-time logs that haven't yet localized to a session
- `service` (literal `"session.storage"`)
- `traceID` if available from caller

### Log lines

| Level | Pattern | Triggered by |
|---|---|---|
| INFO  | `connection.pool.acquire { sessionID, mode, cold_open }` | every `ConnectionPool.acquire()` |
| INFO  | `connection.pool.release { sessionID, idle_ms }` | connection returned to pool |
| INFO  | `connection.pool.evict { sessionID, idle_ms }` | LRU eviction or idle timeout |
| INFO  | `migration.started { sessionID, legacy_message_count }` | DreamingWorker begins |
| INFO  | `migration.stage { sessionID, stage, duration_ms }` | each migration stage completes |
| INFO  | `migration.completed { sessionID, duration_ms, sqlite_row_count }` | full migration success |
| WARN  | `migration.row_count_mismatch { sessionID, legacy_count, sqlite_count }` | DR-4 verification fail |
| ERROR | `migration.integrity_failed { sessionID, integrity_check_output }` | DR-4 verification fail |
| ERROR | `migration.aborted { sessionID, stage, error }` | any stage error |
| INFO  | `dreaming.tick { idle_for_ms, pending_count, picked_session_id? }` | each idle-sweep tick |
| INFO  | `dreaming.skipped_active_writes { active_writer_count }` | tick fired but daemon not idle |
| ERROR | `integrity.failed { sessionID, integrity_check_output }` | first-open IntegrityChecker fail |
| INFO  | `schema.migration { sessionID, from_version, to_version, duration_ms }` | MigrationRunner forward run |
| ERROR | `schema.migration.failed { sessionID, from_version, to_version, error }` | DR-5 ROLLBACK |
| INFO  | `router.dispatch { sessionID, format, operation }` | DEBUG by default; INFO when format-mismatch detected |
| INFO  | `router.legacy_debris { sessionID, scheduled_for_deletion }` | both formats present without tmp |
| ERROR | `read.failed { sessionID, operation, error }` | StorageReadError |
| ERROR | `write.failed { sessionID, operation, error }` | StorageWriteError |

## Alerts

(For installations that wire metrics to Grafana / alertmanager. Out of scope for v1 implementation tasks but documented here so the metric design is consistent with future alerting needs.)

- `session_storage_corrupted_total` rate > 0 over 1h → page (data-loss signal)
- `session_storage_migrate_duration_ms` p99 > 60s → warn (something is unusually slow)
- `session_storage_legacy_sessions_pending_count` not decreasing over 24h with daemon online → info (dreaming mode may be stalled)
- `session_storage_connection_pool_size` >= capacity for > 5min → warn (pool exhaustion)

## Sidebar / TUI surface

- `session.storage.corrupted` events surface as a persistent banner in the admin panel session view, with a "Run integrity check" button (invokes `opencode session-inspect check <sid>` via API)
- `session.storage.migrated` events fire a one-shot toast in the admin panel "Sessions" list
- `session.storage.migration_failed` events stay in the structured-error sidebar entry until acknowledged
