# Tasks: frontend-session-lazyload

Canonical execution checklist。每個 task 對到 spec 的 Requirement + C4/IDEF0 的 module。進入 `implementing` 後由 TodoWrite 逐 phase 載入。

---

## 1. Server 端 meta endpoint + SessionCache 擴充

- [x] 1.1 `packages/opencode/src/server/session-cache.ts` 新增 `meta` 命名空間 — cache key `session:{id}:meta`，與既有 version counter 掛勾（Bus event invalidation 範圍一併 cover meta） [R1, DD-1, CMP9]
- [x] 1.2 `packages/opencode/src/server/routes/session.ts` 新增 `GET /:sessionID/meta` handler — 回 `SessionMetaResponse`（data-schema.json），支援 `If-None-Match` 304；meta 計算走 `Storage.sessionStats`（純 fs stat，不 parse JSON 內容） [R1.S1, CMP8]
- [x] 1.3 新增 `packages/opencode/test/server/session-meta.test.ts` — 5 tests pass：fresh session meta / 304 If-None-Match / INV-1 ETag 同步 / metaKey canonical form / unknown sessionID 非 200
- [x] 1.4 OpenAPI `session.meta` operationId 已確認出現於 `/tmp/openapi-test.json`；SDK regen 由下游 build script 處理

## 2. tweaks.cfg 新 keys + TweaksLoader

- [x] 2.1 `packages/opencode/src/config/tweaks.ts` 新增九組 key + `FrontendLazyloadConfig` + `Tweaks.frontendLazyload()` getter；INV-7 clamp（tail_window > cap 自動降到 cap 並 warn） [R7, CMP11]
- [x] 2.2 `templates/system/tweaks.cfg` 加九組 key + 註解 + 預設 `frontend_session_lazyload=0`
- [x] 2.3 `GET /config/tweaks/frontend` route 新增於 `packages/opencode/src/server/routes/config.ts`；沿用既有 `/config` mount
- [x] 2.4 Client-side reader **deferred 到 §3.3**（避免寫 dead code；在 openRootSession 重寫時一併做）
- [x] 2.5 Tests：tweaks.ts 8 new tests（17 total pass），frontend-tweaks-route.ts 2 tests pass — covers defaults / overrides / INV-7 clamp / invalid flag / 'all' keyword

## 3. Escape hatch — Sidebar + /sessions + openRootSession

- [ ] 3.1 Sidebar 常駐「新對話」按鈕 — `packages/app/src/pages/layout.tsx` 加按鈕；click → POST `/session` → navigate 新 session id [R1.S4, CMP2]
- [ ] 3.2 `/sessions` 路由 — 新增 `packages/app/src/pages/sessions.tsx` 顯示 session 列表，不 auto-redirect；共用既有 sidebar session list UI 的 component 即可 [R1.S2, CMP3]
- [ ] 3.3 `openRootSession()` 改寫 — flag=1 時 pre-redirect 呼 `session.meta`；超過門檻或失敗走 `/sessions` + toast；flag=0 時維持原 lastSession 邏輯 [R1.S1–S3, CMP1, DD-2, DD-9]
- [ ] 3.4 Telemetry — 呼 meta / 超門檻 / 失敗皆發 `LazyloadTelemetryEvent`（data-schema.json 定義）

## 4. Part-level size cap + fold UI

- [ ] 4.1 `packages/ui/src/components/message-part.tsx` — text / tool output / reasoning 分支加「length > cap → 顯示前 N 行 + 展開鈕」邏輯（只處理 `status=completed` 的 part） [R2, CMP6]
- [ ] 4.2 展開／收合狀態 per-part 本地管理（使用 Solid signal），展開後 render full text
- [ ] 4.3 `packages/ui/test/message-part-cap.test.tsx` — 覆蓋 < cap 全顯 / > cap 收合 / 展開後全顯 / cap 缺失 fallback 四情境
- [ ] 4.4 與既有 subagent / nested agent 區塊 UI 的互動（確保 nested 內 part 也受 cap；但不加 nested virtualization）

## 5. Streaming tail-window + rebuild heuristic

- [ ] 5.1 `packages/web/src/event-reducer.ts` — `message.part.updated` 處理加 heuristic：若 `!delta && incoming.text.length > existing.length` 且前 1024 字元 match → 視同 append，以 incoming.text 取代（實際等同 append）；記錄 `[lazyload] rebuild-detected` [R4.S1/S2, CMP7, DD-5]
- [ ] 5.2 Event-reducer 同檔加 tail-window 截斷：若 incoming.text.length > tail_window_kb 且 message.status="streaming" → 只留最後 N KB 到 store，`store.part[id].truncatedPrefix = incoming.text.length - N×1024`；streaming 結束時不自動復原 [R3.S1, DD-4]
- [ ] 5.3 `MessagePart` 讀 `truncatedPrefix > 0 && status==="streaming"` → render 「streaming 中，暫顯示最後 N KB」banner + tail 內容 [R3.S1, CMP6]
- [ ] 5.4 Streaming 完成（status → completed）且 `truncatedPrefix > 0` → UI 切換到「收合 + 展開鈕」；展開時需 fetch full part（複用既有 part read path） [R3.S2]
- [ ] 5.5 `packages/web/test/event-reducer-rebuild.test.ts` 覆蓋 rebuild-detected / mismatch / tail-window 三情境

## 6. Scroll-spy 自動載入 + 動態 initial page size

- [ ] 6.1 `packages/app/src/context/sync.tsx` — `messagePageSize` 改為 `pageSizeFor(partCount)` function，讀 tweaks `initial_page_size_{small,medium,large}`；首次 fetch 前如缺 meta 則先呼 meta [R6, CMP4, DD-7]
- [ ] 6.2 `MessageTimeline` 頂端加 hidden `<div ref={sentinel}>` + `IntersectionObserver(rootMargin="400px 0px 0px 0px")`；只在 `autoScroll.mode === "free-reading"` 時 observe [R5, CMP5, DD-6]
- [ ] 6.3 Sentinel 進 viewport + `history.more=true` + `loading=false` → 呼 `history.loadMore(sessionID)`；loading 期 unobserve
- [ ] 6.4 保留既有「Load Earlier」按鈕作 fallback（R5.S3）
- [ ] 6.5 `packages/app/test/scroll-spy.test.ts`（若有 Solid 測試基礎）— 覆蓋觸發 / loading 期不重複 / complete 後停用

## R1. SSE reconnect bounded replay (G9, ADDED 2026-04-22 revise)

- [x] R1.1 `packages/opencode/src/server/routes/global.ts` — `_sseBuffer` entry 加 `receivedAt: number`；`ssePush` 補 `receivedAt: Date.now()`
- [x] R1.2 新增 `sseGetBoundedSince(lastId, maxEvents, maxAgeMs, now)` 純函式 + 單元測試；回 `{ events, droppedCount, droppedBoundary: "count" | "age" | null }`
- [x] R1.3 `global.ts` handshake 改用 `sseGetBoundedSince`；若 `droppedCount > 0` 或 `sseGetSince` 回 null → 先發 `sync.required` 再送事件
- [x] R1.4 新增 tweaks keys：`sse_reconnect_replay_max_events` (預設 100)、`sse_reconnect_replay_max_age_sec` (預設 60)；走 `/config/tweaks/frontend` + fallback
- [x] R1.5 Telemetry：`[SSE-REPLAY] lastId=X returned=N dropped=M boundary={count|age|none}` 每次 handshake 印一行
- [x] R1.6 整合測試：mock 塞滿 1000 events → 模擬 reconnect → 驗證實際 writeSSE 次數 ≤ max_events + 1 (sync.required)

## R2. session.messages cursor pagination (G10, ADDED 2026-04-22 revise)

- [x] R2.1 `packages/opencode/src/server/routes/session.ts` — `GET /:sessionID/message` schema 加 optional `beforeMessageID`；handler 分兩路：有 cursor → 回比它舊的 N 筆 / 沒 cursor → 回 tail N 筆；`session_messages_default_tail` 從 tweaks 讀（預設 30）
- [x] R2.2 SessionCache key 擴充為 `messages:{id}:{beforeMessageID ?? "tail"}:{limit}`；invalidation 規則同現有 message bus event
- [x] R2.3 `packages/opencode/src/server/user-daemon/manager.ts` — `callSessionMessages` 完整透傳 `beforeMessageID` + `since` + `limit`；確認 CMS proxy path 不丟失
- [x] R2.4 `packages/app/src/context/sync.tsx` — `history.loadMore()` 改為讀目前 oldest `messageID` → GET `beforeMessageID=<oldest>`，回來的 messages **append 到現有 store**（不是整包 replace）
- [x] R2.5 `sync.tsx` meta 追蹤：`history.complete` 條件改為「server 回 < limit 或空 page」；移除 `currentLimit + count` 重抓邏輯
- [x] R2.6 `tweaks.cfg` 加 `session_messages_default_tail=30`；fallback 落在 [config/tweaks.ts](packages/opencode/src/config/tweaks.ts)
- [x] R2.7 Telemetry：`[MESSAGES-CURSOR] sessionID=X before=Y limit=N returned=M` 每次 fetch 印
- [x] R2.8 向後相容驗證：沒送 `beforeMessageID` 的舊 client 行為須等同「回最新 limit 筆」

## 7. Feature flag rollout + 驗收

- [ ] 7.1 所有 §3–§6 程式碼用 `flag === 1` 守護；flag=0 時行為必須與主線現狀 byte-by-byte 等價（除了新端點存在但不被呼叫）
- [ ] 7.2 建立大 session fixture — script 自動生成 1000 messages + 單 part 3MB，commit 到 `packages/app/test/fixtures/` 或 daemon 測試 harness
- [ ] 7.3 Load test：flag on/off 各跑一次，量瀏覽器 heap 高點、DELTA-PART log 數量、Lighthouse TTI
- [ ] 7.4 `docs/events/event_2026-04-20_frontend-lazyload.md` 撰寫 — 決策、量測結果、rollout plan
- [ ] 7.5 `specs/architecture.md` 加「Session loading strategy: meta-first + paginated + part-capped」段
- [ ] 7.6 灰度切換：個別帳號 flag=1 一週，無回報 regression 再改 tweaks.cfg 預設
- [ ] 7.7 移除 flag 與舊路徑（rollout 第 4 週） — 獨立 PR

---

## Phase execution order

Phase 1 = §1 + §2（server 基礎，不影響既有行為）
Phase 2 = §3（hotfix，flag on 即可救急）
Phase 3 = §4 + §5（part 層保護，解 OOM 核心）
Phase 4 = §6（scroll-spy + 動態 page size）
Phase R1 = §R1（SSE bounded replay — 獨立於 Phase 1-4，可先做：唯一解握手飢餓）
Phase R2 = §R2（messages cursor — 解開 session 登入卡住；需在 Phase 2 tail-first attach 之前或並行）
Phase 5 = §7（rollout）

**建議 revise 後的執行順序**：R1 → R2 → 其餘 1-4 → 5。R1+R2 拿掉根因，之後的 render-side lazyload 才有意義。

§1–§6 內可並行做但不跨 phase。每個 phase 完成後執行 `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/frontend-session-lazyload/`，依 drift 決定下一步（plan-builder §16.3）。
