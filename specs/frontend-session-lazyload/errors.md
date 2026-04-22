# Errors: frontend-session-lazyload

## Error Catalogue

所有錯誤都必須明確 log / 提示使用者，不得靜默退回舊行為（AGENTS.md 第一條）。

### Error Codes (index)

- LAZYLOAD_META_HTTP_ERROR — meta endpoint HTTP / network failure
- LAZYLOAD_META_PARSE_ERROR — meta response shape invalid
- LAZYLOAD_META_CACHE_MISS — server-side meta computation failed
- LAZYLOAD_TWEAKS_MISSING_KEY — tweaks.cfg key absent (use default)
- LAZYLOAD_TWEAKS_INVALID_VALUE — tweaks.cfg value out of range (use default)
- LAZYLOAD_REBUILD_MISMATCH — R4 heuristic prefix-match failed
- LAZYLOAD_TAIL_WINDOW_TRIGGERED — streaming part exceeded tail_window_kb
- LAZYLOAD_LOADMORE_ERROR — scroll-spy or manual loadMore failed
- LAZYLOAD_SCROLL_SPY_CONFLICT — sentinel fired in follow-bottom mode
- LAZYLOAD_FLAG_UNAVAILABLE — cannot read frontend_session_lazyload flag
- LAZYLOAD_EXPAND_FETCH_ERROR — re-fetch full part on user expand failed
- LAZYLOAD_SESSION_NOT_FOUND — meta endpoint 404 for unknown sessionID
- SSE_REPLAY_LASTID_STALE — client 的 lastId 已超出 ring buffer，server 回 sync.required (R8, ADDED 2026-04-22)
- SSE_REPLAY_WINDOW_EXCEEDED — client 的 lastId 在 buffer 內但超過 max_events / max_age 窗口，裁切後發 sync.required (R8)
- MESSAGES_CURSOR_NOT_FOUND — `beforeMessageID` 指向不存在的 messageID (R9, ADDED 2026-04-22)
- MESSAGES_CURSOR_INVALID — `beforeMessageID` 格式錯誤（非 `msg_*` prefix）(R9)

### Details

| Code | 訊息 | 觸發情境 | 責任層 | Recovery |
|---|---|---|---|---|
| `LAZYLOAD_META_HTTP_ERROR` | `無法判斷最後 session 狀態` | `GET /session/:id/meta` 回 4xx/5xx 或網路錯誤 | webapp-spa (CMP1) | 導向 `/sessions` + 顯示錯誤 banner；不退回直接載全量 session |
| `LAZYLOAD_META_PARSE_ERROR` | `無法解析 session metadata` | meta 回 200 但 body shape 非 `SessionMetaResponse` | webapp-spa (CMP1) | 同 HTTP_ERROR：走 `/sessions` + banner |
| `LAZYLOAD_META_CACHE_MISS` | (warn 等級，不面向使用者) | server 端 `session:{id}:meta` cache miss 且無法計算（例如 session storage 讀檔失敗） | server (CMP8/CMP9) | server 回 500；若是 storage 真壞應冒泡讓使用者看到 |
| `LAZYLOAD_TWEAKS_MISSING_KEY` | (warn 一次/key/session)：`[lazyload] <key> missing in tweaks.cfg, using default <value>` | tweaks.cfg 缺該 key | webapp-spa (CMP11) | 使用 data-schema.json 定義的 default，繼續運行 |
| `LAZYLOAD_TWEAKS_INVALID_VALUE` | `[lazyload] <key>=<val> invalid (expected <range>), using default <value>` | tweaks.cfg 給的值型別/範圍錯誤 | webapp-spa / server (CMP11) | 使用 default；warn 一次 |
| `LAZYLOAD_REBUILD_MISMATCH` | (info 等級)：`[lazyload] rebuild-mismatch partId=<id>` | R4 heuristic：前綴不 match，被迫走 replace 路徑 | webapp-spa (CMP7) | 正常 replace；若頻繁發生 → 代表 AI SDK 行為改變，需人工檢查 DD-5 |
| `LAZYLOAD_TAIL_WINDOW_TRIGGERED` | (info 等級)：`[lazyload] tail-window partId=<id> truncatedPrefix=<bytes>` | streaming 中 part 超 `tail_window_kb` 被截 | webapp-spa (CMP7) | 屬預期行為；純 observability |
| `LAZYLOAD_LOADMORE_ERROR` | `載入歷史訊息失敗：<error>` | `history.loadMore()` 失敗（網路 / server 5xx） | webapp-spa (CMP4) | 顯示錯誤，允許使用者重試；不重複自動觸發（避免無限 loop） |
| `LAZYLOAD_SCROLL_SPY_CONFLICT` | (warn)：`[lazyload] scroll-spy fired in follow-bottom mode, ignoring` | IntersectionObserver 在 `follow-bottom` mode 被觸發（理論不應該） | webapp-spa (CMP5) | 忽略本次事件 + warn 一次 |
| `LAZYLOAD_FLAG_UNAVAILABLE` | `無法讀取 frontend_session_lazyload 設定` | tweaks.cfg 檔案不存在或無讀權限 | webapp-spa / server | 視為 `frontend_session_lazyload=0`（安全預設），但必須 warn 且記入 observability |
| `LAZYLOAD_EXPAND_FETCH_ERROR` | `展開 part 失敗：<error>` | R3.S2 後使用者點展開，重新 fetch 完整 part 時失敗 | webapp-spa (CMP6) | 顯示錯誤 + 允許重試；保留 tail 顯示 |
| `LAZYLOAD_SESSION_NOT_FOUND` | (server 404) | meta 端點對不存在 sessionID 的查詢 | server (CMP8) | 回 404；webapp 視為 `LAZYLOAD_META_HTTP_ERROR` 處理 |
| `SSE_REPLAY_LASTID_STALE` | (info)：`[SSE-REPLAY] lastId=X returned=0 dropped=all boundary=count` | client 發 Last-Event-ID=X 但 ring buffer 最舊 id > X+1 | server (global.ts handshake) | 發一筆 `sync.required`；client 收到後走 HTTP full resync |
| `SSE_REPLAY_WINDOW_EXCEEDED` | (info)：`[SSE-REPLAY] lastId=X returned=N dropped=M boundary={count\|age}` | buffer 有 X 以後事件但超過 max_events 或 max_age_sec | server (global.ts handshake) | 回裁切後 tail + 前置 `sync.required`；client 做全量再同步 |
| `MESSAGES_CURSOR_NOT_FOUND` | (server 404) | 呼叫帶 `beforeMessageID=unknown` | server (session.ts) | 回 404 + error body `{code: "MESSAGES_CURSOR_NOT_FOUND"}`；前端顯示「無法載入更早訊息，請重新整理」 |
| `MESSAGES_CURSOR_INVALID` | (server 400) | `beforeMessageID` 格式錯（非 `msg_*`） | server (session.ts) | 回 400；前端視為程式 bug（log error，不顯示給使用者） |

## 錯誤分級

- **Error (使用者可見)**：`LAZYLOAD_META_*`、`LAZYLOAD_LOADMORE_ERROR`、`LAZYLOAD_EXPAND_FETCH_ERROR` — 必須 UI 顯示（toast / banner）。
- **Warn (console only)**：`LAZYLOAD_TWEAKS_*`、`LAZYLOAD_SCROLL_SPY_CONFLICT`、`LAZYLOAD_FLAG_UNAVAILABLE` — 每類每 session 最多 warn 一次。
- **Info (telemetry only)**：`LAZYLOAD_REBUILD_MISMATCH`、`LAZYLOAD_TAIL_WINDOW_TRIGGERED`、`SSE_REPLAY_LASTID_STALE`、`SSE_REPLAY_WINDOW_EXCEEDED` — 推到 observability，不干擾 UI。
- **Error (server-visible)**：`MESSAGES_CURSOR_NOT_FOUND`（404）、`MESSAGES_CURSOR_INVALID`（400）— 透過 HTTP status + error body 回 client。

## 無聲 fallback 禁令覆核

以下行為**明確禁止**（如有實作到這些分支需立即回報，視為違反 AGENTS.md 第一條）：

- meta 呼叫失敗 → 繼續嘗試載入整個 session。
- tweaks.cfg 讀不到 `frontend_session_lazyload` → 預設 `1`（應預設 `0` + warn）。
- scroll-spy loadMore 失敗 → 自動重試無限次。
- cap 設定缺失 → 把 cap 設成 `Infinity`（應該用 default + warn）。
- SSE reconnect 發現 buffer 不夠 → 「盡量送」把 ring buffer 全部 dump 出去（應該遵守 bounded replay + sync.required）。
- `beforeMessageID` 指向不存在的 id → 回空 page 假裝成功（應該 404 + error code）。
