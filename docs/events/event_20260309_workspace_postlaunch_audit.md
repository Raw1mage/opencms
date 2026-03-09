# Event: Workspace post-launch audit

Date: 2026-03-09
Status: In Progress

## 需求

- 在 `cms` 新版 workspace 系統剛上線、尚未有具體 bug report 前，主動巡檢程式碼與文件。
- 分析潛在問題、未完工作與可發展機會。
- 產出可討論的優先級計畫，而不是直接動手實作。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/**`
- `/home/pkcs12/projects/opencode/packages/opencode/**`
- `/home/pkcs12/projects/opencode/docs/specs/workspace-current-state.md`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- 近期 workspace / web runtime 相關 event 與 commit

### OUT

- 不直接修改 runtime/product behavior
- 不做未經討論的 refactor/feature implementation
- 不處理與 workspace post-launch 風險無關的雜項問題

## 任務清單

- [x] 收斂目前 workspace/cms 已知架構現況
- [x] 巡檢高風險 codepath 與 state boundary
- [x] 整理潛在問題、未完工作、機會點
- [x] 形成優先級計畫並與使用者討論
- [x] 落地第一個 consumer-consistency slice

## Debug Checkpoints

### Baseline

- `new-workspace` 已合併進 `cms` 並剛上線。
- 目前重點是主動 post-launch audit，而非被動接 bug。

### Execution

- 先收斂 `docs/specs/workspace-current-state.md`、`workspace-phase-completion-checklist.md`、近期 workspace/webapp 事件，確認目前官方結論是：workspace kernel 已 live，但 preview domain 與 consumer audit / E2E coverage 仍是下一階段工作。
- 針對 app 端巡檢高風險 consumer codepath，確認仍有多處直接依賴 `project.sandboxes` 或 app-local `workspaceOrder`：
  - `packages/app/src/pages/layout.tsx`
  - `packages/app/src/context/layout.tsx`
  - `packages/app/src/pages/layout/sidebar-items.tsx`
  - `packages/app/src/pages/layout/sidebar-project.tsx`
- 針對 runtime 端巡檢 workspace service / operation contract：
  - `packages/opencode/src/project/workspace/service.ts`
  - `packages/opencode/src/project/workspace/operation.ts`
  - `packages/opencode/src/server/routes/workspace.ts`
- 確認 runtime SSOT 已成立，但 app consumer 遷移尚未全數完成；同時發現目前測試重心偏 runtime service/operation，對 app delete/reset 收斂與跨-surface一致性 coverage 仍偏薄。
- 與使用者討論後，先落地最小的 Slice 1：consumer consistency audit/fix，不碰 preview domain。
- 本輪實作聚焦在把高頻 app surface 從 raw `project.sandboxes` 直接依賴，改成優先透過既有 `workspaceIds(...)` / child workspace project identity 收斂：
  - `packages/app/src/pages/layout.tsx`
    - `workspaceOrder` 合併
    - expanded workspace ownership 判定
    - `navigateToProject(...)` session 搜尋範圍
    - workspace session lazy loading 範圍
  - `packages/app/src/context/layout.tsx`
    - `rootFor(...)` 改為優先透過 child workspace 的 `projectId` 回推 canonical root，而不是只看 global project sandboxes map
  - `packages/app/src/pages/layout/sidebar-project.tsx`
    - project selected 判斷改吃 `workspaceIds(...)`
    - project icon notification aggregation 也改傳入實際 workspace directory 集合
  - `packages/app/src/pages/layout/sidebar-items.tsx`
    - `ProjectIcon` 支援外部傳入 canonical directories，避免固定綁死在 `worktree + sandboxes`
  - `packages/app/src/pages/layout/sidebar-project-helpers.ts`
    - `projectSelected(...)` 改成直接判斷 canonical workspace directory 集合
- 第二個 slice 進一步處理 operation convergence：
  - `packages/app/src/context/global-sync.tsx`
    - 對外補上 `globalSync.project.refresh()`，讓 workspace operation 成功後可用正式 global project refresh 收斂 state，而不是只靠 local patch
  - `packages/app/src/pages/layout.tsx`
    - `deleteWorkspace(...)` 成功後不再直接手改 `globalSync.data.project[].sandboxes`
    - 改為 `await globalSync.project.refresh()` 後，再保留 UI-preference 層的 `workspaceOrder` 清理與 route/sidebar 收尾
  - 結果是 workspace delete 流程現在更清楚分層：
    - runtime/project metadata → 由正式 refresh 收斂
    - UI preference (`workspaceOrder`) → 仍由 app local state 管理

### Validation

- `bun run --cwd packages/app typecheck` ✅
- `bun run --cwd packages/app test:unit -- src/pages/layout/sidebar-project-helpers.test.ts` ✅
- `bun run --cwd packages/app test:unit` ✅
- 期間另行修復 subagent `worker_busy` 阻斷，已獨立記錄於 `event_20260309_subagent_worker_busy_block.md`。
- Architecture Sync: Verified (No doc changes)
  - 本輪屬於既有 app consumer consistency 收斂，未改變 workspace architecture boundary 或 runtime API contract。
