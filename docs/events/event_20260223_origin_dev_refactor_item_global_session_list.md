# Event: origin/dev refactor item - global session list (experimental)

Date: 2026-02-23
Status: Integrated (no code delta)

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

- Marked as already integrated.
- No additional code changes required for this item.
