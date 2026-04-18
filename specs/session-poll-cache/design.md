# Design: session-poll-cache

## Context

本 plan 針對 daemon 的兩個熱點 HTTP 端點 `/api/v2/session/{id}` 與 `/api/v2/session/{id}/message`。它們被前端以 2–3 秒週期輪詢；後端實作 `Session.get` 與 `Session.messages`（後者透過 `MessageV2.stream` 逐檔讀）每次都走完整磁碟 I/O。

Session 寫入主要發生在 worker 程序（LLM 回覆流寫入 `Storage.write`），並透過 `publishBridgedEvent`（[task.ts:371-409](../../packages/opencode/src/tool/task.ts#L371-L409)）把 `MessageV2.Event.*` 與 `Session.Event.Updated` 跨程序轉發到 daemon 的本地 bus。這讓 in-daemon cache + bus-driven invalidation 成為可行解法，不需另造 IPC。

## Goals / Non-Goals

### Goals

- 對 polling 路徑將 daemon CPU 負擔壓到近常數。
- 保持 `Session.get/messages` 既有公開行為（回傳型別、錯誤語意不變）。
- 符合 AGENTS.md 第一條「禁止靜默 fallback」：所有失敗路徑必須明確 log。

### Non-Goals

- 不改 `MessageV2.stream` 本身的磁碟存取。
- 不跨 daemon instance 分散式 cache。
- 不引入外部 cache 套件。

## Decisions

- **DD-1** In-process LRU cache for `Session.get` + `Session.messages`. Key schema：`session:<id>` / `messages:<id>:<limit>`。Entry shape：`{ data, etagVersion, createdAt, accessAt }`。TTL + max-entries 皆走 tweaks.cfg。(2026-04-19)

- **DD-2** Invalidation 透過訂閱 daemon 本地 bus 的 `MessageV2.Event.Updated/Removed/PartUpdated/PartRemoved`、`Session.Event.Updated/Deleted/Created`；事件 → 解出 `sessionID` → drop `session:<id>*` 與 `messages:<id>*` 所有 keys。跨程序寫入已由 `publishBridgedEvent` 轉發，故 cache 不需自己處理 IPC。(2026-04-19)

- **DD-3** ETag 使用 weak ETag，格式 `W/"<sessionID>:<version>"`，`version` 為每個 sessionID 維護的**單調遞增計數器**，在以下事件 +1：`MessageV2.Event.*`、`Session.Event.Updated/Created`。`Session.Event.Deleted` 清除計數器。選 weak ETag 理由：cache body 並非嚴格 bit-identical（JSON 序列化可能有欄位順序差異）。(2026-04-19)

- **DD-4** Rate-limit 採 **per-(username, method, routePattern) token bucket**。key 用 `routePattern` 而非原始 URL，避免不同 sessionID 各自分桶；pattern 由 hono 的 matched route 取得。預設 `ratelimit_qps_per_user_per_path=10`、`ratelimit_burst=20`。被拒時回 `429 + Retry-After + JSON code=RATE_LIMIT`。(2026-04-19)

- **DD-5** Cache 與 rate-limit 各自獨立 module，放在 `packages/opencode/src/server/session-cache.ts` 與 `packages/opencode/src/server/rate-limit.ts`，被 `app.ts` middleware 與 `session/index.ts` import。**不**侵入 `Session.messages` 函式本體，而是在 `routes/session.ts` 層包一層讀 cache。這樣 `Session.messages` 仍可用於 rate-limit 豁免、直接內部呼叫。(2026-04-19)

- **DD-6** Tunables 放 `/etc/opencode/tweaks.cfg`（目前尚不存在，本 plan 會新建模板 + loader）。Loader 統一在 `packages/opencode/src/config/tweaks.ts`，export 強型別 getters + 啟動時 log 一次實際生效值。(2026-04-19)

- **DD-7** `GET /api/v2/server/cache/health` 新增 route，回傳 cache + rate-limit 運作狀態。不走 rate-limit 自身（避免 feedback loop）。用於 ops 與 AC-5 驗收。(2026-04-19)

- **DD-8** 既有 middleware log（app.ts:198-215）**不變**，rate-limit 做成**獨立 middleware**，在 logging middleware **之後**、路由匹配**之前**執行，以確保 429 也會被 log.info "request" 記一行。(2026-04-19)

- **DD-9** 所有快取 / invalidation 事件透過既有 `Bus` 發佈，不自製 counter store。`/cache/health` 端點讀 `Bus` 的滑動窗聚合值（借用 telemetry-runtime 訂閱者即可統計）。(2026-04-19)

## Risks / Trade-offs

- **R-1** 跨程序事件遺失：若 `publishBridgedEvent` 未涵蓋某種寫入路徑（例如 revert.ts 有 `Bus.publish(MessageV2.Event.Removed)`，需確認該路徑是否發生在 worker 內），則 cache 可能 stale。
  - **Mitigation**：設計階段列出所有寫入點（tasks Phase 2 盤點）；未覆蓋的補進 bridge；測試 `AC-3` 必須 cover worker 路徑。

- **R-2** LRU 擠掉熱條目：長期執行下若條目暴增超過 max_entries，近期熱門 session 可能被擠出。
  - **Mitigation**：預設 500 entries 足夠涵蓋單人多工作區；`/cache/health` 揭露 entries 數，超過時 ops 可調 `session_cache_max_entries`。

- **R-3** ETag version counter 遺失：daemon 重啟後 counter 歸零，前端持有的 `W/"S:42"` 會被視為 mismatch（200 正常回覆）。
  - **Mitigation**：這是可接受降級（重啟 → 一次 full refresh）；不持久化 counter。

- **R-4** Rate limit 對某個誠實的前端誤擋：10 QPS × burst 20 對手動點擊夠用，對批次化 tool 可能不夠。
  - **Mitigation**：batch 類呼叫走 `opencode.internal` hostname 已豁免；tweaks.cfg 可臨時調高；429 回應明確告知 path + retryAfter，前端能本地退避。

- **R-5** `Session.get` 有可能被寫入路徑呼叫（self-read-after-write）：若剛 update 完 → cache miss → 磁碟讀到舊值（write 還在 fsync 中）；但我們是寫完後才 publish，publish 又會 invalidate，所以這個 race 只在 update→get 同 tick 內且 get 發生在 publish 之前。
  - **Mitigation**：`Session.update` 內的 `await Storage.write` 在 `Bus.publish` 之前；in-process 同 tick 內 await 完成才 publish；cache 清除也在同 tick。對其他 process 的 race 忽略（反正要 ETag re-check）。

## Critical Files

### 要新增

- `packages/opencode/src/server/session-cache.ts` — cache module（LRU + bus invalidation + health stats）
- `packages/opencode/src/server/rate-limit.ts` — token bucket + middleware
- `packages/opencode/src/config/tweaks.ts` — tweaks.cfg loader
- `packages/opencode/src/server/routes/cache-health.ts` — `/api/v2/server/cache/health` route
- `templates/etc/tweaks.cfg` — 預設 tunables 模板（部署時拷貝至 `/etc/opencode/tweaks.cfg`）
- `packages/opencode/test/session-cache.test.ts` — 單元測試
- `packages/opencode/test/rate-limit.test.ts` — 單元測試
- `packages/opencode/test/session-poll-integration.test.ts` — 整合測試（打 HTTP + 驗 304 + 驗 invalidation）
- `scripts/bench/session-poll-bench.ts` — AC-1/AC-2 驗收量測腳本

### 要修改

- `packages/opencode/src/server/app.ts` — 掛載 rate-limit middleware
- `packages/opencode/src/server/routes/session.ts` — 在 `/session/{id}` + `/message` 端點前讀 cache、設 ETag、回 304
- `packages/opencode/src/server/routes/index.ts`（或 routes 註冊點）— 註冊 `/cache/health`
- `packages/opencode/src/session/index.ts` — `Session.get` / `Session.messages` 內部不動；由 route 層包 cache（DD-5）
- `docs/events/event_2026-04-19_session-poll-cache.md` — 實作紀錄
- `specs/architecture.md` — 新段落「Session Read Cache + Rate Limit Layer」

### 必讀（不修改）

- `packages/opencode/src/tool/task.ts:371-409` — `publishBridgedEvent` 的覆蓋範圍
- `packages/opencode/src/session/message-v2.ts:1310-1340` — 寫入路徑的 bus publish 點
- `packages/opencode/src/session/index.ts:477-560` — Session.update 的 bus publish 時機
- `packages/opencode/src/bus/index.ts:188-204` — `subscribeGlobal` 語意
