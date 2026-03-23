# Proposal

## Why
- 長對話串（100+ 條消息、大量 tool output）的 session 在 TUI 中加載極慢，阻塞用戶操作
- 當前實作同步拉取全部消息再一口氣渲染，無分頁、無漸進加載
- Auto-compact 僅減少 AI context 載入量，TUI 仍然全量加載所有歷史消息
- 用戶在長 session 中切換/重新進入時體驗極差

## Original Requirement Wording (Baseline)
- "長對話串的加載非常耗時，有沒有辦法實作非同步加載機制，也就是最後可見畫面優先顯示，讓人可以工作，然後再以不影響當下顯示捲動位置的方式，分批逐漸把前面的內容慢慢加回來？"
- "盤點一下長對話串的自動compact機制，我想知道目前每隔多少token會做一次compact？compact之後是否能在不影響較早的對話內容的顯示效果的前提下，減少AI加載context的量"

## Requirement Revision History
- 2026-03-17: 初始需求提出

## Effective Requirement Description
1. TUI 進入 session 時優先顯示最新消息，用戶可立即工作
2. 較早的消息在背景分批加載，不影響當前視口位置
3. 利用 compaction 邊界減少 TUI 初始加載量，舊消息可按需展開

## Scope
### IN
- 後端 cursor-based pagination API
- TUI 非同步分批加載機制
- TUI compaction 邊界感知（初始只載到 compaction 點）
- 舊消息按需加載 UI

### OUT
- TUI 渲染引擎級別的虛擬滾動（需 Ink 框架深度改造，列為 future work）
- Compact 觸發策略調整（現有觸發邏輯不在本次範圍）
- 消息的 storage 層重構

## Non-Goals
- 不改變 compact 的觸發時機或 token 門檻
- 不改變消息的持久化結構（Storage key schema）
- 不引入新的外部依賴

## Constraints
- TUI 使用 SolidJS + Ink 渲染，scrollbox 元件已有 `stickyScroll` / `stickyStart="bottom"` 支援
- 後端 `MessageV2.stream()` 已支援反向讀取（最新優先），是分頁的天然基礎
- `filterCompacted()` 已實作 compaction 邊界偵測，但僅用於 AI prompt 組裝

## What Changes
- `Session.messages()` 新增 cursor/offset 參數，支援分頁
- HTTP API `/session/:sessionID/message` 新增分頁 query params
- `sync.tsx` 改為兩階段加載：先拉最近 N 條 → 背景逐批補齊
- TUI session 元件支援 prepend 舊消息而不跳動滾動位置
- TUI 可感知 compaction 邊界，初始只載到 compaction 點，並提供「載入更早消息」的 UI

## Capabilities
### New Capabilities
- **分頁加載**：後端支援 cursor-based pagination，前端分批消費
- **Compaction-aware 初始載入**：TUI 首次只載到最近的 compaction 邊界
- **按需展開歷史**：用戶可手動觸發載入 compaction 邊界之前的消息

### Modified Capabilities
- **消息同步**：從一次性全量拉取改為兩階段（快速 + 背景補齊）
- **滾動行為**：prepend 消息時保持視口穩定

## Impact
- 後端：`session/index.ts`, `session/message-v2.ts`, `server/routes/session.ts`
- 前端：`cli/cmd/tui/context/sync.tsx`, `cli/cmd/tui/routes/session/index.tsx`
- API 消費者：SDK client 需配合新的分頁參數
