# Event: Workspace Alignment — TUI/Webapp 一致化

**Date**: 2026-03-20
**Branch**: `workspace-alignment` (opencode-beta, based on opencode cms HEAD)

## Scope

- Task 1.1–1.5: Phase 1 — Mutable SDK Directory
- Task 2.1–2.5: Phase 2 — Workspace List + Switch UI
- Task 3.1–3.3: Phase 3 — Session Filter by Workspace
- Task 4.3–4.5: Phase 4 (partial) — Cross-Client Consistency

## Key Decisions

1. **SDK directory as reactive signal**: `sdk.tsx` now uses `createSignal` for both `activeDirectory` and `currentClient`. `switchDirectory()` aborts old SSE, rebuilds client, restarts SSE loop.
2. **Sync re-bootstrap via effect**: `sync.tsx` watches `sdk.directory` signal and triggers full `bootstrap()` on change, clearing `fullSyncedSessions` cache.
3. **Session list directory filter**: `bootstrap()` passes `{ directory }` to `session.list()` API when a directory is active.
4. **SSE session scoping**: `session.updated` handler filters new (not-yet-seen) sessions by directory to prevent cross-workspace contamination.
5. **Workspace picker as on-demand dialog**: `DialogWorkspace` fetches `project.list()` on mount via `createResource`. No persistent project list in sync store — avoids stale cache complexity.
6. **Command registration**: `/workspace` slash command registered in command palette under "System" category.

## Issues Found

- None. Pre-existing TS errors unrelated to modified files.

## Verification

- TypeScript: `tsc --noEmit` passes for all modified files (sdk.tsx, sync.tsx, dialog-workspace.tsx, app.tsx)
- Runtime testing: pending (1.6, 3.4, 4.1, 4.2)

## Remaining

- Task 1.6: Runtime verify session.create carries correct directory after switch
- Task 2.4: Workspace indicator on TUI home route (cosmetic)
- Task 3.4: Runtime cross-workspace session isolation test
- Task 4.1/4.2: Cross-client TUI↔webapp runtime validation

## Architecture Sync

Verified (No doc changes) — changes are within TUI client layer only; no module boundary or server-side architecture changes.
