# Tasks — Scheduled Tasks UI (R2: Project-Session Reuse)

> Updated 2026-03-26 (session 2): Phases 1-7 coded, virtual project isolation + session conversation rendering added.

## Phase 1: 後端修復（Trigger → Session 管線）

- [x] 1.1 修復 `heartbeat.ts` — `executeJobRun()` 呼叫 `CronSession.resolve()` 建立 isolated session
  - 改用 SessionPrompt.prompt() 同步執行（RunQueue 需 messageID，不適用）
- [x] 1.2 修復 `heartbeat.ts` — 改用 SessionPrompt.prompt() 直接執行 AI turn
  - 原 RunQueue 方案不可行，改為同步 prompt() 呼叫
- [x] 1.3 修復 `heartbeat.ts` — 捕獲 sessionId 並回填至 logEntry
- [x] 1.4 建立 `virtual-project.ts` — `TASKS_VIRTUAL_DIR` 常數定義
- [x] 1.5 `heartbeat.ts` — `evaluateJob()` 內 `executeJobRun` 包裹 `Instance.provide({ directory: TASKS_VIRTUAL_DIR })`
- [x] 1.6 `heartbeat.ts` — `register()` 內 `fs.mkdir(TASKS_VIRTUAL_DIR)` 確保目錄存在
- [x] 1.7 `cron.ts` routes — `POST /jobs/:id/run` 手動觸發包裹 `Instance.provide()`
- [x] 1.8 `cron.ts` routes — 新增 `GET /project` 端點回傳虛擬目錄路徑
- [~] 1.9 驗證 `POST /jobs/:id/run` 端點實際建立 session 並執行 AI — 需 runtime 測試
- [~] 1.10 驗證 run log entry 包含 sessionId — 需 runtime 測試

## Phase 2: 路由 + 虛擬 Project 入口

- [x] 2.1 在 `app.tsx` 新增路由 `/system/tasks/:jobId?`（在 `/:dir` 之前）
- [x] 2.2 確保 `/system/*` 路由在 `/:dir` pattern 之前匹配
- [x] 2.3 在 `sidebar-shell.tsx` 新增 ScheduledTasksTile（置頂於 project rail，含 active 狀態高亮）
- [x] 2.4 點擊虛擬 tile navigate 到 `/system/tasks`

## Phase 3: Task Session List（Sidebar）

- [x] 3.1 建立 `task-sidebar.tsx` — cron job 列表，含狀態圓點 + name + 下次執行時間
- [x] 3.2 列表項顯示：job name + 狀態圓點 + 下次執行時間
- [x] 3.3 選中某 job 時 navigate 到 `/system/tasks/:jobId`
- [x] 3.4 列表頂部 "New Task" 按鈕（觸發 TaskEditDialog）
- [~] 3.5 右鍵 / 長按 context menu — 延後，目前用 tool panel 操作

## Phase 4: Task Detail Page（三區 Layout）

- [x] 4.1 建立 `task-detail.tsx` — 主內容區骨架（prompt + cron + log + tool panel）
- [x] 4.2 **Prompt 區**：可編輯 textarea，blur 時 auto-save（PATCH payload）
- [x] 4.3 **Cron 設定區**：CronScheduleDisplay + presets dropdown
- [x] 4.4 **執行紀錄 log 區**：RunHistoryPanel 複用
- [x] 4.5 **Header**：Task name + status badge + schedule badge

## Phase 5: Tool Panel（右側）

- [x] 5.1 建立 `task-tool-panel.tsx`
- [x] 5.2 **Test**：triggerJob 觸發
- [x] 5.3 **Edit**：觸發 TaskEditDialog
- [x] 5.4 **Refresh**：重新載入 run history
- [~] 5.5 **Config**：model/timeout 參數 — 顯示於 footer metadata，編輯走 Edit dialog
- [x] 5.6 **Start/Stop**：toggle job.enabled
- [x] 5.7 **Delete**：刪除 job

## Phase 6: 整合 + 清理

- [x] 6.1 index.tsx 改為 split layout（TaskSidebar + TaskDetail）
- [x] 6.2 移除舊 `/:dir/tasks` 路由，統一為 `/system/tasks`
- [~] 6.3 GlobalSync / dedicated store — 目前用 component-level createSignal + effect 管理，待需求再升級

## Phase 6b: Session 對話渲染

- [x] 6b.1 `api.ts` — 新增 `SessionMessage`, `SessionMessageWithParts` 類型 + `getSessionMessages()`, `getSessionMessage()` 方法
- [x] 6b.2 `run-history.tsx` — 展開 run 時若有 sessionId，fetch messages+parts 並渲染 user prompt + AI response
- [x] 6b.3 `task-card.tsx` — 更新 local CronApi type 包含 session message methods

## Phase 7: Validation

- [x] 7.1 TypeScript build 驗證 — 後端 0 新增 error（7 pre-existing）
- [~] 7.2 後端驗證：需 runtime 測試確認完整 cron→session→AI pipeline
- [~] 7.3-7.6 前端驗證：需 runtime 測試確認完整 UI flow
- [x] 7.7 Event log + Architecture sync
