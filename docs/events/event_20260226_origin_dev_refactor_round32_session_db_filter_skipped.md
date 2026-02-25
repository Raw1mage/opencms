# Event: origin/dev refactor round32 (session db-level filter)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Assess upstream session-list DB-level filtering optimization for cms under rewrite-only constraints.

## 2) Candidate

- Upstream commit: `68bb8ce1da922229e6ab4dde4207b431cf9d76a8`
- Subject: `core: filter sessions at database level to improve session list loading performance`

## 3) Decision + rationale

- Decision: **Skipped**
- Rationale:
  - Upstream optimization depends on sql table-backed session store (`SessionTable`, query builder conditions, order/limit in DB).
  - cms currently uses file/index storage and `Session.listGlobal()` over storage iterators; no equivalent DB table surface exists for direct port.
  - Port would require broader storage architecture migration, exceeding localized rewrite-only scope.

## 4) File scope reviewed

- Upstream touched:
  - `packages/opencode/src/session/index.ts`
  - `packages/opencode/src/server/routes/session.ts`
- Current cms basis:
  - `packages/opencode/src/session/index.ts` (`listGlobal` file/index filtering)
  - `packages/opencode/src/storage/storage.ts` (index/list mechanics)

## 5) Validation plan / result

- Validation method: upstream diff comparison + current storage architecture inspection.
- Result: skipped due architectural mismatch (DB-only optimization path not portable as a local behavior patch).

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before decision.
- No architecture change applied.
