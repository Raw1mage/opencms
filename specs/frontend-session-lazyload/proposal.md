# Proposal: frontend-session-lazyload

## Why

- 瀏覽器打開 opencode webapp 後，首頁自動導向最後 active session；當該 session 正在 streaming（AI SDK rebuild storm，單一 part 累積 3MB+ 文字、10000+ delta），瀏覽器 tab 直接 `Out of Memory`。使用者被鎖死在一個進不去的 session。
- 2026-04-20 觀測：`ses_25722e026ffejCoJPJAlGRt0Mc`（151 parts / 2.2MB on-disk）與 `ses_2571c40acffez7e45s03EQ4VU0` 同步 streaming；gateway/daemon 均健康。問題完全在前端。
- 真兇是 **part 層級的爆量**（單一 part streaming 時記憶體/DOM 無 cap），而非訊息數量。訊息層級分頁 **已經做完**（見 §What exists already）。

## Original Requirement Wording (Baseline)

- 「我可以理解 session 正在大量工作中。但是 web frontend 端要做 smart design，採 lazy load，不要無腦硬塞 sse」
- 「進入是用首頁網址，沒有辦法選擇不同 session；它會自動導到最後一個工作中的 session，導致被訊息塞爆。」
- 「新進來的畫面優先顯示，使用者往前捲的時候才被動載入舊的資料」
- 「你必須把現有架構已有的機制搞清楚，才不會 double work」

## Requirement Revision History

- 2026-04-20: initial draft created via plan-init.ts
- 2026-04-20: G1–G7 七個設計缺口透過 AskUserQuestion 敲定（見 §Design Decisions）
- 2026-04-20: 盤點既有機制後大幅收斂（砍掉 server pagination、降優先訊息層 virtualization）；core 改為 **part 層 cap + scroll-spy 自動載入**
- 2026-04-22: mobile/CMS RCA 顯示前版 spec 有重大漏洞：設計只做到 render-side lazyload，**沒有把 session open protocol 改成 tail-first attach**；另發現 CMS → user-daemon 代理會遺失 `since`，既有 `frontend_session_lazyload` tweaks bootstrap 也未真正掛上 app 入口
- 2026-04-22: 使用者再補充 mobile/CMS 整體不穩：prompt 送出後不回應、subagent 中途停止而 main 無知覺、以及不定時被登出；本 spec 先把它們納入 mobile 驗證與 stop-gate，若 tail-first attach 落地後仍存在則拆成獨立 reliability spec
- 2026-04-22 (revise, post-merge): 生產觀測證實先前 Phase 2 (tail-first attach + proxy catch-up) 被整個跳過；加上 SSE reconnect 把 1000-event ring buffer 全量 replay 的行為，**成為 daemon event-loop 飢餓的首要觸發源**。證據：`ses_24b2d916dffeaKQcN79znevt1b` 19:31–19:35 gateway 收到 7× POST `/prompt_async`，daemon structured log 卻 0× `prompt_async inbound` — splice proxy 在握手 replay 期間整個被拖住。重啟 client、client-side retry 都救不了這條，必須修 server 回送行為。同時釐清 `mobile-submit-durability` 所列的 3s ACK / client retry 是 symptom-level 補丁，真正 root cause 由本 spec G1+G2 處理；`mobile-submit-durability` 改為 placeholder，等 G1+G2 上線觀測後再決定是否需要補

## What exists already（禁止重做）

- ✅ **Server message pagination**：`GET /:sessionID/message?limit=N` ([session.ts:1595-1679](packages/opencode/src/server/routes/session.ts#L1595-L1679))，cache key `messages:{id}:{limit}`
- ✅ **SessionCache + ETag / 304**：session-poll-cache Phase 1 已合併 (`e0784efda7`)
- ✅ **Client history API**：`sync.session.history.loadMore(sessionID, count=400)` ([sync.tsx:505-520](packages/app/src/context/sync.tsx#L505-L520))；`meta.limit[key]` / `meta.complete[key]` / `meta.loading[key]`
- ✅ **Incremental tail fetch primitive（但未完整接通）**：`GET /:sessionID/message?since=...` 已存在；但 CMS/user-daemon proxy path 目前遺失 `since`，所以 mobile/CMS 路徑會退化
- ✅ **MessageTimeline props**：`historyMore` / `historyLoading` / `onLoadEarlier`（手動 Load Earlier 按鈕已接好）
- ✅ **Auto-scroll**：`follow-bottom` 預設、scroll-up 自動轉 `free-reading`（[create-auto-scroll.tsx](packages/ui/src/hooks/create-auto-scroll.tsx)）
- ✅ **SSE seq ID + Last-Event-ID replay**：[global.ts:319-351](packages/opencode/src/server/routes/global.ts#L319-L351)

新 plan **沿用** 上述設施；但 2026-04-22 RCA 後，不能再假設「已有 loadMore + replay 就等於真正 lazy attach」。本 plan 必須補上 open-session tail-first 協定與 older-history lazy append。

## Design Decisions (G1–G7, 2026-04-20)

- **G1 逃生入口**：Sidebar 新對話按鈕 + `/sessions` 列表頁 + `openRootSession` 尺寸門檻（三者並做）。
- **G2 尺寸來源**：新增 `GET /session/:id/meta` 端點（part count / total bytes / last-updated）。
- ~~**G3 Resume**：沿用既有 `Last-Event-ID` 機制 + 上方已述 `loadMore` API；不需新增 `since=` 參數。~~ (v1, SUPERSEDED 2026-04-22)
- **G3b Attach protocol**：session 開啟必須改成 `session/meta -> tail page -> render -> lazy older history`；CMS/user-daemon proxy 必須完整保留 `since`，且 older-history 不可再用「擴大 limit 全量重抓」假裝 lazyload。 (v2, ADDED 2026-04-22)
- **G4 Large part UX**：預設收合、點開全文（直接 render full DOM，無需新 detail endpoint）。
- **G5 Feature flag**：`tweaks.cfg` 加 `frontend_session_lazyload=1`，灰度 1–2 週後移除。
- **G6 Streaming cap**：streaming 中只 render tail-window（最後 64KB），完成後才允許滾回開頭。
- **G7 Nested agent**：part 層 cap 套到頂層；subagent 內部沿用原實作。
- **G8 RCA hardening**：`ensureFrontendTweaksLoaded()` 必須在 app bootstrap 掛上；否則整套 lazyload 只存在於 dead path。 (ADDED 2026-04-22)
- **G9 SSE reconnect bounded replay**：SSE 握手（Last-Event-ID catch-up）不得把 ring buffer 全量 replay；只回送最近 N 筆 / 最近 M 秒的窗口；窗口外的缺口直接發 `sync.required`，讓 client 走 HTTP cursor pull。門檻走 `tweaks.cfg`：`sse_reconnect_replay_max_events`（預設 100）、`sse_reconnect_replay_max_age_sec`（預設 60）。(v2 revise, ADDED 2026-04-22)
- **G10 session.messages cursor pagination**：新增 `beforeMessageID` 參數，預設只回 tail（tweaks 控制、預設最新 30 則）；`limit` 語意從「**整包上限**」改為「**本頁筆數**」；CMS/user-daemon proxy 必須完整透傳 `beforeMessageID`；前端 `history.loadMore()` 從「擴大 limit 重抓」改為 `beforeMessageID=<oldest_loaded>` append；舊 `limit`-only 呼叫維持向後相容行為。(v2 revise, ADDED 2026-04-22)

## Effective Requirement Description

1. **逃生入口**：首頁 auto-redirect 必須可跳過；sidebar 有「新對話」鈕；大 session 不強拉。
2. **Tail-first attach**：新的 frontend 連 daemon/CMS 時，開 session 必須先拿 tail page，再 lazy 補 older history；不能先整包 hydrate。
3. **CMS proxy 完整透傳 replay/catch-up 參數**：至少 `since` 不能在 gateway → user-daemon 遺失；若新增 `beforeMessageID`/cursor，也必須完整透傳。
4. **Part-level size cap**：單 part 超過 `PART_INLINE_CAP`（預設 64KB）自動收合或 tail-window。
5. **Streaming rebuild 減壓**：`event-reducer` 對 AI SDK 的 full rebuild 改走 append heuristic，減少 React re-render 次數。
6. **Scroll-spy 被動載入**：使用者往上捲到接近頂端時，只 append older history；不得再用 whole-slice refetch 假裝 lazyload。
7. **初始 page size 動態化**：依 `/meta` 回報的 part count 決定（小 session 載全部、中 session 載 100、大 session 載 50）。
8. **Feature flag + tweaks bootstrap**：`tweaks.cfg` 控制整套新行為的開關，且 app 啟動時必須真的讀進來。
9. **Mobile/CMS companion validation**：本 spec 驗收時一併驗證 prompt round-trip、subagent completion relay、session/login continuity；若失敗且無 attach timeout 證據，另開 reliability spec。
10. **SSE reconnect bounded replay (G9, ADDED 2026-04-22)**：握手僅回送最近窗口事件；超出窗口時發 `sync.required`；徹底砍掉「一連上就塞 1000 筆 await writeSSE」的握手飢餓。
11. **session.messages cursor pagination (G10, ADDED 2026-04-22)**：`beforeMessageID` append older；前端 scroll-up 只拉下一頁，不整包重抓；CMS/user-daemon proxy 必須完整透傳。

## Scope

### IN

- `packages/opencode/src/server/routes/session.ts`：新增 `GET /:sessionID/meta`，沿用 SessionCache + ETag。
- `packages/opencode/src/server/user-daemon/manager.ts`：session messages proxy 必須透傳 replay/cursor 參數。
- `packages/app/src/pages/layout.tsx`：`openRootSession()` 加 meta 檢查 + `/sessions` 路由 + 「新對話」按鈕。
- `packages/app/src/pages/session/message-timeline.tsx`：頂端 IntersectionObserver 觸發 `loadMore()`。
- `packages/app/src/app.tsx`：bootstrap 時載入 frontend tweaks。
- `packages/app/src/context/sync.tsx`：初次 attach 改為 tail-first；older history 改 append，不再 whole-slice refetch；初次載入 limit 依 meta 動態決定。
- `packages/opencode/src/session/index.ts`：若現有 `limit/since` 不足，需支援 older-history cursor/before seam。
- `packages/ui/src/components/message-part.tsx`：text / tool output / reasoning 的 size cap 折疊 UI。
- `packages/web/src/event-reducer.ts`：AI SDK full-rebuild → append heuristic；streaming tail-window。
- `/etc/opencode/tweaks.cfg`：`frontend_session_lazyload`、`part_inline_cap_kb`、`session_size_threshold_kb`、`initial_page_size_small/medium/large`、`sse_reconnect_replay_max_events`（新增，預設 100）、`sse_reconnect_replay_max_age_sec`（新增，預設 60）、`session_messages_default_tail`（新增，預設 30）。
- `packages/opencode/src/server/routes/global.ts`：SSE reconnect handshake 改為 bounded replay（G9 落地點）。
- `packages/opencode/src/server/routes/session.ts`：`GET /session/:id/message` 加 `beforeMessageID` 參數 + 預設 tail-only 行為（G10 server 端）。
- `packages/app/src/context/sync.tsx`：`history.loadMore()` 改 cursor append（G10 client 端）。

### OUT

- Server-side message pagination（已有）。
- SessionCache 架構（已有；新端點共用）。
- SSE seq / Last-Event-ID（已有）。
- 訊息層級 virtualization（Solid `<For>` 在 100 條級別無壓力；此 plan 不做）。
- Daemon / provider 層的 delta 合併（另一 plan 範圍）。
- TUI 渲染行為。
- 壓縮/搬移既有 session 歷史資料。
- mobile auth/logout policy 重寫。
- orchestrator/subagent continuation contract 重構（除非證據直接指出本次 attach/reconnect 是根因）。

## Non-Goals

- 不做訊息層 virtualized list（與用戶需求正交；先解部件層即可）。
- 不做無限歷史（仍受 SESSION_RECENT_LIMIT=50 上限保護）。
- 不做 part detail fetch endpoint（直接 render full part，G4）。

## Constraints

- **禁止靜默 fallback**（AGENTS.md 第一條）：meta 呼叫失敗、cap 設定缺失、flag 檔案不存在 → 必須明確報錯，不退回舊行為。
- **沿用既有 SessionCache / ETag**：meta 端點 cache key `session:{id}:meta`；invalidation 掛在同一組 Bus event。
- **tweaks.cfg**：所有閾值走 `/etc/opencode/tweaks.cfg`，附 fallback 預設值。
- **Breaking-change 控管**：`GET /:sessionID/message?limit=N` 契約不動；新端點額外加不改舊的。
- **Repo-independent**：新設定不得寫死路徑；走 XDG / tweaks.cfg。

## What Changes

### Phase 1 — Escape hatch + meta endpoint

- `GET /session/:id/meta`：回 `{ partCount, totalBytes, lastUpdated, etag }`，cache 沿用 SessionCache。
- `app.tsx` bootstrap `ensureFrontendTweaksLoaded()`，確認 lazyload flag 不是 dead path。
- Sidebar 常駐「新對話」按鈕 → POST `/session` → navigate。
- `/sessions` 路由：純列表頁，不 auto-redirect。
- `openRootSession()`：pre-redirect 呼 meta，超過 `session_size_threshold_kb` → `/sessions` + toast。

### Phase 2 — Tail-first attach + proxy catch-up 補洞

- `sync.session.sync()` 由 `session.get + session.messages(limit)` 並行整包 hydration，改成 `session.get/meta -> tail page -> render`。
- `UserDaemonManager.callSessionMessages()` 完整透傳 `since`；若需要 `beforeMessageID`/cursor，一併擴充。
- `history.loadMore()` 不可再用 `currentLimit + count` 全量重抓；改 append older history。

### Phase 3 — Part-level size cap（解 OOM 核心）

- `PART_INLINE_CAP`（tweaks.cfg，預設 64KB）。
- `MessagePart` text / tool output / reasoning：
  - 已結束 part 超過 cap → 預設收合 + 「展開 N KB」。
  - Streaming 中 part 超過 cap → tail-window（只顯示最後 N KB），streaming 完成後允許滾回開頭。
- `event-reducer` rebuild-vs-append heuristic：
  - 若 incoming payload length ≈ existing + delta 且前綴 match → append only。
  - 若真是全量替換且 ratio < 5% → skip 中間更新（以最終值為主）。

### Phase 4 — Scroll-spy 自動載入舊訊息

- `MessageTimeline` 頂端 IntersectionObserver → 接近頂時自動 `loadMore()` append older history。
- 保留「Load Earlier」按鈕作明示 fallback。
- `sync.tsx` 初次載入 limit 改為：
  - meta.partCount ≤ 50 → 載全部
  - 51–200 → 載 100 messages
  - > 200 → 載 50 messages
  - 可由 tweaks.cfg override。

### Phase R1 — SSE bounded replay (G9, ADDED 2026-04-22 revise)

- [global.ts:319-351](packages/opencode/src/server/routes/global.ts#L319-L351) handshake 改寫：
  - 讀 `sse_reconnect_replay_max_events` (預設 100) + `sse_reconnect_replay_max_age_sec` (預設 60)
  - `sseGetSince(lastId)` 回傳序列再依窗口裁切：取 tail N 筆，且排除 event timestamp 超過 age 的
  - 若裁切後漏掉的 id 區間 > 0 → 先發一筆 `sync.required`，再送窗口內事件
  - 新增 telemetry：`[SSE-REPLAY] lastId=X returned=N dropped=M window={events,age}`
- `_sseBuffer` 需要保存 `receivedAt`（目前只有 id + event），為 age window 判斷依據
- 前端 `global-sdk.tsx` 對 `sync.required` 的處理已經存在，直接沿用

### Phase R2 — Messages cursor pagination (G10, ADDED 2026-04-22 revise)

- [session.ts:1595-1679](packages/opencode/src/server/routes/session.ts#L1595-L1679) `GET /:sessionID/message`：
  - 新增 optional `beforeMessageID` query param
  - 若 `beforeMessageID` 有值：回在它之前（created 較舊）的 `limit` 筆（預設 `session_messages_default_tail=30`）
  - 若 `beforeMessageID` 無值：回最新 tail `limit` 筆（**新預設行為 — breaking? 見下**）
  - 向後相容：舊的 `limit=N` only 呼叫保持回最新 N 筆，但實務上等同新行為
  - Cache key 擴充成 `messages:{id}:{beforeMessageID ?? "tail"}:{limit}`
- [manager.ts `callSessionMessages`](packages/opencode/src/server/user-daemon/manager.ts)：完整透傳 `beforeMessageID` + `since` + `limit`，不得丟棄
- [sync.tsx:505-520 `history.loadMore`](packages/app/src/context/sync.tsx#L505-L520)：改為 `beforeMessageID=<oldest_known>`、append 舊訊息；不再 `currentLimit + count` 全量重抓
- `meta.complete[key]` 判定從「fetched >= total」改為「server 回空 page」
- 新增 telemetry：`[MESSAGES-CURSOR] sessionID=X before=Y limit=N returned=M`

### Phase 5 — Feature flag + 驗收

- `tweaks.cfg` 加 `frontend_session_lazyload=1`。
- 建立大 session fixture（1000 msg + 3MB part）load test。
- 加入 mobile/CMS 路徑驗證：慢網路/高延遲下開長 session 先出尾端，再補歷史。
- 觀察 DELTA-PART log 壓力 / 瀏覽器 heap / Lighthouse。
- `docs/events/` 紀錄；`specs/architecture.md` 同步。

## Capabilities

### New Capabilities

- **fresh-start entry**：使用者可從 sidebar「新對話」或 `/sessions` 進入；不被 lastSession 鎖住。
- **session meta endpoint**：不拉全量訊息即可知 session 規模。
- **tail-first attach protocol**：新 frontend 連 daemon/CMS 時先附著尾端，再延遲補歷史。
- **proxy-safe replay path**：gateway → user-daemon 不再吃掉 `since`/cursor。
- **part-level fold / tail-window**：單 part 爆大時不把整段塞進 DOM。
- **rebuild-aware delta apply**：AI SDK rebuild 被辨識為 append，減少 re-render 風暴。
- **scroll-spy auto-load**：使用者不用按按鈕，捲上去自動補。

### Modified Capabilities

- `openRootSession()`：加入 meta 檢查 + 逃生入口。
- `AppInterface` / bootstrap：必須真正載入 frontend tweaks。
- `MessageTimeline`：頂端 scroll-spy；初始 attach tail-first；older history append。
- `MessagePart`：新增 size cap + streaming tail-window。
- `event-reducer.ts`：新增 rebuild-vs-append heuristic。
- `sync.tsx`：從 400 固定整包 hydration 改為依 meta 動態 + tail-first attach。

## Impact

- **Code**：§Scope IN 列出的前後端 session attach 相關檔案 + tweaks.cfg 模板。
- **API 契約**：新增 `GET /session/:id/meta`；既有 `GET /session/:id/message` 需補 replay/cursor attach contract，但不得破壞現有 `limit` 用法。
- **UX**：首次進入大 session 會更快（只載 50–100 msg）；長 tool output 多一次點擊展開；streaming 中捲回去須等完成。
- **Mobile/CMS**：session 開啟不再因完整 history hydration 卡住整條代理路徑。
- **部署**：前後端同版 + tweaks.cfg 更新。Flag 控制可個別用戶先試。
- **文件**：`specs/architecture.md` 加「Session loading strategy」段；`docs/events/event_2026-04-20_frontend-lazyload.md`。
- **相關 memory**：`feedback_repo_independent_design.md`、`feedback_tweaks_cfg.md`、`project_codex_cascade_fix_and_delta.md`、`specs/session-poll-cache/`。
