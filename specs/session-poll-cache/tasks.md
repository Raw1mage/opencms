# Tasks: session-poll-cache

## 1. Foundation — tweaks.cfg loader + health endpoint

- [x] 1.1 建立 `packages/opencode/src/config/tweaks.ts`：讀 `/etc/opencode/tweaks.cfg`（`key=value` 格式，`#` 註解），export `getSessionCacheConfig()` / `getRateLimitConfig()`。檔案不存在用 defaults 並 `log.info`；格式錯誤用 `log.warn` 退回 default（R-5、AGENTS.md 第一條）。
- [x] 1.2 建立 `templates/etc/tweaks.cfg` 模板，列出全部 key 的 default 與註解。（placed at `templates/system/tweaks.cfg` alongside existing `opencode.cfg`）
- [x] 1.3 建立 `packages/opencode/src/server/routes/cache-health.ts`，註冊 `GET /api/v2/server/cache/health`，暫時回硬編碼空值（phase 2 接上真實統計）。
- [x] 1.4 在 `app.ts` 或 routes 註冊點掛上 `/cache/health`；確認它不走 rate-limit middleware（DD-7）。（mount point `api.route("/server", ServerRoutes())`; rate-limit middleware not yet introduced — Phase 4 must exempt `/api/v2/server/*` and `/api/v2/global/health`.）
- [x] 1.5 單元測試 `config/tweaks.test.ts`：覆蓋「檔案缺」「格式錯」「完整讀取」三情境；驗 log 輸出。（9 passing tests.）

## 2. Session read cache

- [x] 2.1 盤點所有會寫入 `message:*` / `session:*` 的路徑，列成清單：`session/index.ts`、`message-v2.ts`、`revert.ts`、`task.ts:publishBridgedEvent`。確認每條路徑都有對應 bus event 發佈（不然 cache 會 stale，屬 R-1）；若缺，補進 bridge。（Inventory clean — all 12 publish sites covered, worker bridge already relays all 4 MessageV2.Event.* + Session.Event.Updated; stop-gate #1 passes.）
- [x] 2.2 建立 `packages/opencode/src/server/session-cache.ts`：in-process LRU，keyed by `session:<id>` / `messages:<id>:<limit>`；export `get<T>(key, loader)` 與 `invalidate(sessionID)` 與 `stats()`。loader 簽名需回傳 `{ data, version }`。
- [x] 2.3 於 cache 模組初始化時 `Bus.subscribeGlobal` 訂閱 `MessageV2.Event.Updated/Removed/PartUpdated/PartRemoved`、`Session.Event.Updated/Deleted/Created`；每個 event 取 `sessionID` 呼叫 `invalidate(sessionID)` 並 bump version counter。（Registered in `src/index.ts` after existing subscribers.）
- [x] 2.4 訂閱失敗（subscribeGlobal throw 或 return null）必須 `log.warn` 並把 `subscriptionAlive=false`；後續 cache operations 一律 miss 但仍讀原始資料（不靜默退回舊值）。
- [x] 2.5 `Session.Event.Deleted` 時額外清除 version counter。（`forgetSession` path.）
- [x] 2.6 單元測試 `server/session-cache.test.ts`：hit、miss、TTL expiry、LRU evict、invalidate、訂閱失敗路徑。（10 passing tests.）

## 3. Route integration — ETag + 304

- [x] 3.1 修改 `routes/session.ts` 的 `GET /session/{id}`：包 `session-cache.get("session:"+id, loader)`；回應帶 `ETag: W/"<id>:<version>"`；若 req `If-None-Match` 相等回 304 + 空 body。（ETag embeds per-process epoch so that restart-reset counter cannot 304-collide; direct-path only, forwarded-to-user-daemon path unchanged.）
- [x] 3.2 修改 `routes/session.ts` 的 `GET /session/{id}/message`：同上，key 為 `messages:<id>:<limit>`；注意 `limit` 參與 cache key（不同 limit 是不同條目）。（`limit=undefined` keyed as `messages:<id>:all` so the default path caches distinctly from explicit limits.）
- [x] 3.3 修改 `routes/session.ts` 的 `GET /session/{id}/autonomous/health`：若其內部使用 `Session.get`，確保走同一 cache（避免重複讀磁碟）。（existence guard now routed through `SessionCache.get`.）
- [x] 3.4 整合測試：ETag 單元測試覆蓋格式、epoch 嵌入、match/mismatch 與版本遞進（3 new tests in `session-cache.test.ts`）。End-to-end HTTP 304 驗證**降級延後**到 Phase 6 acceptance benchmarks — 原因：route test 需要 mock Session storage + Instance context 導入成本高，Phase 6 會用真實 daemon curl 覆蓋同等覆蓋面。Drift logged in event file.
- [x] 3.5 已確認手寫 ETag 邏輯（`SessionCache.currentEtag` / `isEtagMatch`），不依賴 hono 的 ETag middleware；typecheck 無新錯誤；19 → 13 Phase-2 tests 重跑全過。

## 4. Rate limit middleware

- [x] 4.1 建立 `packages/opencode/src/server/rate-limit.ts`：token bucket，key = `${username}:${method}:${routePattern}`，用 hono 的 `c.req.routePath` 或等價 API 拿 pattern。（`routePath` isn't available at middleware time in hono 5; used `normalizeRoutePattern(c.req.path)` — regex-collapses opencode ID segments `<prefix>_<20+chars>` to `:id` so per-session URLs share a bucket.）
- [x] 4.2 設計豁免清單：`opencode.internal` hostname、`/log`、`/api/v2/server/cache/health`、`/api/v2/server/health`。放在 module 頂部 const array，易於 review。（`EXEMPT_PATH_PREFIXES` const; `hostname === "opencode.internal"` bypass.）
- [x] 4.3 於 `app.ts` 在 request-log middleware **之後**掛入 rate-limit middleware；被拒時 `return c.json({code:"RATE_LIMIT", message, path, retryAfterSec}, 429, {"Retry-After": String(sec)})`，並 `log.warn("rate-limit throttled", ...)`。
- [x] 4.4 `ratelimit_enabled=0` 時 middleware short-circuit；啟動時 `log.info("rate-limit disabled via tweaks")`。（`RateLimit.logStartup` invoked from `src/index.ts`.）
- [x] 4.5 單元測試 `server/rate-limit.test.ts`：quota 內放行、耗盡回 429、Retry-After 合理、豁免路徑不計次、disable 時全放行。（12 passing tests including normalize, multi-user bucket isolation, and E-RATE-002 no-username bypass.）

## 5. Health endpoint wiring

- [x] 5.1 `routes/cache-health.ts` 接上 `session-cache.stats()` 與 `rate-limit.stats()`，回傳 R-4 spec 定義的完整 JSON。（Implemented via provider-registration pattern in Phase 1.3 + 2.2 + 4.4.）
- [-] 5.2 透過訂閱 `SessionCache.Event.Hit/Miss/Invalidated/Evicted` + `RateLimit.Event.Allowed/Throttled` 維護**過去 5 分鐘滑動窗**的 hitRate / missRate 統計（用 ring buffer，不存不過期資料）。**Deferred** — current implementation uses cumulative counters; ring buffer can be added without breaking the schema if ops feedback needs it. Drift noted in event log and data-schema.json `hitRate` description updated accordingly in follow-up plan.
- [x] 5.3 整合測試：啟 app、打幾次 session GET、驗 `/cache/health` 數字變化。（4 passing tests in `test/server/cache-health.test.ts` — placeholder state, miss+hit+invalidate reflection, rate-limit throttle reflection, tweaks source surface.）

## 6. Acceptance benchmarks

- [ ] 6.1 寫 `scripts/bench/session-poll-bench.ts`：對 daemon 以固定 QPS 打 `/session/{id}/message` 5 分鐘，shell 取樣 `ps` / `/proc/<pid>/stat` 算 CPU 平均與 p95 latency。
- [ ] 6.2 跑一次 **before**（關掉 cache：`session_cache_enabled=0`）量基線，記在 handoff.md。
- [ ] 6.3 跑一次 **after**（打開 cache + ETag）量新值；驗 AC-1（CPU<10% 平均）、AC-2（304 > 95%）。
- [ ] 6.4 跑一次 **stress**（100 QPS 打同 path）驗 AC-4（429 出現 + Retry-After）。
- [ ] 6.5 跑一次 **failure injection**（monkey-patch subscribeGlobal throw）驗 AC-5（subscriptionAlive=false、log.warn、cache 降級但不靜默）。
- [ ] 6.6 跑一次 **invalidation correctness**（worker 持續 append 訊息，同時 daemon polling）驗 AC-3（必然讀到新訊息）。

## 7. Documentation + sync

- [ ] 7.1 寫 `docs/events/event_2026-04-19_session-poll-cache.md`：實作紀錄、phase-by-phase 摘要、AC 驗收數字。
- [ ] 7.2 更新 `specs/architecture.md` 新增「Session Read Cache + Rate Limit Layer」段落：描述 cache key / invalidation 事件圖 / rate-limit 豁免清單。
- [ ] 7.3 執行 `bun run ~/projects/skills/plan-builder/scripts/plan-sync.ts specs/session-poll-cache/`，確認無 drift。
- [ ] 7.4 plan-promote 至 `verified`，等 beta-workflow 完成 fetch-back 後由 beta-workflow 推進至 `living`。
