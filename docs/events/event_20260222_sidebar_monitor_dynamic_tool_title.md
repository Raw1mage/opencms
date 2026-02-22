# Event: Sidebar Monitor Dynamic Tool Title

Date: 2026-02-22
Status: Done

## Goal

讓 Sidebar 的 Monitor 在顯示 sub-session / sub-agent 動態時，優先顯示「當前工具執行標題」，避免只重複 session 標題。

## Decision

- 在 `SessionMonitor.scanSession()` 中，將 running tool 的 `part.state.title` 作為 monitor row 的優先 title 來源。
- 影響層級：
  - `tool` row：優先顯示 tool running title。
  - `agent/sub-agent` row：若有 active tool title，優先顯示該 title。
  - `session/sub-session` row：若可得 active tool title，優先顯示該 title。
- 無 tool title 時維持 fallback：`session.title`。

## Files

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/monitor.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/index.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- `/home/pkcs12/projects/opencode/packages/sdk/js/src/v2/gen/types.gen.ts`

## Notes

- 不變更 API schema，沿用既有 `SessionMonitorInfo.title` 欄位，僅調整其來源策略。
- Sidebar Monitor 文案降噪：
  - 移除每列前方狀態小圓點 `•`（避免與文字狀態重複）。
  - `Tool: ...` 不再顯示括號狀態（如 `(running)`）。
  - 僅在 tool 狀態與主狀態不一致時，才以文字補充狀態（例如 `Pending`）。
- Sidebar Monitor fallback 指標持久化：
  - 當 monitor 無 active row、改用 fallback row 時，不再把 `requests/tokens` 顯示為 0。
  - 改為優先讀取 `session.stats`（持久化欄位），避免受前端 message 同步上限影響。
- Session 長存統計：
  - 在 `session/<sessionID>/info.json` 擴充 `stats` 欄位，包含 `requestsTotal / totalTokens / tokens / lastUpdated`。
  - 由 `Session.updateMessage/removeMessage` 以「差值」方式增減統計，避免重覆累加。
