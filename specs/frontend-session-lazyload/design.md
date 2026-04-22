# Design: frontend-session-lazyload

## Context

OpenCode 的 web frontend 目前在開啟大 session 時會 OOM，且 2026-04-22 mobile/CMS RCA 進一步證明先前 lazyload 設計有結構性漏洞：首頁 auto-redirect 直接把使用者丟進最後 active session；REST 雖已支援 `?limit=N` 分頁與 SessionCache ETag，但 session open 仍是 `session.get + session.messages(limit)` 整包 hydration、part 層無任何 size cap，AI SDK 的 rebuild storm 透過 SSE `message.part.updated` 直接觸發 React 每次 re-render。

RCA 額外確認三個關鍵洞：

- `history.loadMore()` 目前是擴大 `limit` 後全量重抓，不是真正 older-history append。
- `GET /session/:id/message?since=...` 雖存在，但 CMS → user-daemon proxy 會遺失 `since`。
- `ensureFrontendTweaksLoaded()` 未掛在 app bootstrap，代表 `frontend_session_lazyload` 很可能長期停留在預設 `0`。

## Goals / Non-Goals

### Goals

- 不重做既有設施（session-poll-cache Phase 1 cache / ETag、message pagination、auto-scroll follow-bottom、Last-Event-ID replay 都沿用）。
- 把「新進來的訊息優先、舊訊息被動補」變成預設行為而非需要使用者手動點按鈕。
- 把「tail-first attach」做成真正的 network/storage attach protocol，而不是只停在 render-side lazyload。
- 讓瀏覽器對超大 part 永遠有可控的 DOM 上限。
- 可秒退：所有變更由 `tweaks.cfg` flag 控制。

### Non-Goals

- 訊息層 virtualized list（Solid `<For>` 在 50–200 級別無壓力）。
- Server pagination API（已存在）。
- 改 SSE 事件 schema。
- 改 daemon / provider 對 AI SDK 的 delta 合併策略（屬 codex-cascade 範圍）。
- 做 session 歷史資料搬遷/壓縮。

## Decisions

- **DD-1** 新增 `GET /session/:id/meta` 端點，沿用 SessionCache。Cache key `session:{id}:meta`，與既有 `session:{id}` / `messages:{id}:{limit}` 並存；invalidation 掛在同一組 Bus event，任何 session 變更都 bump 所有三類 key 的 version。
- **DD-2** 首頁 `openRootSession()` 在 redirect 前一律呼 meta；任何錯誤（包含 404、500、網路）一律改走 `/sessions`，不退回「直接載」。
- **DD-2b** session open attach contract 改為 `session.get/meta -> tail page -> render -> lazy older history`。不得再用「先整包 hydrate，再只 render 尾端」冒充 lazyload。這是 2026-04-22 RCA 後新增的硬要求。
- **DD-3** `PART_INLINE_CAP` 預設 64KB，由 `tweaks.cfg` 的 `part_inline_cap_kb` 控制；`fold_preview_lines` 預設 20；streaming `tail_window_kb` 預設同 `PART_INLINE_CAP`。缺項走 default + console warn（但不 crash）— 例外於 R2.S4（runtime 可用 default，不像 meta 呼叫失敗那樣必須中斷）。
- **DD-4** 「Streaming 中是否超 cap」的判斷在 `event-reducer` 做，不在 MessagePart 做：reducer 把 `store.part[id].text` 收敛到 `tail_window_kb`（只保最後 N KB + 標記 `truncatedPrefix: K`）；MessagePart 只負責 render + 收合。這樣做的原因是讓 DOM 從源頭就沒有完整 3MB。
- **DD-5** Rebuild 判斷採「length match + prefix match」兩步驗證；match 失敗才走 replace（R4.S3）。Prefix match 只比對前 1024 字元，避免每次 delta 都 O(n) 比對。
- **DD-6** Scroll-spy 用 IntersectionObserver 綁在 MessageTimeline 最上方的 hidden sentinel；rootMargin `"400px 0px 0px 0px"` 讓使用者還有 2 ~ 3 畫面距頂就開始載。loading 期間 sentinel 不 observe。scroll-spy 觸發的是 **older-history append**，不是 `currentLimit + count` whole-slice refetch。
- **DD-7** 初始 page size 分三檔（50/100/all），門檻 `partCount ≤ 50` 全載、`≤ 200` 載 100、否則 50；皆可由 tweaks.cfg override。採 partCount 而非 byteCount 是因為 meta 端點必回 partCount，而 byteCount 可能延遲。
- **DD-8** Feature flag `frontend_session_lazyload` 預設 **關**。Rollout 階段手動打開；穩定 1–2 週後改預設 **開**；4 週後移除 flag。
- **DD-9** 不在 client 做 meta 呼叫的 retry：失敗就走 `/sessions`。理由：這是打開頁面瞬間的決定，retry 會卡住 UI；走 `/sessions` 已是安全退路。
- **DD-10** Sidebar 新對話按鈕直接呼現有 `POST /session` API，不需改 server。
- **DD-11** `ensureFrontendTweaksLoaded()` 必須在 app bootstrap 階段執行；lazyload flag 若未被載入，整個 feature 就只是 dead code。這個 bootstrap 缺口本身屬於本 spec 範圍。
- **DD-12** CMS/user-daemon session message proxy 必須完整透傳 replay/cursor 參數（先補 `since`；若後續加入 `beforeMessageID`/cursor，也同屬此契約）。mobile/CMS 路徑不允許退化成 full-history fetch。
- **DD-13** (2026-04-22 revise) **SSE reconnect handshake 必須 bounded**。現有 [global.ts:322-351](packages/opencode/src/server/routes/global.ts#L322-L351) 在 Last-Event-ID catch-up 時把 `sseGetSince(lastId)` 整包 for-loop `await stream.writeSSE`，沒有任何上限 — ring buffer 最多 1000 筆，1000 次 await 會霸佔 event loop 幾百毫秒，期間 splice proxy 被拖住，其他 HTTP 請求全部等。新契約：裁切到 `sse_reconnect_replay_max_events`（預設 100）+ `sse_reconnect_replay_max_age_sec`（預設 60），超出裁切範圍的窗口前缺口改發 `sync.required`。`_sseBuffer` 結構擴充 `receivedAt` 以支援 age window 判斷。
- **DD-14** (2026-04-22 revise) **session.messages 預設行為從「整包回 N 筆」改為「tail-first cursor」**。新增 `beforeMessageID` query param；無此參數時回最新 tail（數量由 `session_messages_default_tail` 控制，預設 30），有參數時回 created 更舊的 `limit` 筆；`history.loadMore()` 從擴大 limit 重抓改為 cursor append。向後相容：不送 `beforeMessageID` 的舊 client 呼叫等同「tail-first + limit 覆寫」，行為對舊使用者不變。cache key 擴充為 `messages:{id}:{beforeMessageID ?? "tail"}:{limit}`。
- **DD-15** (2026-04-22 revise) **R8 + R9 先於 R1b 落地**。雖然 R1b (tail-first attach protocol) 是 spec 既有的框架契約，但實作順序上 R8 (bounded SSE replay) 與 R9 (messages cursor) 必須先上 — 這兩個是 root cause 在 network/server 層的修正。若 R1b 先上但沒有 R9 支撐的 cursor API，attach protocol 只能重回 limit hack。因此 tasks.md 執行順序改為 `R1 → R2 → §1..§6 → §7`。

## Risks / Trade-offs

- **R-1 rebuild 判斷誤判**：若 AI SDK 未來改變 rebuild 行為（例如中間插一段而非 append），R4 的 prefix match 可能錯把真替換當 append。緩解：失敗時 log `[lazyload] rebuild-mismatch partId=X`；fixture 測試覆蓋至少 3 種已知 rebuild 模式。
- **R-2 streaming tail-window 丟失捲回觀看**：使用者可能在 streaming 中想看前段。緩解：畫面頂部明確提示「暫顯示最後 64KB」+ 「完成後可看全文」；若真有需求再做「streaming 中 toggle full view」。
- **R-3 meta 呼叫延遲拖慢首屏**：多一次 round-trip。緩解：meta endpoint 回傳極小（<1KB），走 SessionCache ETag，cache hit 時 < 10ms。
- **R-4 flag 關閉期間 bug 只在 flag 開時出現**：雙路徑維護期 1–4 週；必須每個 PR 同時跑 flag on/off 兩組 test。
- **R-5 scroll-spy 與 auto-scroll 互相干擾**：`follow-bottom` 往下捲的同時 top-sentinel 不該觸發 load。緩解：top-sentinel observer 僅在 `autoScroll.mode === "free-reading"` 時啟用。
- **R-6 tail-first 只做表面、沒有改 attach protocol**：這正是前版 spec 的已知失敗模式。緩解：驗收必須包含 CMS/mobile 路徑，並明確驗證首屏是 tail-first、older history 是 append，不接受 render-only lazyload。
- **R-7 proxy replay 參數又被中途吃掉**：gateway、user-daemon manager、route handler 任一層漏帶 `since/cursor` 都會讓 CMS 路徑退化。緩解：加入 direct-daemon vs CMS parity test。
- **R-8** (2026-04-22 revise) **bounded replay 把真實缺口誤判成可丟棄**：若 max_events/age 設太小，client 剛好在窗口外就頻繁 `sync.required` → 每次都觸發全量 resync，反而更重。緩解：預設值 (100 events / 60s) 經 `639ca5af1` 的 SSE-reconnect-long-outage 實測校準；如果觀測到 `sync.required` 率 > 10% reconnect，要調大窗口或改邏輯（不是把 bounded 拿掉）。
- **R-9** (2026-04-22 revise) **messages cursor 破壞既有 `limit=N` 契約**：若任何消費者依賴「`GET /:id/message?limit=400` 回整包」(e.g. 匯出 / 備份 script)，新契約下仍回最新 400 則，沒舊的。緩解：grep 現有 codebase 所有 `session.messages` 呼叫確認無匯出類 use case；新契約明確要求消費者自行跟 `beforeMessageID` cursor 逐頁拉。若真的有匯出需求，另加 `fullHistory=1` 旗標，不混在 cursor path 裡。
- **R-10** (2026-04-22 revise) **前端 append 邏輯寫壞導致 message 重複或順序亂**：`history.loadMore` 改為 append 後，若 dedup 沒做好或 created 排序假設被打破，UI 會出現重複/錯亂。緩解：R2.4 + R2.5 明確要求 dedup by `messageID`、排序 key 固定用 `time.created`，並補單元測試覆蓋「同一 messageID 不應出現兩次」的 invariant。

## Critical Files

- `packages/opencode/src/server/routes/session.ts` — 新增 `/:sessionID/meta` handler
- `packages/opencode/src/server/user-daemon/manager.ts` — session.messages proxy query contract
- `packages/opencode/src/server/session-cache.ts` — 新增 `meta` cache key 命名空間
- `packages/app/src/app.tsx` — frontend tweaks bootstrap
- `packages/app/src/pages/layout.tsx` — `openRootSession` 重寫 + sidebar 新對話按鈕
- `packages/app/src/pages/sessions.tsx` — 新路由頁（若已有 session list UI 則改）
- `packages/app/src/pages/session/message-timeline.tsx` — 頂端 sentinel + IntersectionObserver
- `packages/app/src/context/sync.tsx` — `messagePageSize` 改為 `pageSizeFor(partCount)`，並把 full-history-first sync 改為 tail-first attach + older-history append
- `packages/opencode/src/session/index.ts` / `message-v2.ts` — 若現有 `limit/since` 不足以支撐 older-history append，這裡是 cursor/before seam
- `packages/ui/src/components/message-part.tsx` — size cap fold UI + streaming 提示
- `packages/web/src/event-reducer.ts` — rebuild heuristic + tail-window 截斷
- `packages/opencode/src/config/tweaks.ts` — 新 key 讀取 + fallback
- `/etc/opencode/tweaks.cfg`（template 同步）— 新增預設值
- `docs/events/event_2026-04-20_frontend-lazyload.md` / `event_20260422_mobile_session_tail_first_lazyload.md` — 變更紀錄與 RCA
- `packages/opencode/src/server/routes/global.ts` — (2026-04-22 revise) SSE handshake bounded replay 落地點；`_sseBuffer` 結構擴充 `receivedAt`；新增 `sseGetBoundedSince` 純函式
- `packages/opencode/src/server/routes/session.ts` — (2026-04-22 revise) `GET /:sessionID/message` 加 `beforeMessageID` 參數；cache key 擴充
- `packages/app/src/context/sync.tsx` `history.loadMore` — (2026-04-22 revise) 改為 cursor append，非 whole-slice refetch
- `packages/opencode/src/server/user-daemon/manager.ts callSessionMessages` — (2026-04-22 revise) 新參數透傳，和 DD-12 同條規則

## Rollout

- **Week 1** Phase 1 + 2 ship with flag=0；少數內部帳號手動 flag=1 驗證 tweaks bootstrap + proxy catch-up。
- **Week 2** Phase 3 + 4 ship；flag=1 擴到全部內部帳號。
- **Week 3** 觀察 daemon log DELTA-PART / 瀏覽器 heap / Lighthouse；無 regression 則 tweaks.cfg 預設值改 flag=1。
- **Week 5** 移除 flag 與舊路徑 code。
