# Event: Workspace lifecycle contract

Date: 2026-03-08
Status: Done

## 需求

- 把目前散落在 app layout 內的 workspace reset/delete 編排，收斂成 runtime 可表達的 lifecycle contract。
- 先建立最小 server-side contract：state transition、status shape、service seam。
- 本輪不追求一次把所有 UI 流程完全搬遷。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/server/routes/workspace.ts`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/test/project/`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 本輪不完整搬遷 app `layout.tsx` reset/delete UX
- 不做 preview/worker cleanup policy
- 不做 archived artifact persistence

## 任務清單

- [x] 建立 workspace lifecycle helper 與 transition 規則
- [x] 在 WorkspaceService 補 lifecycle API
- [x] 補 server route 入口與 focused tests
- [x] 更新 architecture / event / validation

## Debug Checkpoints

### Baseline

- 目前 workspace kernel 已有 `lifecycleState` 欄位，但還沒有正式 transition contract。
- app reset/delete 仍主要在 `pages/layout.tsx` 自行協調 session archive / sandbox remove。

### Execution

- 已新增 `packages/opencode/src/project/workspace/lifecycle.ts`，定義最小 lifecycle transition helpers：
  - `markWorkspaceResetting`
  - `markWorkspaceDeleting`
  - `markWorkspaceArchived`
  - `markWorkspaceActive`
  - `markWorkspaceFailed`
- `WorkspaceService` 現在提供最小 lifecycle API：
  - `markResetting({ workspaceID })`
  - `markDeleting({ workspaceID })`
  - `markArchived({ workspaceID })`
  - `markActive({ workspaceID })`
  - `markFailed({ workspaceID })`
- `server/routes/workspace.ts` 現在提供第一版 lifecycle endpoints：
  - `POST /workspace/:workspaceID/reset`
  - `POST /workspace/:workspaceID/delete`
  - `POST /workspace/:workspaceID/archive`
  - `POST /workspace/:workspaceID/active`
  - `POST /workspace/:workspaceID/failed`
- 本輪刻意只建立 server-side contract，不直接搬遷 app `layout.tsx` 的完整 reset/delete 編排。

### Validation

- `bun test packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts packages/opencode/test/project/workspace-service.test.ts packages/opencode/test/project/workspace-lifecycle.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Updated
  - 已同步 architecture file map，註記 workspace kernel 現在包含 lifecycle contract，workspace route 也包含 lifecycle transition endpoints。
