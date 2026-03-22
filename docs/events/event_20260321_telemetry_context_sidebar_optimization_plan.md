# Event: Telemetry context sidebar optimization plan

**Date**: 2026-03-21
**Scope**: `packages/app` telemetry branch context sidebar / context tab / related tool-page status surfaces
**Status**: Planning

## 需求

- 使用者要求在 `/home/pkcs12/projects/opencode` 的 `telemetry` branch 中，對 context sidebar 的顯示畫面進行優化。
- 使用者補充：目前 context sidebar 明顯分成新舊兩區；新 Telemetry 已是卡片式，但舊資料仍是鬆散文字。希望把舊資訊整理成 2 到 3 張卡片，讓整體布局一致，並支援像 task status sidebar 一樣可拖曳調整順序。
- 規劃收斂結果：先採 3 卡 MVP，分組為 `摘要 / Breakdown / Prompt`。

## 範圍

### IN

- `packages/app` context sidebar / context tab / tool-page telemetry display
- 與上述畫面直接相關的 telemetry hydration / helper / shared rendering duplication
- context sidebar card grouping 與拖曳排序
- plan artifact、驗證策略、stop gates

### OUT

- backend telemetry capture / route contract 重設計
- TUI sidebar 變更
- 與 context sidebar 無直接關聯的 launcher/file-tree 重做

## 任務清單

- 讀 architecture 與既有 telemetry/sidebar event，建立當前邊界
- 探索 context sidebar 相關檔案與 telemetry data flow
- 定義 legacy context info 的 3 卡分組（`摘要 / Breakdown / Prompt`）
- 規劃 context sidebar 的拖曳排序契約
- 更新 `specs/telemetry/context-sidebar-optimization/*`

## Debug Checkpoints

### Baseline

- `session-side-panel.tsx` 與 `tool-page.tsx` 幾乎重複了 monitor + telemetry hydration wiring。
- `session-context-tab.tsx` 使用同一份 `SessionTelemetry`，但沒有直接共用 `SessionTelemetryCards`，形成第二套 telemetry 呈現契約。
- 目前 app 仍有 projector-first + fallback-derived 混合欄位，尤其在 round/session telemetry 身份資訊上有過渡態痕跡。

### Instrumentation Plan

- 先以文件與 targeted source inspection 確認現有 authority boundary，不從 symptom 直接猜 UI 改法。
- 聚焦 `packages/app` 顯示層與 helper，避免提早擴張到 backend contract。
- 用 plan mode 先收斂產品方向，再交 build agent 實作。

### Execution

- 已讀 `specs/architecture.md` 與 telemetry/sidebar 相關 event。
- 已探索 `session-side-panel.tsx`、`tool-page.tsx`、`session-context-tab.tsx`、`session-telemetry-ui.ts`、`session-telemetry-cards.tsx`、`monitor-helper.ts` 與相關測試。
- 已確認當前主要缺口是 display contract 分裂與 wiring duplication，而不是立即可證明的 backend transport 缺失。
- 已補讀 `~/.config/opencode/prompts/session/plan.txt`，並依 driver 補載 `miatdiagram`。
- 已將 `idef0.json`、`grafcet.json`、`c4.json`、`sequence.json` 從模板內容改為與本次 context sidebar optimization slice 對齊的實際 artifact。

### Root Cause

- context sidebar telemetry 顯示曾隨 telemetry implementation 與 sidebar simplification 逐步堆疊，導致相鄰 surface 共享同一份資料卻未共享同一套 rendering/view-model contract。
- 使用者進一步確認，最核心的 UX 問題是「舊區塊不是卡片、且不能排序」，因此優化需求本質上是 card-based layout consistency + reordering，而非 backend telemetry 問題。

## Key Decisions

- 當前計畫先維持 `session_telemetry` 為 app-side canonical slice，不主動擴張到 backend redesign。
- 已收斂主軸：legacy context info 需被重組為卡片，並支援拖曳排序。
- 已選定初版分組：`摘要 / Breakdown / Prompt` 三卡。

## Validation

- Architecture / event review completed
- Targeted source inspection completed
- Plan driver compliance: `planner` + `miatdiagram` loaded, required artifacts present, template diagram placeholders removed
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅建立 planning evidence 與 plan artifacts，尚未改動 runtime/module boundary。

## Remaining

- 待使用者核准進入 build mode
