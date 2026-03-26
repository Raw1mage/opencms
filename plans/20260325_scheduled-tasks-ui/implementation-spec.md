# Implementation Spec — Scheduled Tasks UI (R2: Project-Session Reuse)

## Goal

- 修復 cron 後端執行管線（trigger → session → AI），並將現有前端 Task List 升級為系統級 Project layout（虛擬 Project → Session List → Task Detail 三區）

## Scope

### IN

- Phase 1: 後端修復（heartbeat → CronSession → RunQueue 接通）
- Phase 2: 前端架構升級（`/system/tasks` 路由 + 虛擬 Project tile + session-like sidebar + 三區 detail）
- Phase 3: 整合驗證

### OUT

- Cron 後端核心重構（store/heartbeat/delivery 結構不動）
- DAG 排程依賴
- LINE Bot delivery（獨立 phase，不在本次）

## Existing Infrastructure（盤點 2026-03-26）

### 後端 — 已完成

| 層級 | 狀態 | 位置 |
|------|------|------|
| REST API（7 端點） | ✅ 已掛載 | `packages/opencode/src/server/routes/cron.ts` |
| CronStore CRUD | ✅ 完整 | `packages/opencode/src/cron/store.ts` |
| RunLog（append, read, trim） | ✅ 完整 | `packages/opencode/src/cron/run-log.ts` |
| CronSession.resolve() | ✅ 已實作 | `packages/opencode/src/cron/session.ts` |
| CronDeliveryRouter | ✅ 完整 | `packages/opencode/src/cron/delivery.ts` |
| Heartbeat tick/evaluate | ✅ 完整 | `packages/opencode/src/cron/heartbeat.ts` |
| Types/Schemas | ✅ 完整 | `packages/opencode/src/cron/types.ts` |

### 後端 — 缺口（Phase 1 修復目標）

| 缺口 | 位置 | 說明 |
|------|------|------|
| executeJobRun() 未呼叫 CronSession.resolve() | `heartbeat.ts:334-373` | trigger 沒有綁定 session |
| trigger 未 enqueue 到 RunQueue | `heartbeat.ts:363-369` | 註解 "in a full system this would be enqueued" |
| sessionId 未回填到 run-log | `heartbeat.ts:291-300` | logEntry 缺少 sessionId |

### 前端 — 已完成

| 元件 | 狀態 | 位置 |
|------|------|------|
| TaskCard（卡片 + toggle + test + delete） | ✅ 可複用 | `packages/app/src/pages/task-list/task-card.tsx` |
| TaskCreateDialog（name/prompt/cron/tz） | ✅ 可複用 | `packages/app/src/pages/task-list/task-create-dialog.tsx` |
| RunHistoryPanel（摺疊式執行紀錄） | ✅ 可複用 | `packages/app/src/pages/task-list/run-history.tsx` |
| createCronApi（7 方法 REST client） | ✅ 可複用 | `packages/app/src/pages/task-list/api.ts` |
| CronScheduleDisplay + cron-utils | ✅ 可複用 | `packages/app/src/pages/task-list/cron-utils.tsx` |
| Sidebar Tasks 入口（utility bar） | ✅ 已存在 | `packages/app/src/pages/layout/sidebar-shell.tsx:100-108` |

### 前端 — 需新增/改造

| 項目 | 說明 |
|------|------|
| `/system/tasks` 路由 | 取代 `/:dir/tasks`，避免 base64 decode |
| 虛擬 Project tile | sidebar project rail 置頂，不是 utility bar icon |
| task-sidebar.tsx | session-list 風格的 cron job 列表 |
| task-detail.tsx | 三區 layout（prompt + cron + log） |
| task-tool-panel.tsx | 右側工具 panel |

## Assumptions

- CronStore API 穩定且可直接使用（已驗證）
- CronRunLog schema 已含 sessionId 欄位（已驗證，但 heartbeat 未填入）
- Heartbeat loop 已在 daemon boot 時自動恢復排程
- REST API 7 端點已完整掛載（已驗證）

## Stop Gates

- ~~CronStore API 簽名不符~~ → ✅ 已驗證吻合
- ~~light-context 是否載入 MCP managed app tools~~ → ✅ 已確認：MCP tools 在 session 執行時由 `resolveTools()` → `MCP.tools()` → `ManagedAppRegistry.readyTools()` 動態載入，不依賴 light-context。修復 enqueue 後即可使用 Gmail/Calendar。
- LINE Bot delivery → OUT of scope（獨立 phase）

## Critical Files

### 需修改

- `packages/opencode/src/cron/heartbeat.ts` — 接通 CronSession → RunQueue 管線
- `packages/app/src/app.tsx` — 路由 `/system/tasks`, `/system/tasks/:jobId`
- `packages/app/src/pages/layout/sidebar-shell.tsx` — 虛擬 project tile（置頂）
- `packages/app/src/pages/layout.tsx` — 導航邏輯調整

### 需新增

- `packages/app/src/pages/task-list/task-detail.tsx` — Task detail 三區 page
- `packages/app/src/pages/task-list/task-sidebar.tsx` — Task session list for sidebar
- `packages/app/src/pages/task-list/task-tool-panel.tsx` — 右側工具 panel

### 可複用（已存在）

- `packages/app/src/pages/task-list/task-card.tsx` — 卡片元件
- `packages/app/src/pages/task-list/task-create-dialog.tsx` — 編輯浮窗
- `packages/app/src/pages/task-list/run-history.tsx` — 執行紀錄
- `packages/app/src/pages/task-list/api.ts` — REST client
- `packages/app/src/pages/task-list/cron-utils.tsx` — Cron 工具函式
- `packages/app/src/pages/layout/sidebar-items.tsx` — SessionItem 視覺風格參考

## Structured Execution Phases

- Phase 1: 後端修復 — heartbeat.ts executeJobRun() 接通 CronSession.resolve() + RunQueue.enqueue() + sessionId 回填
- Phase 2: 路由 + 虛擬 Project 入口 — `/system/tasks` 路由 + sidebar 置頂 tile
- Phase 3: Task Session List — sidebar 中 session-list 風格的 cron job 列表
- Phase 4: Task Detail 三區 Layout — prompt editor + cron config + execution log（複用現有元件）
- Phase 5: Tool Panel — test/edit/refresh/config/delete/toggle
- Phase 6: 整合清理 — 移除舊路由、reactive state 管理
- Phase 7: Validation — build + 端到端 + event log + architecture sync

## Validation

- TypeScript build 無新增 type errors
- 後端驗證：POST /jobs/:id/run → 實際建立 session + AI 執行 + run-log 含 sessionId
- 前端驗證：sidebar 虛擬 project → task list → task detail 完整導航
- 前端驗證：execution log 展開顯示完整 AI 回覆（透過 sessionId → session messages）
- 前端驗證：test 按鈕 → 執行 → log 更新 → AI response 可見
- 前端驗證：edit dialog → 修改 name/prompt/schedule → 儲存

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts (proposal.md, spec.md, design.md) before coding.
- Build agent must materialize runtime todo from tasks.md.
