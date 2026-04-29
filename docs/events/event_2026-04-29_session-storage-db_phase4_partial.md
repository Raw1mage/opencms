# Phase 4 (partial) — session-storage-db (Hot path swap, infra portion)

**Date**: 2026-04-29
**Spec**: `/specs/session-storage-db/`
**State**: implementing (phase 4 partial — 4.1, 4.2, 4.3 closed; 4.4, 4.5 awaiting user approval)
**Branch**: `beta/session-storage-db` (beta worktree)

## Done

- **4.1** Default `Session.create` to allocate `<sid>.db` for new sessions — already implicit from Phase 3. Router's `detectFormat` returns `sqlite` for fresh sessionIDs (no `.db` AND no legacy directory both present), and `SqliteStore.upsertMessage` creates the `.db` file via `ConnectionPool.acquire` on the first write. No additional code change needed at `Session.create` itself.

- **4.2** Adjust session lifecycle hooks. The two non-trivial sites:
  - `Storage.sessionStats(sessionID)` — now stat-checks `<sid>.db` first; if present, opens read-only and counts via `SELECT COUNT(*) FROM messages` + `SELECT COUNT(*) FROM parts`, uses `dbStat.size` and `dbStat.mtimeMs` for size + lastUpdated. Falls through to the legacy directory walk only when no `.db` file is found. SQLite open / query failure inside `sessionStats` falls through silently — this is a metadata-only best-effort path, not a runtime read (DD-13 still applies to the runtime read paths through Router).
  - `Session.delete` is already routed through `StorageRouter.deleteSession` (Phase 3); the Router's deleteSession already cleans both formats opportunistically.
  - Recycle-bin and export do not have storage-format-specific code; they operate on the whole `<sid>/` directory + the sibling `<sid>.db` via filesystem recursive operations and already work correctly without modification.

- **4.3** Backup script audit (`script/sync-config-back.sh` + `webctl.sh`). No `.json`-only or `messages/`-only globs exist. The user's nightly NAS rsync targets the entire `storage/session/` directory which already includes `.db` files as siblings of the legacy `<sid>/` subtrees. No script change needed.

## Not done — awaiting user approval (GATE)

- **4.4** End-to-end smoke test: create a new session, send 5 messages, kill the daemon, restart, verify messages survive and finish-step transitions are intact. **Requires rebuilding + restarting the dev daemon against `~/.local/share/opencode/`.** The user has another active opencode session in flight; running `webctl.sh restart` will cycle that daemon. AI cannot run unilaterally; needs the user to say go.

- **4.5** Benchmark on a synthetic 2000-message session: per-round runloop wall time on the new SQLite path vs the legacy walk, target ≥ 70% reduction (handoff.md acceptance check; `< 50%` triggers a GATE per `handoff.md § Stop Gates In Force`). **Requires generating synthetic data and running the daemon under benchmark instrumentation.** AI cannot run unilaterally.

## Validation

- `bun test packages/opencode/src/session/storage/`: **38 pass / 0 fail / 74 expects**.
- `bunx tsc --noEmit`: clean for storage modules + the new `Storage.sessionStats` SQLite branch.

## Drift

`plan-sync` not invoked yet. No new drift introduced; the phase 1 / 2 / 3 unrelated-file warnings persist.

## Remaining

Phase 4 closes after the user approves and the smoke test + benchmark pass. Until then: code is in place, tests are green, but **no real session has yet been written through the SQLite path on the user's actual `~/.local/share/opencode/` directory**. The behavior change is gated behind the user invoking the daemon restart.

Phase 5+ depends on 4.4 + 4.5 passing — Dreaming-mode worker runs against real legacy sessions and we need confidence the hot path is correct first.

## Honest stop

Per `handoff.md § Stop Gates In Force` and the per-task ritual, this is the responsible boundary. AI has carried the work as far as it can without touching the user's live daemon or generating synthetic test data that requires user-side coordination. Reporting back for explicit approval before:

1. `webctl.sh restart` to pick up the new code
2. Manual smoke test (5 messages → kill → restart → inspect)
3. Synthetic 2000-message session generation + benchmark run

Once 4.4 + 4.5 land green, autorun continues into Phase 5 (dreaming mode) and onward.
