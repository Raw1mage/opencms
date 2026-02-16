# OpenCode Technical Debt Registry

Last Updated: 2026-02-12
Status: Active

這份文件記錄了 OpenCode 專案中已識別的技術債，用於追蹤與安排後續重構工作。

## 🎯 High Priority (P0)

### 1. God Object Refactoring: `session/prompt.ts`
- **現狀**: `packages/opencode/src/session/prompt.ts` 高達 2,376 行。
- **職責**: 混合了 Prompt Loop, Tool Resolution, Message Construction, Image Routing, Shell Execution 等多重職責。
- **影響**: 
  - 難以維護與閱讀。
  - 合併衝突熱點。
  - 難以撰寫單元測試。
- **建議行動**:
  - 拆分 `ToolResolver` (負責工具查找與驗證)。
  - 拆分 `ShellExecutor` (負責 Shell 指令執行與輸出處理)。
  - 拆分 `ImageRouter` (負責圖片處理邏輯)。
  - 保留 `prompt.ts` 僅作為協調層 (Orchestrator)。

### 2. Core Module Testing
- **現狀**: Opencode 核心套件測試覆蓋率僅 ~7.2%。
- **缺口**:
  - `packages/opencode/src/session/processor.ts`: 核心訊息處理邏輯。
  - `packages/opencode/src/provider/provider.ts`: 模型供應商介面適配。
  - `packages/opencode/src/session/index.ts`: Session 狀態管理。
- **建議行動**:
  - 為上述模組建立基礎 Unit Test Suite。
  - 優先覆蓋 Happy Path 與已知 Error Cases。

## ⚠️ Medium Priority (P1)

### 1. Antigravity Plugin Refactoring (Phase 2)
- **現狀**: 雖然已引入 `types.ts` 並消除了大部分 `any`，但 `filterUnsignedThinkingBlocks` 等處理 raw response 的函式仍保留部分 loose typing。
- **建議行動**:
  - 進一步定義 `GeminiRawResponse` 等介面。
  - 強化 Error Handling 與 Recovery 機制的型別安全。

## 📝 Low Priority (P2)

### 1. Legacy TODO Cleanup
- **現狀**: 程式碼中散落多處 `TODO` 與 `FIXME`。
- **範例**:
  - `session/processor.ts`: `TODO: Handle context overflow error`
  - `config/config.ts`: `TODO: get rid of this case` (Bun bug workaround)
  - `console/workspace.tsx`: `TODO: Frank, replace with real workspaces`
- **建議行動**:
  - 盤點所有 TODO。
  - 將有效的 TODO 轉換為 GitHub Issues 或此文件的項目。
  - 移除過時或無效的 TODO。

## ✅ Completed Items

- [x] **Antigravity Any Cleanup** (2026-02-12): 消除 `packages/opencode/src/plugin/antigravity` 中的 170+ `any` 使用，引入強型別系統。詳見 `docs/events/event_20260212_antigravity_types.md`。
- [x] **Global @ts-ignore Cleanup** (2026-02-12): 處理全專案 `packages/` 下的 `@ts-ignore`，改用 `@ts-expect-error` 並附帶原因。詳見 `docs/events/event_20260212_ts_ignore_cleanup.md`。
