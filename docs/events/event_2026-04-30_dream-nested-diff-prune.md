# Event: dream nested diff prune

## Requirement

- Fix the final blocked DreamingWorker legacy-session migration after RCA found a 970MB `apply_patch` diff stored under `state.metadata.diff`.

## Scope

- IN: `DreamingWorker` tool-part pruning for nested `state.metadata.diff` / `state.metadata.files[]` snapshots; tmp DB materialization guard; regression coverage for legacy -> SQLite migration.
- OUT: daemon restart, destructive cleanup of the legacy session, storage architecture rewrite, or broad LegacyStore retirement.

## Task List

- [x] Patch `packages/opencode/src/session/storage/dreaming.ts` to prune nested tool metadata diffs and file snapshots.
- [x] Add regression test in `packages/opencode/src/session/storage/dreaming.test.ts`.
- [x] Run targeted storage migration tests and real single-session migration.

## RCA / Checkpoints

- Baseline: `dream status` disk scan showed `migrated=2417`, `pending=1`, `tmp=0`, `legacyDebris=0`.
- Evidence: pending session `ses_3518b7efbffeBBgBAyT7g4eq0v` contains a 970,304,118-byte `apply_patch` part; oversized fields were `state.metadata.diff` plus `state.metadata.files[].diff` / `before`, not top-level `metadata.diff`.
- Root cause: existing pruning covered `part.metadata.diff` and `part.state.output`, but missed nested `state.metadata` apply-patch payloads, so migration attempted to insert a near-1GB JSON payload into SQLite.
- Follow-up checkpoint: after pruning, the real migration exposed a tmp DB materialization boundary where Bun SQLite did not leave the expected `.db.tmp` file before fsync. `writeSnapshot` now verifies the tmp path and uses the same DB handle to materialize it with `VACUUM INTO` before integrity validation; absence after that is explicit failure.

## Validation

- `bun test "./packages/opencode/src/session/storage/dreaming.test.ts"` — 8 pass, 0 fail, 34 assertions.
- Real migration: `DreamingWorker.migrateSession("ses_3518b7efbffeBBgBAyT7g4eq0v")` — succeeded.
- Post-migration disk status: `migrated=2418`, `pending=0`, `tmp=0`, `legacyDebris=0`, `retirementGate=open`.
- Migrated DB evidence: `messages=149`, `parts=556`, `dream_pruned_parts=1`, `dream_pruned_bytes=768968108`, `legacy_message_count=149`.

## Architecture Sync

- Verified (No doc changes). This patch stays inside the existing `DreamingWorker` legacy -> SQLite migration boundary: it adds stricter payload sanitization and tmp materialization validation without changing session storage ownership, routing, schema, or cross-module data flow.

## Backup

- XDG whitelist backup: `/home/pkcs12/.config/opencode.bak-20260430-dream-nested-diff-prune/` (pre-change snapshot; manual restore only if requested).
