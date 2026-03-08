# Event: Workspace app cleanup and phase review

Date: 2026-03-09
Status: Done

## 需求

- 清理 workspace rewrite 後 app 端剩餘的低價值重複狀態 / dead helper。
- 產出目前 `new-workspace` phase completion checklist。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/app/src/pages/layout.tsx`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/global-sync/`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode-beta/docs/specs/`

### OUT

- 不新增 preview runtime
- 不重寫 workspace order / rename UX
- 不改 runtime workspace API / operation contract

## 任務清單

- [x] 清理 dead lifecycle helper
- [x] 移除未消費的 `workspace_status` app state
- [x] 驗證 app 測試 / typecheck
- [x] 產出 phase completion checklist

## Debug Checkpoints

### Baseline

- layout 中 `transitionWorkspaceLifecycle()` 已無 call site。
- `workspace_status` 只在 bootstrap 寫入，app 端目前沒有 consumer。

### Execution

- 刪除 `pages/layout.tsx` 中已無 call site 的 `transitionWorkspaceLifecycle()` helper。
- 從 app child store state 移除未被 consumer 使用的 `workspace_status`：
  - `global-sync/types.ts`
  - `global-sync/child-store.ts`
  - `global-sync/bootstrap.ts`
  - `global-sync/event-reducer.test.ts`
- 進一步移除 app-side 已無 consumer 的 `fetchWorkspaceStatus()` helper 與對應單元測試，避免殘留假性 API 依賴。
- 新增 `docs/specs/workspace-phase-completion-checklist.md`，整理 Phase 1–3 與 preview deferred track 的完成度。

### Validation

- `bun run --cwd packages/app test:unit -- src/context/global-sync/event-reducer.test.ts src/context/global-sync/bootstrap.test.ts src/context/global-sync/child-store.test.ts` ✅
- `bun run --cwd packages/app typecheck` ✅
- Architecture Sync: Updated
  - `docs/ARCHITECTURE.md` 已移除 bootstrap/child-store 對 `workspace_status` 的敘述，改為以 runtime workspace aggregate 為主。
