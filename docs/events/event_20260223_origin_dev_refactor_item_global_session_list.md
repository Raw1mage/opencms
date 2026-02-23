# Event: origin/dev refactor item - global session list (experimental)

Date: 2026-02-23
Status: Integrated

## Source

- `7419ebc87` feat: add list sessions for all sessions (experimental)

## Analysis

- cms already exposes equivalent global listing behavior:
  - Route: `GET /experimental/session`
    - operationId: `experimental.session.list`
    - file: `packages/opencode/src/server/routes/experimental.ts`
  - Data source: `Session.listGlobal(...)`
    - file: `packages/opencode/src/session/index.ts`
  - Supports global cross-project query controls (`directory`, `roots`, `start`, `cursor`, `search`, `limit`, `archived`).
- Existing non-experimental `GET /session` remains project-scoped (`Session.list()`), which is expected and distinct.

## Decision

- Promote global session listing from experimental-only behavior to default `/session` list behavior.
- Keep directory-based narrowing as an explicit filter (`?directory=...`) instead of implicit project scoping.

## Code Delta (cms)

- `packages/opencode/src/server/routes/session.ts`
  - `GET /session` now uses `Session.listGlobal(...)`.
- `packages/opencode/src/cli/cmd/session.ts`
  - `session list` now uses `Session.listGlobal()`.
- `packages/opencode/test/server/session-list.test.ts`
  - Added regression test: default route lists sessions across directories.

## Follow-up UX Delta

- `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`
  - Session list entries now include explicit `[$PROJECTNAME]` tags in titles.
  - Removed path display from session list rows to reduce visual noise.
- `packages/opencode/src/cli/cmd/session.ts`
  - Table output now includes `Project` column with bracketed project name labels.
