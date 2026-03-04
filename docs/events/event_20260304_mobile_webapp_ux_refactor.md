# Event: Mobile WebApp UX Refactor (Model Manager / Prompt Input / Stream Scroll)

Date: 2026-03-04
Status: In Progress

## 1. 需求

- 修復手機版模型管理員視窗超出寬度、無法完整操作問題。
- 修復文字輸入框送出按鈕過小與送出後鍵盤不自動收起問題。
- 修復思考鏈與 tool call 串流期間畫面在最新 tool call 與底部間跳閃問題。
- 修復思考鏈串流中被強制鎖在底部、無法向上捲動檢視歷史內容問題。

## 2. 範圍

### IN

- `packages/app` 手機版 UI 佈局與互動重構（不改後端 API）。
- 模型管理員 mobile 版三欄改為分頁/切換式呈現。
- Prompt input 送出流程的觸控可用性與鍵盤收合行為。
- 串流畫面自動捲動機制統一（避免競爭）。
- 串流中使用者手勢優先（可手動脫離底部鎖定）。

### OUT

- Provider / Account / Model 後端資料模型或 API contract 變更。
- 桌面版大規模視覺重設。
- 與本次 UX 問題無關之歷史功能重寫。

## 3. 任務清單

- [x] 盤點現有模型管理員 UI 與 mobile breakpoint 行為。
- [x] 設計並實作 mobile tabs（provider/account/model）。
- [x] 調整送出按鈕點擊區與可視狀態。
- [x] 送出成功後統一收合軟鍵盤（失敗時保留編輯）。
- [x] 盤點現有 auto-scroll 邏輯來源並收斂為單一策略。
- [x] 修復串流時使用者上滑手勢被底部鎖定覆蓋的問題。
- [ ] 驗證 iPhone Safari / Android Chrome 的操作穩定性。
- [x] 更新本 event 的 Debug Checkpoints 與 Validation。
- [x] 完成 `docs/ARCHITECTURE.md` 同步檢查與紀錄。

## 4. Debug Checkpoints

### Baseline (修改前)

- 症狀：
  - 模型管理員在手機上寬度溢出，三欄同屏無法完整操作。
  - Prompt 送出按鈕觸控區不足，送出後鍵盤未收合。
  - 串流期間畫面在最新 tool call 與底部快速跳閃。
  - 串流期間嘗試上滑時，會被強制拉回底部。
- 重現步驟：
  1. 於手機尺寸（或 devtools mobile viewport）打開模型管理員。
  2. 在輸入框輸入訊息並點擊送出。
  3. 觀察 assistant 思考鏈/tool call 串流期間畫面定位行為。
- 影響範圍：
  - `packages/app` session 頁面與模型管理相關 UI。

### Execution (修正中)

- `dialog-select-model.tsx`
  - 新增 mobile viewport 判斷，手機改為 `provider/account/model` 分頁式切換（單欄顯示）。
  - 手機模式下停用 dialog 拖曳/縮放，避免超寬與錯位；桌面維持既有可拖曳縮放行為。
  - 新增手機上下文提示（當前 provider/account）。
- `prompt-input.tsx`
  - 送出按鈕樣式依實測回饋調整為與同行文字同高（`h-6 w-4.5`），不採 `44x44`。
  - 依實測回饋移除送出/停止按鈕 tooltip（避免浮出「傳送 / 取消」小註解干擾）。
  - `Shift+Enter` 換行邏輯補強：插入換行後同時 `preventDefault + stopPropagation`，避免被 form submit 鏈路攔截為送出。
  - Enter 送出條件收斂為「無任何修飾鍵」才觸發，避免 modifier 組合誤送出。
- `prompt-input/submit.ts`
  - 送出後於手機 web 模式主動 blur editor，以收合軟鍵盤。
- `pages/session/message-timeline.tsx` + `pages/session/index.tsx`
  - 新增 `onAutoScrollUserIntent`，在上滑手勢與空白區 pointer down 時優先 pause auto-scroll。
  - `onAutoScrollHandleScroll` 改接 `autoScroll.handleScroll`，避免把所有 scroll 事件都視為強制 pause/回拉，降低跳閃競爭。

### Validation (修正後)

- 指令：`bun run typecheck`
- 結果：通過（16/16 tasks successful）。
- 備註：輸出包含 `turbo` 的 `opencode#build outputs` 警告，屬既有建置配置提示，非本次 UX 修復阻塞項。
- 手機實機驗證：待進一步於 iPhone Safari / Android Chrome 進行互動驗證。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 `packages/app` 前端互動與響應式行為，未變更系統架構邊界、模組責任或跨層 contract。

#### Validation Update (feedback round)

- 指令：`(cd packages/app && bun run typecheck)`
- 結果：通過。
- 目的：確認移除送出按鈕 tooltip 後無型別回歸。

#### Validation Update (feedback round 2)

- 指令：`(cd packages/app && bun run typecheck)`
- 結果：通過。
- 目的：確認 Shift+Enter 換行與 Enter 送出條件調整後無型別回歸。
