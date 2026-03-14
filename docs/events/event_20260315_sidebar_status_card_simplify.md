# Event: Sidebar status card simplification and persistence

Date: 2026-03-15
Status: Completed

## 需求

- 移除 sidebar 中過於複雜且不直觀的 `Smart Runner history`
- 移除 `Latest narration` / `Latest result` / `Debug` 卡片
- 將 autonomous 與 task monitor 重構合併為單一「工作監控」卡
- 移除 sidebar 中的 `外掛程式 (plugins)` 與 `LSP` 卡
- 讓 sidebar 卡片支援拖曳排序
- 將卡片順序與展開/收折狀態以**全域**方式持久化記憶

## 範圍

### IN

- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/session-status-sections.tsx`
- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/context/layout.tsx`
- 相關前端測試與驗證

### OUT

- 不改 backend runtime contract
- 不改 session autonomous queue/health API shape
- 不改 TUI status sidebar

## 任務清單

- [x] 簡化 status sidebar 卡片資訊架構
- [x] 合併 autonomous / task monitor 為單一卡片
- [x] 移除 Smart Runner history / Latest narration / Latest result / Debug / LSP / plugins
- [x] 加入卡片拖曳排序
- [x] 加入全域展開狀態與順序持久化
- [x] 驗證並完成 architecture sync 記錄

## 實作摘要

- `packages/app/src/context/layout.tsx`
  - 新增全域 `statusSidebar.order` 與 `statusSidebar.expanded` persisted state。
  - 提供 `setOrder` / `expanded` / `setExpanded` / `toggleExpanded` 供 session status surfaces 共用。
- `packages/app/src/pages/session/session-status-sections.tsx`
  - sidebar/status sections 精簡為 `工作監控`、`Todo`、`Servers`、`MCP` 四卡。
  - 移除舊的 `summary`、`LSP`、`plugins` sections。
  - 加入 `@thisbeyond/solid-dnd` sortable card reorder，並寫回全域 layout store。
  - expand/collapse 狀態改為使用全域 layout store，不再使用區域 state。
- `packages/app/src/pages/session/session-side-panel.tsx`
  - 將原 autonomous summary / queue control / process status 與 monitor list 合併進單一 `工作監控` 卡。
  - 停止渲染獨立 summary card。
- `packages/app/src/pages/session/tool-page.tsx`
  - 對齊桌面側欄的 `工作監控` 呈現，改用相同的 status summary + monitor content 組合。
  - Todo 卡可高亮 current todo。
- `packages/app/src/pages/session/helpers.ts`
  - 將 `SessionStatusSummary` contract 收斂為 `currentStep` / `methodChips` / `processLines`。
  - 移除已不再供 sidebar 使用的舊 Smart Runner summary/debug/history helper 邏輯。
- `packages/app/src/pages/session.tsx`
  - 修正 `sync.data.message[id]` 直接索引導致的 `TS2538` 型別錯誤。

## Debug / Checkpoints

### Baseline

- sidebar 仍保留 Smart Runner 歷史/敘事/結果等多張卡片，資訊密度過高且不符合最新 UX 目標。
- card 展開狀態與順序未做全域持久化。
- tool-page status view 與桌面側欄資訊結構已開始漂移。
- app typecheck 因 session page message index 與 status helper 測試遷移中斷而失敗。

### Instrumentation Plan

- 先讀 architecture 與既有 web sidebar events，確認這次是否只屬 UI aggregation/persistence，不動 backend contract。
- 以 `layout.tsx` 作為全域 persisted UI state SSOT。
- 以 targeted app typecheck / helper tests 當作收斂驗證，不做無關 full-repo 掃描。

### Execution

- 將狀態卡片收斂到單一 `工作監控` 主卡，保留 objective / method chips / process lines / queue controls / monitor rows。
- 將排序與展開狀態寫入 global layout persisted store。
- 對齊 tool-page 與 desktop sidebar 的 monitor rendering contract。
- 清除 helpers.ts 殘留的 Smart Runner sidebar summary dead code。
- 修正 session page 的訊息索引型別問題。
- 調整 DOM-only helper tests 為條件執行，避免在無 DOM test runtime 下誤失敗。

### Root Cause

- 主要問題不是 backend/state 不一致，而是前端 sidebar 經多輪 autonomous observability 疊加後，資訊架構未再收斂，造成 card 邊界與 summary contract 過度複雜。
- 同時，status summary helper 已局部重構，但舊 Smart Runner-oriented helper 邏輯仍殘留，讓測試與型別面維持不穩定。

## Validation

- `bun --filter @opencode-ai/app typecheck` ✅
- `bun test "/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts" "/home/pkcs12/projects/opencode/packages/app/src/pages/session/monitor-helper.test.ts"` ✅
  - 結果：11 pass / 2 skip / 0 fail
  - skip 原因：`focusTerminalById` 測試需要 DOM，當前 bun 測試 runtime 無 document。

## Architecture Sync

- Verified (No doc changes)
- 依據：本次變更限於 web session sidebar 的 UI aggregation、排序/展開全域持久化與測試收斂，未改變模組邊界、後端資料流、runtime state machine 或 API contract。
