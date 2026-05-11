---
date: 2026-05-11
summary: "hotfix implemented and tests green"
---

# hotfix implemented and tests green

## Implementation

Two surgical patches landed in working tree (uncommitted):

- `packages/opencode/src/session/user-message-persist.ts` — `reclaimOrphanAssistant` helper + inline call after `Plugin.trigger("chat.message",…)` and before `Session.updateMessage(input.info)`. Orphan = latest message is `role='assistant'` with `time.completed===undefined` AND `Date.now()-time.created >= 5000`. Finalizes via `Session.updateMessage` (preserves StorageRouter/Bus/usage-delta plumbing); emits `session.orphan_assistant_reclaimed` (workflow). On `updateMessage` throw, emits `session.orphan_assistant_reclaim_failed` (workflow, warn) and does not propagate.
- `packages/opencode/src/session/rebind-epoch.ts` — module-level `everBumped: Set<string>`; predicate `trigger==='daemon_start' && everBumped.has(sid) && registryEntryMissing` emits `session.rebind_epoch_unexpected_reset` (anomaly, `rebind_epoch_reset` flag). `everBumped.add(sid)` after every successful bump. `clearSession` and `reset` both clear it. Added `_evictRegistryEntryForTest` test seam.

## Tests

- `packages/opencode/src/session/user-message-persist.orphan-reclaim.test.ts` — 6 tests covering TV-1..TV-4 + empty-stream + updateMessage-throw. All pass.
- `packages/opencode/src/session/rebind-epoch.test.ts` — extended with 4 tests covering normal-first-bump no-anomaly, evict-then-rebump anomaly, non-daemon_start no-anomaly, clearSession-clears-breadcrumb. All pass alongside existing 10 tests (14 total).

## Validation

- `bun test packages/opencode/src/session/rebind-epoch.test.ts` → 14 pass, 0 fail, 64 expect() calls.
- `bun test packages/opencode/src/session/user-message-persist.orphan-reclaim.test.ts` → 6 pass, 0 fail, 28 expect() calls.
- `bun x tsgo --noEmit` in `packages/opencode/` → exit 0 (clean). The pre-existing `console-function` typecheck error (missing `sst` module) is unrelated to this hotfix.

## Pending operator actions

- Code commit NOT yet executed. Per memory rules: code → beta worktree, docs → main repo, no auto-restart of daemon.
- Plan-doc commit on main NOT yet executed.
- Daemon NOT restarted; effect on running session requires user consent first.

