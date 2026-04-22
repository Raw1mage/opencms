# Invariants: frontend-session-lazyload

跨切保證（cross-cut guarantees）。這些條件違反時代表設計斷裂，codegen 與 refactor 必須維持。每條附 **何處強制** 與 **偵測方式**。

## INV-1 · Meta ETag 必與 `session:{id}` 共享 version

**Statement**：`GET /session/:id/meta` 回傳的 `etag` 與 `GET /session/:id`、`GET /session/:id/message?limit=N` 的 ETag 必定從同一個 per-session version counter 衍生。任一端點觀測到 version bump，其餘端點下一次回應必須也 bump。

**Why**：避免 client 拿到過期 meta 但後續 message list 已更新（或反之）造成尺寸門檻誤判。

**Enforced at**：
- `packages/opencode/src/server/session-cache.ts` 的 version bump 路徑（任何 `MessageV2.Event.*` / `Session.Event.Created|Updated` 都 bump）。
- meta handler 必須呼叫相同的 `SessionCache.currentEtag(sessionID)`（或以同一 version 組成自己的 ETag）。

**Detect**：integration test — 寫一個 session 新增 part，前後比對 meta / session / message 三端點 ETag 必定改變且可推導同步。

---

## INV-2 · Flag=0 路徑與主線 baseline 行為等價

**Statement**：當 `tweaks.cfg` 的 `frontend_session_lazyload=0` 時，整個 webapp 的可觀測行為（DOM 結構、HTTP 呼叫序列、SSE 訂閱行為、localStorage 寫入）必須與「本 plan 未合入前的主線」完全一致。**新端點 `GET /session/:id/meta` 存在於 server 但不得被 client 呼叫**。

**Why**：這是 feature flag 的意義；翻車能秒退。

**Enforced at**：
- `CMP1 LayoutPage.openRootSession` 讀 flag，flag=0 走原路徑。
- `CMP4 SyncContext.history` 讀 flag，flag=0 固定 `messagePageSize=400`。
- `CMP5 MessageTimeline`、`CMP6 MessagePart`、`CMP7 EventReducer` 均以 flag 守護新邏輯。

**Detect**：
- Unit test 對比 flag on/off 下 `openRootSession` 的 network call list。
- E2E fixture：flag=0 跑完整 session 開啟流程，snapshot DOM + network trace，與 pre-plan 的 commit baseline diff 應為空。
- §7.1 工作「byte-by-byte 等價」即在驗證此 invariant。

---

## INV-3 · Stream 完成後 `truncatedPrefix` 必須清零或由 fetch 補齊

**Statement**：`store.part[id].truncatedPrefix > 0` 只允許在 `store.part[id].status === "streaming"` 期間存在。當 message / part 轉為 `completed` 且使用者要求展開時，UI 必須從 server 重新取得完整 part 內容並把 `truncatedPrefix` 歸零。不得讓使用者在 completed 狀態下長期閱讀到被截斷的文字而無從展開。

**Why**：DD-4 為了 streaming 記憶體犧牲了中段資料；必須保證完成後可以恢復完整性。

**Enforced at**：
- `CMP6 MessagePart`：`status === "completed" && truncatedPrefix > 0` 時，展開鈕 onClick handler 觸發 re-fetch。
- `CMP7 EventReducer`：`message.updated status=completed` 時若 `truncatedPrefix > 0` 必須發 `lazyload.streaming.tail` event（observability 追蹤）並標記「待展開補全」。

**Detect**：Unit test — 模擬 streaming part 超 cap → message completed → 展開 → assert full text 被拿到且 `truncatedPrefix === 0`。

---

## INV-4 · 任何 part 的 DOM 字元上限 = `part_inline_cap_kb × 1024`（展開後除外）

**Statement**：在 collapsed 或 tail-window 狀態下，單一 MessagePart render 到 DOM 的字元數不得超過 `part_inline_cap_kb × 1024`。只有使用者明確展開後才可超過。

**Why**：這是解 OOM 的物理保證。

**Enforced at**：
- `CMP7 EventReducer`：streaming tail-window 截斷。
- `CMP6 MessagePart`：completed fold preview 只 render 前 `fold_preview_lines` 行或前 cap 字元（取較小）。

**Detect**：
- Unit test 測幾個 part 尺寸（10KB / 60KB / 500KB / 3MB），斷言 collapsed 狀態 DOM `textContent.length <= cap`。
- E2E fixture：開啟 fixture session，量 `document.body.innerText.length` 於折疊態。

---

## INV-5 · Scroll-spy 觀測期限於 `autoScroll.mode === "free-reading"`

**Statement**：頂端 IntersectionObserver 只能在 `autoScroll.mode === "free-reading"` 時 `observe`；進 `follow-bottom` 模式必須 `unobserve`。嚴禁在任何其他 mode / transition 中處於 observing 狀態。

**Why**：避免 `follow-bottom` 把舊訊息 DOM 推出視窗外的一剎那誤觸 `loadMore()`，造成無限 load 迴圈。DD-6、R-5、G-4。

**Enforced at**：
- `CMP5 MessageTimeline` 的 mode change handler；mode transition 必須同步 toggle observer。

**Detect**：
- Unit test：mode='follow-bottom' 時手動觸發 sentinel intersection → assert `loadMore` 未被呼叫。
- Runtime sanity：若偵測到 observer 在 follow-bottom mode 下 fire → 發 `LAZYLOAD_SCROLL_SPY_CONFLICT` warn（errors.md）。

---

## INV-6 · Meta 呼叫失敗 → navigate `/sessions`，永不載入該 session

**Statement**：`openRootSession()` 對 meta endpoint 的呼叫失敗（任何 HTTP 非 2xx、網路錯誤、parse 錯）必定導致 navigate 到 `/sessions`（或同等列表頁）。**嚴禁** 因 meta 失敗而 fallback 到「直接載入那個 session」。

**Why**：AGENTS.md 第一條「禁止靜默 fallback」。meta 失敗代表不知道 session 大小，此時強制載入就是把使用者推回 OOM 狀態。

**Enforced at**：
- `CMP1 LayoutPage.openRootSession`：meta catch block 必 navigate `/sessions`。

**Detect**：test-vectors.json `TV-R1-S3`；errors.md `LAZYLOAD_META_HTTP_ERROR` / `LAZYLOAD_META_PARSE_ERROR` / `LAZYLOAD_SESSION_NOT_FOUND` 的 recovery 欄位。

---

## INV-7 · tweaks.cfg 閾值一致性

**Statement**：`session_size_threshold_parts` 和 `session_size_threshold_kb` 的組合必須同時生效（**OR 關係**）：任一門檻被超過都視為「大 session」。不得只套 parts 或只套 kb。另：`tail_window_kb ≤ part_inline_cap_kb`（tail-window 不該比 cap 本身還大，否則語義矛盾）。

**Why**：避免個別門檻被誤解釋成 AND 造成門檻失效；cap 與 tail 關係必須單調。

**Enforced at**：
- `CMP1 LayoutPage.openRootSession` 的判斷邏輯。
- `CMP11 TweaksLoader` 讀值時若 `tail_window_kb > part_inline_cap_kb` 發 `LAZYLOAD_TWEAKS_INVALID_VALUE` 並把 `tail_window_kb = part_inline_cap_kb`。

**Detect**：unit test 覆蓋四種門檻組合（只超 parts / 只超 kb / 兩者皆超 / 皆未超），以及 `tail_window_kb` 異常情境。

---

## INV-8 · SSE handshake bounded replay (R8, ADDED 2026-04-22)

**Statement**：任何 SSE reconnect 握手，`await stream.writeSSE` 的實際執行次數 **必須 ≤ `sse_reconnect_replay_max_events + 1`**（+1 是 `sync.required` 或 `server.connected`）。無論 ring buffer 多大、client `lastId` 多舊、事件多新，這個上限都不得突破。

**Why**：這是打掉 daemon event-loop 飢餓的核心契約。若握手可以突破上限，單一 reconnect 會把 event loop 鎖死數百毫秒，其他 HTTP / splice proxy 全部等，正是 2026-04-22 RCA 觀測到的主因。

**Enforced at**：
- `global.ts` handshake 路徑中唯一的 `writeSSE` 迴圈必須用 `sseGetBoundedSince` 而非 `sseGetSince`。
- Code review hard check：搜尋 `for (const entry of missed)` pattern 必須對照 `droppedBoundary` 處理。

**Detect**：test-vectors `TV-R8-S5`；整合測試：buffer 塞 10000 events、reconnect、assert `writeSSE` calls ≤ 101。

---

## INV-9 · session.messages tail-first default (R9, ADDED 2026-04-22)

**Statement**：`GET /session/:id/message` 無 `beforeMessageID` 時必回「最新 N 則」tail，絕不回「所有 messages」；N 由 `session_messages_default_tail` 控制（預設 30），client 送的 `limit` 可覆寫 N 但不改 tail-from-newest 語義。分頁走 `beforeMessageID` cursor append，**嚴禁** 把 limit 放大重抓舊頁。

**Why**：Session 規模無上限，若 default 回全部，cold open 會跟沒 cursor 一樣觸發全量 hydration → daemon event-loop 飢餓 → splice proxy drop HTTP body。tail-first default 確保任何 cold open 的網路 payload 都被窗口化。

**Enforced at**：
- `session.ts` `GET /:sessionID/message` handler 分支決策：`beforeMessageID ?? default-tail`。
- `sync.tsx` `history.loadMore()` 必須呼 `beforeMessageID=<oldest_known>`，**禁止** `currentLimit + count` 整包重抓。

**Detect**：test-vectors `TV-R9-S1 / S2 / S5 / S6`；grep codebase 禁止 `messagePageSize + count` 這類 pattern 再出現。

---

## INV-10 · CMS/user-daemon proxy cursor passthrough (DD-12 extension)

**Statement**：任何 client → gateway → user-daemon 的 `/message` 呼叫，以下參數必須 **完整透傳**：`limit`、`since`（既有）、`beforeMessageID`（新增，R9）。任何一層遺失都屬契約破壞。

**Why**：2026-04-22 RCA 顯示既有 `since` 已在 CMS proxy 路徑被丟掉；本 revise 新增 `beforeMessageID` 若重蹈覆轍，整個 R9 形同沒做（mobile/CMS 路徑自動退化）。

**Enforced at**：
- `packages/opencode/src/server/user-daemon/manager.ts` `callSessionMessages` 必須顯式傳入全部參數。
- 整合測試：direct-daemon call vs CMS-routed call 對同一 query 必須產生 byte-identical 的 daemon log `beforeMessageID=...`。

**Detect**：test-vectors `TV-R9-S4`；errors.md `SSE_REPLAY_LASTID_STALE` 鄰近的測試若看到 CMS 路徑 404 率異常偏高即為此 invariant 破壞。
