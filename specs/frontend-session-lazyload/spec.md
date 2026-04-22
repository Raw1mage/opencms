# Spec: frontend-session-lazyload

## Purpose

為 opencode webapp 定義 **前端懶載入與部件層保護** 的行為契約。保證：

- 使用者打開首頁時不會被一個過大的 session 鎖死
- 新 frontend 連 daemon/CMS 時，session 開啟採 **tail-first attach**，不是 full-history-first hydration
- 單一 part 無論多大，瀏覽器 tab 都不 OOM
- 捲動觀看歷史訊息時資料「用到才載」
- AI SDK 的 rebuild storm 不會被直接轉成 React re-render storm

## Scope

Client 層（`packages/app/`、`packages/web/`、`packages/ui/`）與 server session attach surfaces：`GET /session/:id/meta`、`GET /session/:id/message` 的 tail/catch-up contract、以及 CMS/user-daemon replay 代理。既有 API 必須 backward-compatible，但 attach flow 要改成 tail-first。

---

## Requirements

### Requirement: R1 — 首頁大 session 逃生機制

防止 `openRootSession` 強制拖入一個已知過大的 session。

#### Scenario: R1.S1 — 小 session 照常 auto-redirect

- **GIVEN** `lastSession[directory] = X` 存在
- **AND** `GET /session/X/meta` 回 `{ partCount: 30, totalBytes: 120KB }`
- **AND** tweaks.cfg 設 `session_size_threshold_kb=512` `session_size_threshold_parts=80`
- **WHEN** 使用者瀏覽 `/`（或對應 project 根目錄）
- **THEN** 直接 navigate 到 `/<dir>/session/X`

#### Scenario: R1.S2 — 超過門檻改進 /sessions 列表

- **GIVEN** `lastSession[directory] = Y` 存在
- **AND** `GET /session/Y/meta` 回 `{ partCount: 151, totalBytes: 2300000 }`
- **AND** 同上門檻
- **WHEN** 使用者瀏覽 `/`
- **THEN** navigate 到 `/<dir>/sessions`
- **AND** 顯示 toast「最後 session 較大，改顯示列表」
- **AND** console log `[lazyload] threshold-exceeded sessionID=Y parts=151 bytes=2300000`

#### Scenario: R1.S3 — meta 端點失敗明確報錯，不退回舊行為

- **GIVEN** `lastSession[directory] = Z` 存在
- **AND** `GET /session/Z/meta` 回 500
- **WHEN** 使用者瀏覽 `/`
- **THEN** navigate 到 `/<dir>/sessions` 並顯示錯誤 banner「無法判斷最後 session 狀態」
- **AND** **不得** fallback 到「直接載該 session」（AGENTS.md 第一條）

#### Scenario: R1.S4 — Sidebar 新對話按鈕

- **GIVEN** 使用者在任一頁面
- **WHEN** 點擊 sidebar 的「新對話」按鈕
- **THEN** POST `/session` 建立新 session
- **AND** navigate 到新 session 頁，不經過 `lastSession` 邏輯

---

### Requirement: R1b — Session open 必須 tail-first attach

`session.sync()` 與 CMS/user-daemon 路徑必須先附著尾端，再 lazy 補歷史；不能把 render-side lazyload 誤當成 attach protocol。

#### Scenario: R1b.S1 — 冷啟動先拿尾端頁面

- **GIVEN** 使用者開啟一個長 session
- **AND** `frontend_session_lazyload=1`
- **WHEN** frontend 首次 attach 該 session
- **THEN** 先完成 `session.get/meta`
- **AND** 只抓 tail page 供首屏 render
- **AND** **不得**先整包 hydrate 全 history 再靠 UI 只顯示最後幾則

#### Scenario: R1b.S2 — CMS proxy 不可遺失 catch-up 參數

- **GIVEN** frontend 經 CMS gateway 連 per-user daemon
- **WHEN** frontend 用 `since` 做 incremental tail fetch
- **THEN** gateway → user-daemon proxy 必須完整透傳 `since`
- **AND** 回傳結果必須與 direct-daemon 路徑等價

#### Scenario: R1b.S3 — older history append，不得 whole-slice refetch

- **GIVEN** session 已先顯示尾端頁面
- **WHEN** 使用者往上捲要求更舊的歷史
- **THEN** frontend 只 append older history slice 到現有 store
- **AND** **不得**以 `currentLimit + count` 全量重抓整段 history 假裝 lazyload

#### Scenario: R1b.S4 — tweaks bootstrap 必須真實生效

- **GIVEN** app 啟動且 server 已可用
- **WHEN** 初始化 frontend runtime
- **THEN** 必須載入 `ensureFrontendTweaksLoaded()`
- **AND** `frontend_session_lazyload` 不可長期停留在預設 `0` 而讓整套 lazyload 只存在於 dead path

---

### Requirement: R2 — Part-level size cap（已結束 part）

單一 part 大小超過 `PART_INLINE_CAP`（預設 64KB）時，預設收合。

#### Scenario: R2.S1 — 小 part 照常全文顯示

- **GIVEN** part.text.length = 10KB
- **AND** `PART_INLINE_CAP = 64KB`
- **WHEN** MessagePart mount
- **THEN** 完整 render text

#### Scenario: R2.S2 — 大 part 預設收合

- **GIVEN** part.text.length = 500KB
- **AND** part 的 message.status = "completed"（非 streaming）
- **WHEN** MessagePart mount
- **THEN** 只 render 前 N 行（由 `part_fold_preview_lines` 控制，預設 20）
- **AND** 顯示按鈕「展開全文 (500 KB)」
- **AND** DOM 字元數 ≤ `part_fold_preview_lines × 200`

#### Scenario: R2.S3 — 展開後完整顯示

- **GIVEN** R2.S2 的狀態
- **WHEN** 使用者點「展開全文」
- **THEN** 完整 render part.text 於 DOM
- **AND** 按鈕改為「收合」

#### Scenario: R2.S4 — cap 設定缺失時明確報錯

- **GIVEN** tweaks.cfg 缺少 `part_inline_cap_kb`
- **AND** runtime fallback 預設為 64KB
- **WHEN** 任一 MessagePart mount
- **THEN** console warn `[lazyload] part_inline_cap_kb missing in tweaks.cfg, using default 64KB` 一次
- **AND** 仍正常 render（使用 default，不 crash）

---

### Requirement: R3 — Streaming part tail-window

Streaming 中且超過 cap 的 part 只 render tail-window，避免 rebuild storm 累積 DOM。

#### Scenario: R3.S1 — streaming 中超 cap 只顯示尾段

- **GIVEN** part.status = "streaming"
- **AND** part.text.length = 200KB
- **AND** `PART_INLINE_CAP = 64KB`
- **WHEN** event-reducer 處理 `message.part.updated`
- **THEN** MessagePart 只 render 最後 64KB
- **AND** 畫面頂部顯示提示「streaming 中，暫顯示最後 64 KB」

#### Scenario: R3.S2 — streaming 完成後允許展開

- **GIVEN** R3.S1 的狀態
- **WHEN** 該 message.status 從 streaming 轉為 completed
- **THEN** MessagePart 轉為 R2.S2 的「收合 + 展開鈕」狀態
- **AND** 使用者可展開看完整文字

---

### Requirement: R4 — Rebuild-vs-append heuristic

`event-reducer.ts` 辨識 AI SDK 全量 rebuild，降低 React re-render。

#### Scenario: R4.S1 — 真 delta（append 模式）

- **GIVEN** 既有 part.text 長度 L
- **AND** incoming `message.part.updated` 的 `delta` 欄位有值、incoming `textLength` = L + delta.length
- **WHEN** event-reducer 處理該事件
- **THEN** `store.part[partId].text = existing + delta`
- **AND** 不觸發 reconcile 整段

#### Scenario: R4.S2 — 全量 rebuild 前綴 match

- **GIVEN** 既有 part.text 長度 L，內容 T
- **AND** incoming payload 無 delta 欄位，完整 text 長度 L+k，前 L 字元 === T
- **WHEN** event-reducer 處理該事件
- **THEN** 視同 append，`store.part[partId].text = incoming.text`
- **AND** 記錄 `[lazyload] rebuild-detected partId=X delta=k`

#### Scenario: R4.S3 — 真全量替換（非 append 模式）

- **GIVEN** 既有 part.text 與 incoming payload 前綴不 match
- **WHEN** event-reducer 處理該事件
- **THEN** 正常 replace
- **AND** 若 incoming.text.length > `PART_INLINE_CAP` 且距上次 replace < 100ms，skip 此次（以下次為主）

---

### Requirement: R5 — Scroll-spy 自動載入舊訊息

MessageTimeline 頂端 IntersectionObserver 自動觸發 `loadMore()`。

#### Scenario: R5.S1 — 捲到頂自動載入

- **GIVEN** `sync.session.history.more(sessionID) === true`
- **AND** `sync.session.history.loading(sessionID) === false`
- **WHEN** MessageTimeline 的 top-sentinel 進入 viewport
- **THEN** 呼 `sync.session.history.loadMore(sessionID)`
- **AND** 只 append older history slice
- **AND** 顯示 loading spinner 於頂端

#### Scenario: R5.S2 — 正在載入時不重複觸發

- **GIVEN** R5.S1 已觸發
- **AND** `sync.session.history.loading(sessionID) === true`
- **WHEN** top-sentinel 再次進入 viewport
- **THEN** 不再呼 `loadMore()`

#### Scenario: R5.S3 — 手動按鈕保留 fallback

- **GIVEN** IntersectionObserver 不支援（舊瀏覽器）
- **WHEN** MessageTimeline render
- **THEN** 顯示「Load Earlier」按鈕作手動 fallback

---

### Requirement: R6 — 初始 page size 動態化

依 meta.partCount 決定初次載入的 message 數。

#### Scenario: R6.S1 — 小 session 載全部

- **GIVEN** `GET /session/X/meta` 回 `partCount: 30`
- **WHEN** 首次開啟該 session
- **THEN** 仍走 tail-first attach 流程
- **AND** 可用單次 fetch 載入全部（因規模小）

#### Scenario: R6.S2 — 中 session 載 100

- **GIVEN** `partCount: 120`
- **WHEN** 首次開啟
- **THEN** 呼 `session.messages({ limit: initial_page_size_medium })`（預設 100）
- **AND** 首屏只需等待該 tail page，不等待更舊歷史

#### Scenario: R6.S3 — 大 session 載 50

- **GIVEN** `partCount: 400`
- **WHEN** 首次開啟
- **THEN** 呼 `session.messages({ limit: initial_page_size_large })`（預設 50）
- **AND** 更舊歷史由 R1b.S3 / R5 路徑 lazy 補齊

---

### Requirement: R7 — Feature flag 切換

`frontend_session_lazyload=0` 時完全退回目前行為。

#### Scenario: R7.S1 — Flag off

- **GIVEN** tweaks.cfg 設 `frontend_session_lazyload=0`
- **WHEN** 任何頁面載入
- **THEN** R1–R6 全部停用，行為同主線現狀（messagePageSize=400、無 part cap、無 scroll-spy、無 meta 呼叫）

#### Scenario: R7.S2 — Flag on

- **GIVEN** tweaks.cfg 設 `frontend_session_lazyload=1`
- **WHEN** 任何頁面載入
- **THEN** R1–R6 與 R1b 全部啟用

---

### Requirement: R8 — SSE reconnect bounded replay (G9, ADDED 2026-04-22 revise)

SSE 重連握手時，server 不得把 ring buffer 的所有事件串行 `await stream.writeSSE` 送出。必須先裁切到時間窗口（`sse_reconnect_replay_max_age_sec`）+ 數量窗口（`sse_reconnect_replay_max_events`），窗口外的缺口改發 `sync.required`。

#### Scenario: R8.S1 — buffer 內、窗口內 → 照送

- **GIVEN** client `Last-Event-ID=X`，ring buffer 內有 `X+1..X+20` 共 20 筆事件，皆 < `max_age_sec` 秒內
- **AND** tweaks `sse_reconnect_replay_max_events=100`、`sse_reconnect_replay_max_age_sec=60`
- **WHEN** client 重連發握手
- **THEN** server `writeSSE` 20 筆事件，不送 `sync.required`
- **AND** log 一行 `[SSE-REPLAY] lastId=X returned=20 dropped=0 boundary=none`

#### Scenario: R8.S2 — 超過數量窗口 → 裁切 + sync.required

- **GIVEN** client `Last-Event-ID=X`，ring buffer 有 `X+1..X+500` 共 500 筆事件
- **AND** `sse_reconnect_replay_max_events=100`
- **WHEN** client 重連發握手
- **THEN** server 只送最後 100 筆（`X+401..X+500`）
- **AND** 先送一筆 `sync.required` 讓 client 觸發全量再同步
- **AND** log 一行 `[SSE-REPLAY] lastId=X returned=100 dropped=400 boundary=count`

#### Scenario: R8.S3 — 超過時間窗口 → 只送 fresh 的

- **GIVEN** client `Last-Event-ID=X`，ring buffer 有 30 筆事件，其中 25 筆 `receivedAt > max_age` 前、5 筆 fresh
- **WHEN** client 重連
- **THEN** server 只送 5 筆 fresh 事件 + 前置 `sync.required`
- **AND** log `[SSE-REPLAY] lastId=X returned=5 dropped=25 boundary=age`

#### Scenario: R8.S4 — buffer 早已 shift 掉 `lastId`（既有行為保留）

- **GIVEN** client `Last-Event-ID=X`，但 ring buffer 最舊 id 已 > X+1
- **WHEN** client 重連
- **THEN** server 回 `sync.required`（維持原 `sseGetSince` 回 null 語意）
- **AND** log `[SSE-REPLAY] lastId=X returned=0 dropped=all boundary=count`（lastId 超出可 replay 範圍）

#### Scenario: R8.S5 — 禁止 unbounded writeSSE

- **GIVEN** 任何 reconnect 情境
- **WHEN** handshake 開始
- **THEN** 實際 `await stream.writeSSE` 次數 **必須** ≤ `max_events + 1`（+1 是 `sync.required`）
- **AND** 無論 buffer 多大，event loop 不得被單一握手佔用超過 `max_events` 個連續 await

---

### Requirement: R9 — session.messages cursor pagination (G10, ADDED 2026-04-22 revise)

`GET /session/:id/message` 預設回 tail；older history 改由 `beforeMessageID` cursor append。`limit` 語意從「整包上限」變「本頁筆數」。CMS/user-daemon proxy 必須完整透傳新參數。前端 `history.loadMore()` 不得再用「擴大 limit 全量重抓」假裝 lazyload。

#### Scenario: R9.S1 — 無 cursor → 回 tail

- **GIVEN** session `S` 有 500 messages，tweaks `session_messages_default_tail=30`
- **WHEN** client 呼 `GET /session/S/message`（無 `beforeMessageID`、無 `limit`）
- **THEN** server 回最新 30 則（created DESC 最新 30 筆）
- **AND** log `[MESSAGES-CURSOR] sessionID=S before=null limit=30 returned=30`

#### Scenario: R9.S2 — 給 cursor → 回比它舊的

- **GIVEN** client 已載入最新 30 則，其中最舊的 `messageID=M30`
- **WHEN** client 呼 `GET /session/S/message?beforeMessageID=M30&limit=30`
- **THEN** server 回 created < M30.created 的最新 30 則（即 M31..M60 in older direction）
- **AND** log `[MESSAGES-CURSOR] sessionID=S before=M30 limit=30 returned=30`

#### Scenario: R9.S3 — 沒有更舊的了

- **GIVEN** client 已載到 session 最早的 message `M500`
- **WHEN** client 呼 `GET /session/S/message?beforeMessageID=M500`
- **THEN** server 回 `[]`
- **AND** 前端將 `history.complete=true`，停止 scroll-spy 觸發

#### Scenario: R9.S4 — CMS/user-daemon proxy 完整透傳

- **GIVEN** client 經 CMS gateway + per-user daemon 路徑呼 `beforeMessageID=M30`
- **WHEN** gateway → daemon 轉發
- **THEN** daemon 收到的 query 必須包含完整 `beforeMessageID`（**現有 since 參數也不得再遺失**）
- **AND** 日誌可直接驗證（daemon structured log 看得到 `beforeMessageID=M30`）

#### Scenario: R9.S5 — 向後相容

- **GIVEN** 舊 client 只送 `limit=100`，無 `beforeMessageID`
- **WHEN** server 處理
- **THEN** 回最新 100 則（等同無 cursor 的 tail 分支，只是 limit 被 override）
- **AND** 不破壞任何既有消費者

#### Scenario: R9.S6 — 前端 loadMore 必須 append

- **GIVEN** 前端 `sync.data.message[S] = [M1..M30]`（最新 30 則）
- **WHEN** `history.loadMore(S)` 觸發
- **THEN** 前端打 `beforeMessageID=M1`（目前 oldest）
- **AND** 回來的 messages **append 到 store 前端**，不是整包 replace（[sync.tsx:505-520](packages/app/src/context/sync.tsx#L505-L520)）
- **AND** `history.complete` 只有在 server 回空 page 時才設 true

---

## Acceptance Checks

- 建一個有 1000 messages + 單 part 3MB 的 fixture session。
- Flag on + 首頁進入 → 導向 `/sessions`（R1.S2）。
- Flag on + 經 CMS 打開長 session → 先出尾端頁面，再 lazy 補歷史（R1b.S1–S3）。
- 點 session → 5 秒內首屏顯示最後 50 messages（R6.S3）。
- 捲到頂自動補資料（R5.S1），全程無 Layout Shift 超過 50ms。
- 大 part 預設收合，展開後可閱讀（R2.S2/S3）。
- Streaming 中 tail-window 正確顯示，completed 後可展開（R3.S1/S2）。
- DELTA-PART log 頻率與 flag off 對照 → re-render 次數減少至少 50%（R4）。
- `ensureFrontendTweaksLoaded()` bootstrap 實際執行，lazyload flag 不為 dead path（R1b.S4）。
- Flag off 行為與主線 hash `<TBD>` 一致（R7.S1）。
- **R8 驗收**：塞滿 1000 events ring buffer → 模擬 reconnect lastId=第 5 筆 → 驗證實際 `writeSSE` 次數 ≤ 101，且握手完成時間 < 200ms；log 正確印 `[SSE-REPLAY]` 帶 dropped count/boundary。
- **R9 驗收**：1000-message session；預設 `GET /:id/message` 回 30 筆；`beforeMessageID=<oldest>` 連續 append 到底；CMS proxy 路徑 daemon log 看得到 `beforeMessageID` 參數；前端 `history.loadMore()` 不再觸發 whole-slice refetch。
