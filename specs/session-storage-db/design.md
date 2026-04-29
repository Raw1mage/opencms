# Design: session-storage-db

## Context

Today: each session is a directory tree. `~/.local/share/opencode/storage/session/<sid>/messages/<mid>/` holds an `info.json` plus a `parts/` subdirectory of one file per part. A 2253-message session means roughly 10,000+ filesystem entries. Per-round runloop walks this tree top to bottom, deserializes each part, and runs `JSON.stringify(msg).length / 4` to estimate tokens — multi-MB of stringify work and thousands of disk reads per round.

Goal: replace per-session storage with one SQLite file per session. Preserve "one session = one filesystem entity" so rsync / backup / per-session deletion stay simple. Provide a background migration worker (dreaming mode) plus a dual-track reader so legacy directories and SQLite files coexist during rollout.

## Goals / Non-Goals

### Goals
- One `<sid>.db` SQLite file per session replaces the directory tree
- Read path becomes indexed SQL; per-round runloop bound by row count, not content size
- Production-grade disaster resilience (DR-1 through DR-5 in proposal.md)
- Dreaming mode background migration (idle-time + on-touch read fallback)
- `opencode session-inspect` debug CLI

### Non-Goals
- Cross-session global DB
- Server-process DB (Postgres / MySQL)
- Other storage namespaces (`session_diff/`, `shared_context/`, `todo/`) — this spec only covers `session/<sid>/`
- Compaction algorithm changes
- Runloop-level snapshot caching (separate hotfix axis)
- ORM layer

## Decisions

### DD-1: Granularity is per-session
- **What**: One SQLite database file per session at `<storage-root>/session/<sid>.db`
- **Why**: Preserves single-entity-per-session model. rsync, backup, deletion, recycle-bin all stay simple. Cross-session queries are not a meaningful workload here.
- **Alternatives considered**: One global DB (rejected: makes per-session ops harder, contention risk); per-user DB (rejected: same drawbacks at smaller scale).

### DD-2: SQLite via bun:sqlite, no new runtime dependency
- **What**: Use `bun:sqlite` from Bun's standard library
- **Why**: Zero new dependency. Mature, embedded, single-file.
- **Alternatives**: better-sqlite3 npm (extra dep); LMDB / RocksDB (more exotic, smaller community in this stack).

### DD-3: WAL journal mode + synchronous=NORMAL
- **What**: At open time, set `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL`
- **Why**: WAL allows N readers + 1 writer concurrently without blocking. NORMAL is the documented WAL-safe level: up to one un-checkpointed commit may be lost on power failure, but the database file itself never tears.
- **Rejected**: `synchronous = OFF` (DB can be permanently corrupted on power loss — unacceptable per DR-2). `synchronous = FULL` (~5 ms/write penalty without commensurate benefit at WAL).

### DD-4: Per-user daemon = no cross-process write contention; reader is plain WAL
- **What**: One writer connection per session held by the daemon's runloop. Reader connections (admin panel, TUI, CLI tools) are short-lived read-only handles.
- **Why**: opencode is per-user; only the user's own daemon writes a given session. WAL handles the daemon-writer + N-readers case natively. No queue, no advisory lock layer.

### DD-5: Schema split into `messages`, `parts`, `meta`
- **What**: Three tables. `messages` is one row per message info; `parts` is one row per part with `message_id` foreign key + sequence column; `meta` is a key-value table for `schema_version` and per-session metadata.
- **Why**: Filtering / counting messages without touching part content (the hot path for `filterCompacted` token estimation) becomes a `SELECT id, finish, tokens_total FROM messages` index scan. Adding new part fields does not break message reads. Schema growth is forward-compatible.
- **Rejected**: Single denormalized table (message info repeated per part — write amplification, painful schema evolution).

### DD-6: Token total stored on messages row, not estimated at read time
- **What**: `messages.tokens_total INTEGER NOT NULL DEFAULT 0` populated at finish-step time (already known via the runtime). `filterCompacted` reads this column directly.
- **Why**: Eliminates the multi-MB per-round `JSON.stringify` cost. Existing message info already carries `tokens.total`; we just promote it to a column.

### DD-7: Disaster resilience contract (DR-1 through DR-5)
All five enforced. See `proposal.md § Disaster Resilience Contract` and `spec.md § Requirements` for behavioral contract. Implementation notes:

- **DR-1**: Per-message commit. `BEGIN; INSERT/UPDATE messages; INSERT parts; COMMIT;` is atomic. SIGKILL between transactions = at most current message lost.
- **DR-2**: Inherits from DD-3 (`synchronous = NORMAL`).
- **DR-3**: Daemon runs `PRAGMA integrity_check` lazily on first open of a given session (cached for the lifetime of the daemon's connection). Failure → publish `session.storage.corrupted` Bus event, refuse load. No auto-repair.
- **DR-4**: Three-stage atomic migration:
  1. Write `<sid>.db.tmp` with all rows
  2. fsync + run `integrity_check` + verify row count matches legacy message count
  3. `rename(<sid>.db.tmp, <sid>.db)` (POSIX atomic on same filesystem) → only after success delete `<sid>/messages/`
  Any crash before stage 3 leaves legacy intact and `<sid>.db.tmp` orphaned. On startup: if `<sid>.db.tmp` exists alongside `<sid>/`, delete tmp and requeue session.
- **DR-5**: `meta.schema_version`. Migration script wrapped in `BEGIN ... COMMIT`. Failure → ROLLBACK + open read-only + Bus event.

### DD-8: Dreaming mode trigger = idle sweep + on-touch read fallback
- **What**:
  - **Idle sweep**: a periodic timer in the daemon. Each tick, if no session has had a message-write in `IDLE_THRESHOLD_MS` (default 5000 ms), pick the oldest unmigrated legacy session and migrate it.
  - **On-touch fallback**: if the user opens a legacy session before idle sweep reaches it, the legacy reader serves the request. Dreaming mode does NOT preempt-migrate on read (would block the user).
- **Why**: Predictable, never blocks live traffic, eventually consistent. Daemon-startup batch was rejected (multi-GB legacy = minutes of startup lag).

### DD-9: Storage layer interface stays signature-compatible
- **What**: The existing call surface (`Session.messages`, `MessageV2.stream`, `MessageV2.parts`, `Session.updateMessage`, `Session.updatePart`) keeps the same signatures and return shapes. The dual-track router decides per-call which backend to hit.
- **Why**: Minimizes blast radius. Callers do not need to know which format is in use. Future cleanup (when all sessions are migrated) becomes a one-line removal of the legacy branch.

### DD-10: Connection pool keyed by sessionID, lazy open, idle close
- **What**: `SessionStorage.open(sessionID)` returns a connection. Pool keeps connections warm for `CONNECTION_IDLE_MS` (default 60 s) then closes. Bounded pool size prevents handle exhaustion if many sessions are touched in burst.
- **Why**: SQLite open is fast (~1 ms) but not free; warm pool keeps the runloop hot path lock-free. Idle close prevents handle leak across long-lived daemon.

### DD-11: Backup compatibility — rsync stays valid; investigate live-rsync race
- **What**: Existing `rsync` cron continues to copy session files. SQLite WAL mode means concurrent `rsync` may capture an inconsistent set (DB file + WAL file out of sync). On restore, integrity_check (DR-3) detects this and the user can manually intervene.
- **Why**: The current backup setup remains correct under "daemon stopped" backup windows (the common case for nightly cron). Future enhancement: switch to `sqlite3 .backup` Online Backup API for live-consistent snapshots — out of scope for this spec.

### DD-12: Debug CLI is part of this spec
- **What**: `opencode session-inspect` with subcommands `list <sid>`, `show <sid> <mid>`, `check <sid>`. Read-only access via SQLite connection. Falls through to legacy reader if the session is not yet migrated.
- **Why**: SQLite-isation removes `cat info.json` debugging. Without a replacement, every debugging session forces hand-written SQL. This is small enough work to bundle with the migration itself.

### DD-13: No silent fallback from SQLite path to legacy path
- **What**: Per AGENTS.md rule 1. If a SQLite-backed session exists but throws on read/write, the error propagates. The daemon does not silently re-fetch from the (now deleted) legacy directory.
- **Why**: Silent fallback masks real corruption signals. DR-3 path is the authoritative response.

### DD-14: Dreaming mode is daemon-process resident, not a separate worker process
- **What**: Implementation lives inside the daemon as a setInterval-style timer + idle detector. No separate process / IPC.
- **Why**: Daemon already owns the session lifecycle. A separate process would re-introduce cross-process file contention concerns we just designed away.

## Risks / Trade-offs

### R-1: rsync race with live WAL
SQLite WAL files can be inconsistent on a running DB. Nightly backup window is when daemon may still be active. Mitigation: integrity_check on restore (DR-3) catches this; future improvement is online backup API. Acceptable for v1.

### R-2: Legacy migration time on huge installations
A user with hundreds of GB of legacy sessions takes hours of idle-sweep migration. Mitigation: never blocks live traffic by design (DD-8). User can opt to keep daemon running and let it grind through over days. Document this in handoff.md.

### R-3: SQLite single-file corruption blast radius
Today, a corrupt part file loses one part. With SQLite, a corrupt page might lose a whole session. Mitigation: WAL + NORMAL synchronous + integrity_check on open + rsync backup chain. Documented as DR-3 user-driven recovery.

### R-4: Connection pool exhaustion under burst session opens
If admin panel triggers reads on hundreds of sessions in seconds, pool may grow. Mitigation: bounded pool size with LRU eviction; reads can serialize behind eviction without correctness impact (only latency).

### R-5: Schema migration bugs strand sessions
A bad migration script could leave sessions read-only and unrecoverable without manual SQL. Mitigation: every migration shipped with explicit unit test for forward + rollback (DD-7 / DR-5); CI gates new migrations. Migrations are append-only in `meta.schema_version` history.

### R-6: Two formats coexist indefinitely if dreaming mode is disabled
If a user disables dreaming mode (or daemon never goes idle), legacy sessions stay legacy. Not a correctness risk but operational debt. Mitigation: documented; admin CLI to force-migrate is a possible follow-up.

## Critical Files

Implementation will touch:

- `packages/opencode/src/session/message-v2.ts` — `stream`, `filterCompacted`, `parts`, `get` rewritten to dispatch via dual-track router
- `packages/opencode/src/session/index.ts` — `Session.messages`, `Session.updateMessage`, `Session.updatePart` rewritten via dispatcher
- New: `packages/opencode/src/session/storage/sqlite.ts` — SQLite-backed implementation
- New: `packages/opencode/src/session/storage/legacy.ts` — extracted current directory-based implementation (verbatim move + minimal interface conformance)
- New: `packages/opencode/src/session/storage/router.ts` — dual-track dispatcher; per-session format detection
- New: `packages/opencode/src/session/storage/dreaming.ts` — idle-sweep migration worker
- New: `packages/opencode/src/session/storage/migrations/v1.ts` — initial schema (and `v2.ts` etc. for future)
- New: `packages/opencode/src/cli/cmd/session-inspect.ts` — debug CLI
- New: `packages/opencode/src/session/storage/integrity.ts` — `integrity_check` runner + Bus event publisher
- Tests: `packages/opencode/src/session/storage/*.test.ts` per file

## Open Questions

- Connection pool size cap default value (proposal: 32; revisit if reads serialize too much)
- Where to expose `IDLE_THRESHOLD_MS` and `CONNECTION_IDLE_MS` for tuning — `tweaks.cfg` per existing memory rule on tunable thresholds
- Whether `session-inspect` should also expose write commands (delete a message, fix tokens) — likely no in v1; raw `sqlite3` CLI is the escape hatch
