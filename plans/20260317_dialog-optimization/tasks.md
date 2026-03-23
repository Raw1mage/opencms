# Tasks

## 1. Backend Pagination API
- [ ] 1.1 為 `MessageV2.stream()` 新增 `after?: string` 參數，跳過 cursor 之後的消息再開始反向迭代
- [ ] 1.2 為 `Session.messages()` 新增 `cursor?: string` 參數，傳遞給 stream
- [ ] 1.3 `Session.messages()` 回傳時計算 `nextCursor`（如果還有更多消息）和 `compactionAt`（最近 compaction 邊界 messageID）
- [ ] 1.4 HTTP route `GET /:sessionID/message` 新增 `cursor` query param，response header 加入 `X-Cursor-Next` 和 `X-Compaction-At`
- [ ] 1.5 單元測試：cursor 分頁正確性（帶 cursor / 不帶 cursor / cursor 到起點）
- [ ] 1.6 單元測試：compactionAt 偵測正確性

## 2. TUI Two-Phase Loading
- [ ] 2.1 PoC 驗證：scrollbox prepend 子元素後視口位置是否穩定
- [ ] 2.2 `sync()` 拆分為 `syncInitial()`（拉最近 20 條）和 `syncBackfill()`（背景分批補齊）
- [ ] 2.3 `syncBackfill()` 使用 cursor 逐批拉取，每批 20 條，直到遇到 compaction 邊界或無更多消息
- [ ] 2.4 store 增量更新：prepend 消息到 `store.message[sessionID]` 前端，用 reconcile 去重
- [ ] 2.5 新增 `loadingState` signal（idle / loading-initial / backfilling / complete）供 UI 消費
- [ ] 2.6 短 session 快速路徑：首批返回量 < limit 時跳過 backfill

## 3. Compaction-Aware Loading + UI
- [ ] 3.1 `syncBackfill()` 讀取 `X-Compaction-At` header，止步於 compaction 邊界
- [ ] 3.2 擴展現有 compaction UI 元件，新增「載入更早的 N 條消息」互動按鈕
- [ ] 3.3 按鈕觸發 `syncOlder()` — 用 compaction 邊界 messageID 作為 cursor 繼續向前加載
- [ ] 3.4 多層 compaction 支援：每次 `syncOlder()` 加載到下一個 compaction 邊界，可重複觸發
- [ ] 3.5 整合測試：長 session 含 compaction 的完整加載流程
- [ ] 3.6 手動驗證：進入長 session → 立即可操作 → 背景加載不跳動 → compaction UI 可展開
