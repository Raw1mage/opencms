# Event: Workspace API global sync consumption

Date: 2026-03-08
Status: Done

## 需求

- 讓 app/globalSync 開始正式消費 runtime `/workspace` API，而不是只靠本地 directory 推導。
- 先以最小路徑把 `/workspace/current` 與 `/workspace/status` 接進 directory bootstrap。
- 保持 app 端仍可在 API 未命中時退回既有 adapter 邏輯。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/global-sync/{bootstrap,child-store,types}.ts`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/global-sync*.test.ts*`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 本輪不等待 SDK regenerate
- 不做 workspace SSE event reducer
- 不讓 app 直接讀 runtime registry

## 任務清單

- [x] 在 bootstrap 階段加入 workspace API fetch helper
- [x] child store/state 新增 workspace status 欄位
- [x] 驗證 API-first + local fallback 仍可成立
- [x] 更新 event / architecture sync / validation

## Debug Checkpoints

### Baseline

- runtime 已有 `/workspace` API boundary，但 app/globalSync 尚未正式消費。
- 目前 app 主要依賴 `child-store` 的 local identity derivation；這是過渡態，不是 API-backed truth。

### Execution

- `bootstrapDirectory()` 現在會透過低階 `globalSDK.fetch` 呼叫：
  - `/api/v2/workspace/current`
  - `/api/v2/workspace/status`
- 因 SDK 尚未 regenerate，本輪刻意不等待 generated client，而是在 `global-sync/bootstrap.ts` 提供：
  - `fetchWorkspaceCurrent()`
  - `fetchWorkspaceStatus()`
- `child-store` state 現在新增：
  - `workspace`
  - `workspace_status`
- app 端目前採 **API-first + local fallback**：
  - 若 runtime workspace API 可用，bootstrap 直接寫入 server truth
  - 若 runtime workspace API 尚未可用，既有 `child-store` local derivation 仍能維持功能
- `global-sync.tsx` 已在 instance bootstrap 階段把 `globalSDK.fetch` 與 `globalSDK.url` 傳入 bootstrap layer。
- 新增 `bootstrap.test.ts` 驗證 workspace API fetch helper 行為。

### Validation

- `bun test --preload ./happydom.ts ./src/context/global-sync/bootstrap.test.ts ./src/context/file/view-cache.test.ts ./src/context/comments.test.ts ./src/context/prompt.test.ts ./src/context/terminal.test.ts ./src/context/global-sync/child-store.test.ts ./src/context/global-sync/workspace-adapter.test.ts` (in `packages/app`) ✅
- `bun run typecheck` (in `packages/app`) ✅
- `bun test packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts packages/opencode/test/project/workspace-service.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Updated
  - 已同步 architecture file map，註記 app `global-sync/bootstrap.ts` 開始消費 runtime `/workspace` API。
