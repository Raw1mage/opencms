# Event: Scheduled Task Drawer Default Open

**Date**: 2026-03-27
**Related Event**: `/home/pkcs12/projects/opencode/docs/events/event_20260326_scheduled-tasks-ui.md`

## Requirement

針對 web task manager 做小 patch：當使用者透過 task manager 切換到 scheduled task 顯示頁面時，進入後預設展開顯示 task list sidebar drawer。

## Scope

### IN
- 調查 `/system/tasks` 頁面的 sidebar drawer 控制點
- 以最小 patch 調整進入 scheduled tasks 頁面時的預設 drawer 開啟行為
- 做最小必要驗證並記錄 evidence

### OUT
- 不重構 task manager layout
- 不修改 scheduled task 資料流或 route 結構
- 不新增 fallback 或新的 drawer state model

## Task List

1. 讀取 architecture 與既有 scheduled task event，建立 baseline
2. 找出 scheduled task page 與 sidebar drawer state 的控制面
3. 實作進入 `/system/tasks` 時預設展開 task list sidebar drawer
4. 驗證並同步 event / architecture

## Debug Checkpoints

### Baseline
- 症狀：使用者從 web task manager 切到 scheduled tasks 頁面後，task list sidebar drawer 預設未展開
- 影響範圍：`/system/tasks` page 初始 layout 可見性
- 相關邊界：task manager navigation → layout/mobile sidebar control → scheduled task page composition

### Instrumentation Plan
- 檢查 `packages/app/src/pages/task-list/*` 與全域 layout sidebar/mobileSidebar 控制 API
- 確認 route enter 時是否已有 page-level effect 可掛載最小預設開啟邏輯
- 以 targeted diff / typecheck 或等價驗證確認修補範圍

### Execution
- 讀取 `packages/app/src/pages/task-list/index.tsx`、`task-sidebar.tsx`、`packages/app/src/pages/layout.tsx` 與 `packages/app/src/context/layout.tsx`
- 先前誤判 `/system/tasks` 的 drawer authority 為 `layout.mobileSidebar`；復查後確認桌面 web task route 的 `TaskSidebar` 是由 `packages/app/src/pages/layout.tsx` 中的 `layout.sidebar.opened()` 控制
- 在 `TaskListPage` 掛載時以最小 patch 呼叫 `layout.sidebar.open()` 與 `layout.mobileSidebar.show()`，使進入 `/system/tasks` 時桌面與手機版都會預設展開 task list drawer

### Root Cause
- `/system/tasks` page 進入時缺少 page-entry 開啟訊號，導致 task list drawer 在不同 surface 上維持關閉。
- task route 的 drawer authority 依 surface 分開：桌面 web 使用 `layout.sidebar`，手機版使用 `layout.mobileSidebar`。先前只補桌面 `layout.sidebar.open()` 後，PC 正常但手機版仍不會自動展開；補上 `layout.mobileSidebar.show()` 後，route-entry 行為才與手機版 drawer authority 對齊。

## Changes

- `packages/app/src/pages/task-list/index.tsx`
  - 新增 `useLayout` 與 `onMount`
  - 在 `TaskListPage` 掛載時呼叫 `layout.sidebar.open()` 與 `layout.mobileSidebar.show()`，讓 scheduled task page 進入時同時打開桌面與手機版對應的 task list drawer authority

## Verification

- `git diff -- packages/app/src/pages/task-list/index.tsx`
  - diff 僅顯示 `index.tsx` 新增 `useLayout` / `onMount`，以及 `layout.sidebar.open()` + `layout.mobileSidebar.show()` 的最小變更
- `bun x tsc -p packages/app/tsconfig.json --noEmit`
  - 指令完成且無輸出，未見此 patch 新增 typecheck failure evidence
- Static authority evidence
  - `packages/app/src/pages/layout.tsx` 顯示 task route 的 desktop sidebar 渲染條件為 `layout.sidebar.opened() && isTasksRoute()`
  - `packages/app/src/pages/layout.tsx` 中 `layout.mobileSidebar.opened()` 控制 mobile drawer surface；手機版進頁需顯式 `show()` 才會展開
- Runtime/UI limitation
  - 本回合未執行 live browser 驗證；UI 可見性結論依據既有 layout API 與靜態程式路徑證據

## Architecture Sync

Architecture Sync: Verified (No doc changes)

Basis:
- 此修補僅補上既有 page-entry 對 `layout.sidebar` 與 `layout.mobileSidebar` 控制面的呼叫。
- 無新增模組邊界、資料流、狀態機或 observability surface。

## Remaining

- 若需要更高信心，後續可用瀏覽器實際進入 `/system/tasks` 做一次 smoke test，確認 drawer 初始可見性符合預期。
