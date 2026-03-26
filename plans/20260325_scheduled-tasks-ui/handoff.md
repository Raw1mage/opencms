# Handoff — Scheduled Tasks UI (R2: Project-Session Reuse)

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding
- 遵循 thin client 原則：前端不直接操作 cron store，一律走 REST API
- Task detail 三區式佈局（prompt + cron + log）是核心 UI 契約，不可簡化為單一欄位
- 前端已有大量可複用元件（see implementation-spec.md "Existing Infrastructure"），禁止重複實作

## Required Reads

- implementation-spec.md（含 existing infrastructure 盤點）
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State（盤點 2026-03-26）

### 後端

- ✅ Cron 後端完整（store, types, heartbeat, delivery, run-log, session, light-context）
- ✅ REST API 7 端點已掛載（`/api/v2/cron/`）
- ✅ CronSession.resolve() 已實作（但未被呼叫）
- ❌ **executeJobRun() 管線斷裂**：trigger built but not enqueued，無 session 綁定，無 sessionId 回填

### 前端

- ✅ task-list 頁面已有初版（6 個檔案：index, task-card, task-create-dialog, api, cron-utils, run-history）
- ✅ CRUD + toggle + trigger + run history 全部已有
- ✅ Sidebar 已有 Tasks 入口（utility bar checklist icon）
- ❌ 路由走 `/:dir/tasks`（需改為 `/system/tasks`）
- ❌ 無虛擬 Project tile（需置頂於 sidebar project rail）
- ❌ 無 task-detail / task-sidebar / task-tool-panel

## Stop Gates — Resolution Status

| Gate | Status | Resolution |
|------|--------|------------|
| CronStore API 簽名 | ✅ Cleared | API 簽名與 types.ts 完全吻合 |
| MCP tool availability | ✅ Cleared | MCP tools 在 session 執行時由 resolveTools() 動態載入，不依賴 light-context。修復 enqueue 後 Gmail/Calendar 可用 |
| LINE Bot channel token | N/A | OUT of scope |

## Build Entry Recommendation

1. **Phase 1 先行**：修復 `heartbeat.ts` executeJobRun()（3 個斷點）
2. 驗證 `POST /jobs/:id/run` 實際建立 session + AI 執行
3. 確認 run-log 含 sessionId 且可讀取 session messages
4. Phase 1 通過後再進入前端改造

### 關鍵檔案閱讀順序

1. `packages/opencode/src/cron/heartbeat.ts` — 重點：executeJobRun() :334-373, logEntry :291-300
2. `packages/opencode/src/cron/session.ts` — CronSession.resolve() 的 API
3. `packages/opencode/src/session/queue.ts` — RunQueue.enqueue() 的 API
4. `packages/opencode/src/session/trigger.ts` — buildCronTrigger() 已有，確認 trigger 結構
5. `packages/app/src/pages/task-list/` — 所有現有前端元件（複用基礎）
6. `packages/app/src/pages/layout/sidebar-shell.tsx` — sidebar 入口 pattern
7. `packages/app/src/pages/layout/sidebar-items.tsx` — SessionItem 視覺風格

## Execution-Ready Checklist

- [x] Implementation spec is complete (updated 2026-03-26)
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
- [x] MCP tool availability confirmed — resolveTools() path verified
- [x] CronStore API signature verified
- [x] Existing frontend components inventoried
