# Event 2026-05-01 — system-manager DB dialog refactor

## 需求

使用者表示 session 已全面改為 DB，要求重構 system-manager 相關 tool，讓它們讀取 DB 裡的 session dialog。

## 範圍

IN:

- system-manager session/subsession/dialog 讀取工具。
- DB-backed session/message persistence 對接。
- focused tests 與文件同步。

OUT:

- daemon/gateway lifecycle 操作。
- provider/account fallback 或 rotation 行為。
- 新增任何 silent fallback。

## 任務清單

- 1.1 Create plan/event artifacts and XDG whitelist backup
- 1.2 Map DB session/message APIs and current system-manager readers
- 2.1 Refactor system-manager session/dialog readers to DB SSOT
- 2.2 Update or add focused tests for DB-backed dialog reads
- 3.1 Run focused validation
- 3.2 Update event log and architecture sync notes

## Debug checkpoints

### Baseline

- Symptom/request: system-manager tools need to read DB session dialog after DB migration.
- Initial risk: stale filesystem/session transcript readers may miss DB-only dialog records.

### Instrumentation Plan

- Inspect current system-manager session tool implementation and tests.
- Inspect DB session/message repository APIs and server routes that already read DB-backed dialogs.
- Verify output contract compatibility before changing code.

### Execution

- Read `packages/mcp/system-manager/src/index.ts`, `system-manager-http.ts`, existing focused tests, `packages/opencode/src/server/routes/session.ts`, and DB-backed session storage (`session/message-v2.ts`, `session/storage/router.ts`, `session/storage/sqlite.ts`).
- Replaced system-manager session metadata/dialog reads with daemon `/api/v2/session`, `/api/v2/session/:id`, and `/api/v2/session/:id/message` calls. These server routes already resolve through `Session.listGlobal`, `Session.get`, and `Session.messages`, which in turn use the DB-aware `StorageRouter`/`SqliteStore` path.
- Updated `switch_session`, session execution switch helpers, `manage_session search/create/undo/redo`, `list_subagents`, `read_subsession`, and `export_transcript` so dialog/session reads no longer inspect `storage/session/<sid>/info.json` or message directories directly.
- Added reusable/testable HTTP helpers in `packages/mcp/system-manager/src/system-manager-http.ts` for session info/list/messages/revert/unrevert routes.

### Root Cause

- system-manager still had direct filesystem readers from the pre-DB session layout for session metadata, search/list introspection, undo/redo mutation, and transcript/subsession dialog reads. After the DB migration, those paths can miss or corrupt DB-only dialog state. The fix routes those tools through the server session API, preserving the DB-aware router and no-silent-fallback contract already enforced by runtime session storage.

### Validation

- PASS: `bun test "packages/mcp/system-manager/src/system-manager-http.test.ts" "packages/mcp/system-manager/src/system-manager-session.test.ts"` — 13 pass, 0 fail.
- PASS: `bun --check "packages/mcp/system-manager/src/index.ts" && bun --check "packages/mcp/system-manager/src/system-manager-http.ts"`.
- PASS: `bun eslint "packages/mcp/system-manager/src/index.ts" "packages/mcp/system-manager/src/system-manager-http.ts" "packages/mcp/system-manager/src/system-manager-http.test.ts"`.
- WARN: repo-wide `bun run verify:typecheck` could not run because this checkout has no `turbo` executable available (`error: Script not found "turbo"`).
- WARN: repo-wide `bun tsc --noEmit --pretty false` is blocked by pre-existing syntax errors in `templates/skills/plan-builder/scripts/plan-rollback-refactor.ts`; not caused by this change.
- Architecture Sync: Updated `specs/architecture.md` Tool Surface Runtime notes to record the system-manager session/dialog DB-backed API boundary.

## XDG backup

- Created whitelist snapshot: `/home/pkcs12/.config/opencode.bak-20260501-1203-system-manager-db-dialog/`.
- This is a pre-plan snapshot for manual restore only; no restore was performed.
