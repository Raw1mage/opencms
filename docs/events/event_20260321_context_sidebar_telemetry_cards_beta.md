# Event: Context sidebar telemetry cards beta implementation

**Date**: 2026-03-21
**Scope**: `/home/pkcs12/projects/opencode-beta` `packages/app` context sidebar cardization and drag ordering
**Status**: In Progress

## 需求

- 依 `specs/20260321_telemetry-optimization/` plan 實作 beta repo 的 context sidebar 優化。
- 將舊的 context 區塊重組為三張卡片：`Summary / Breakdown / Prompt`。
- 讓 context sidebar 卡片支援比照 task status sidebar 的拖曳排序。

## 範圍

### IN

- `packages/app/src/components/session/session-context-tab.tsx`
- `packages/app/src/context/layout.tsx`
- `packages/app/src/pages/session/session-status-sections.tsx`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/tool-page.tsx`
- 相關 targeted tests / validation

### OUT

- backend telemetry contract 變更
- TUI sidebar 變更
- 與本次 context sidebar 無關的 broader launcher / layout redesign

## 任務清單

- 建立 beta repo 基線與 plan 對齊
- 將 context legacy content 重構為三卡
- 加入 context sidebar 卡片拖曳與持久化順序
- 驗證 typecheck / targeted tests
- 更新 event 與 architecture sync 結果

## Debug Checkpoints

### Baseline

- beta repo 的 `SessionContextTab` 目前仍是線性堆疊：stats grid → breakdown → system prompt → telemetry cards。
- `layout.tsx` 與 `session-status-sections.tsx` 已存在 status sidebar 的順序持久化與拖曳模式，可作為 context cards 的參考基線。
- 既有 `specs/20260321_telemetry-optimization/` 已對齊三卡 MVP，但 beta repo 尚未實作。

### Instrumentation Plan

- 先在不改 backend boundary 的前提下，將 context tab 切成穩定 card sections。
- 優先重用既有 status sidebar drag/persist pattern，避免自造第二套排序模型。
- 實作後以 targeted app validation + typecheck 作為主驗證。

### Execution

- 已確認 beta repo 與 plan root 存在且對應本次需求。
- 已建立本次 beta implementation event 檔作為後續實作留痕。
- 已完成 `SessionContextTab` 卡片化：legacy context info 改為 `Summary / Breakdown / Prompt` 三卡。
- 已將 `Summary` 卡片 stats 改為單行 `Key: Value` 呈現，並保留寬度足夠時的 2-column 緊湊排版。
- 已將 telemetry cards 納入同一 context card 排序流，讓整個 context sidebar 維持統一卡片式布局。
- 已在 `layout.tsx` 新增 `contextSidebar.order` persisted state，並以 status sidebar 的 sortable pattern 作為基線完成拖曳排序。
- 已同步更新 `specs/20260321_telemetry-optimization/tasks.md` 的 1.x / 2.x / 3.x checkbox。

### Root Cause

- 目前 UI 不一致的根因是 context sidebar 新舊區塊的呈現模式分裂：telemetry 已卡片化，但 legacy context info 仍停留在線性文字結構。

## Key Decisions

- 沿用既有 plan root：`specs/20260321_telemetry-optimization/`。
- 初版分組固定為 `Summary / Breakdown / Prompt`。
- 拖曳排序優先沿用 status sidebar 互動模式與 layout persistence。
- telemetry cards 一併納入 context sidebar 排序集合，避免舊 context 卡與新 telemetry 卡出現兩套不同排序規則。

## Validation

- `bun --filter @opencode-ai/app typecheck` ✅
- `bun --filter @opencode-ai/app test:e2e --grep "context panel can be opened from the prompt"` ❌
  - 失敗原因：`ECONNREFUSED 127.0.0.1:4096`，測試初始化時無法連到本地 backend，屬環境/infra failure，非已證實 UI regression。
- Targeted implementation evidence:
  - `packages/app/src/components/session/session-context-tab.tsx` 已導入 `solid-dnd`、context card sections、`layout.contextSidebar.setOrder(...)`
  - `packages/app/src/context/layout.tsx` 已新增 `contextSidebar.order`
  - `packages/app/e2e/prompt/context.spec.ts` 已補三張卡片標題可見性驗證
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅在既有 app sidebar/layout persistence 邊界內新增 context card order state 與 UI 組合，未改變長期架構模組邊界或資料流 authority。

## Requirement Review

- Requirement 1 — 舊 context 區塊改成三卡：**Fulfilled**
- Requirement 2 — 卡片可拖曳排序：**Implemented, but runtime interaction not fully e2e-verified in this session due backend unavailability**
- Requirement 3 — 維持既有 app data boundary、不引入 fallback：**Fulfilled**

## Remaining

- 可選 follow-up：在 backend/dev server 可用時，補跑 context sidebar e2e，尤其是 drag-order / persistence 互動驗證
