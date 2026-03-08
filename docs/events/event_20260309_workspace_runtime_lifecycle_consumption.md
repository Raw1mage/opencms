# Event: Workspace runtime lifecycle consumption

Date: 2026-03-09
Status: Done

## 需求

- 讓 app `global-sync` 保留完整 runtime workspace aggregate，而不是只存裁切版 snapshot。
- 讓 layout busy gating 開始消費 runtime lifecycle state，降低純 app-local busy flag 依賴。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/global-sync/`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/pages/layout.tsx`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不改 workspace API shape
- 不改 preview runtime modeling
- 不全面重寫 layout reset/delete orchestration

## 任務清單

- [x] 擴充 app workspace state shape
- [x] bootstrap/transition 改為保留 runtime aggregate
- [x] layout busy 判斷開始讀 lifecycle state
- [x] 補測試與 architecture 記錄

## Debug Checkpoints

### Baseline

- `/workspace/current` 已回傳 `WorkspaceAggregateSchema`，但 app 目前只保存 `workspaceId/directory/kind`。
- layout busy gating 主要靠本地 `busyWorkspaces`，尚未真正消費 runtime lifecycle state。

### Execution

- `global-sync/bootstrap.ts` 的 `WorkspaceSnapshot` 改為保留 runtime workspace aggregate 所需欄位：
  - `projectId`
  - `origin`
  - `lifecycleState`
  - `displayName` / `branch`
  - `attachments.*`
- `global-sync/types.ts` 與 `child-store.ts` 的 app fallback workspace shape 已同步擴充，讓 app local fallback 至少保有相同欄位骨架。
- `pages/layout.tsx` 的 `transitionWorkspaceLifecycle()` 現在會把 runtime endpoint 回傳的 workspace aggregate 寫回 child store。
- `pages/layout.tsx` 的 `isBusy()` 開始優先讀 runtime `workspace.lifecycleState`（`resetting` / `deleting`），本地 `busyWorkspaces` 改為保留作為 optimistic fallback。

### Validation

- `bun run --cwd packages/app test:unit -- src/context/global-sync/bootstrap.test.ts src/context/global-sync/child-store.test.ts` ✅
- `bun run --cwd packages/app typecheck` ✅
- Architecture Sync: Updated
  - 已補入 app bootstrap 現在保留完整 runtime workspace aggregate，layout busy gating 開始消費 runtime lifecycle state。
