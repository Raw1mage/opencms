# Implementation Spec

## Goal
- 讓 TUI 進入長對話 session 時能在毫秒級顯示最新消息並可立即操作，舊消息在背景非同步補齊且不干擾滾動位置

## Scope
### IN
- 後端 cursor-based pagination API（`Session.messages` + HTTP route）
- TUI 兩階段加載（fast path + background backfill）
- TUI compaction 邊界感知，初始止步於 compaction 點
- 「載入更早消息」互動 UI

### OUT
- Ink 渲染引擎級虛擬滾動
- Compact 觸發邏輯調整
- Storage 層重構
- SDK type generation（由現有 openapi pipeline 自動處理）

## Assumptions
- `MessageV2.stream()` 的反向迭代順序穩定可靠（目前基於 Storage.list 的 key 排序）
- scrollbox 的 `stickyStart="bottom"` 在 prepend 子元素後能正確維持視口（需實驗驗證）
- 一次 compaction 產生的 summary 足夠讓 AI 繼續工作，不需要載入更早的 raw messages 給 AI

## Stop Gates
- 如果 scrollbox prepend 後無法穩定維持視口位置，需暫停 Phase 2 並評估 scrollbox patch 方案
- 如果分頁 API 引入的延遲反而讓短 session（<20 條消息）體驗變差，需加入 threshold 判斷
- 任何改動不得破壞現有 compact / prune 流程

## Critical Files
- `packages/opencode/src/session/index.ts` — Session.messages() 分頁邏輯
- `packages/opencode/src/session/message-v2.ts` — MessageV2.stream() 反向迭代 + filterCompacted()
- `packages/opencode/src/server/routes/session.ts` — HTTP API 分頁參數
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` — 兩階段 sync 邏輯
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — 消息渲染 + compaction UI
- `packages/opencode/src/session/compaction.ts` — 參考：compaction 邊界邏輯（不修改）

## Structured Execution Phases

### Phase 1: Backend Pagination API
- 為 `Session.messages()` 新增 `cursor` 參數（message ID），從該 cursor 往前讀取
- 為 `MessageV2.stream()` 新增可選 `after` 參數，跳到指定 message 之後開始迭代
- HTTP route 新增 `cursor` query parameter
- 新增 `compactionBoundary` 選項：回傳消息時順便標記最近 compaction 邊界的 messageID

### Phase 2: TUI 兩階段加載
- `sync()` 第一階段：拉最近 20 條消息，立即渲染
- `sync()` 第二階段：背景用 cursor 逐批（每批 20 條）補齊到 compaction 邊界或 limit
- 確保 prepend 舊消息時 scrollbox 視口不跳動
- 短 session（≤20 條）走快速路徑，不觸發第二階段

### Phase 3: Compaction-Aware Loading + UI
- TUI 初始加載止步於 compaction 邊界
- 在 compaction 邊界處顯示互動元件：「N 條更早的消息已摘要，點擊載入」
- 用戶點擊後，用 cursor API 繼續向前加載到下一個 compaction 邊界或會話起點

## Validation
- 單元測試：`Session.messages()` 的 cursor 參數正確返回分頁結果
- 單元測試：短 session（≤20 條）行為不退化
- 整合測試：長 session（50+ 條消息含 compaction）的加載流程
- 手動驗證：進入長 session 時最新消息立即可見，可輸入
- 手動驗證：背景加載完成後滾動位置未移動
- 手動驗證：compaction 邊界 UI 可正確觸發載入更早消息

## Handoff
- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
