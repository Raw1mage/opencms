# Tasks: session-poll-cache

## 1. Foundation — tweaks.cfg loader + health endpoint

- [ ] 1.1 建立 `packages/opencode/src/config/tweaks.ts`：讀 `/etc/opencode/tweaks.cfg`（`key=value` 格式，`#` 註解），export `getSessionCacheConfig()` / `getRateLimitConfig()`。檔案不存在用 defaults 並 `log.info`；格式錯誤用 `log.warn` 退回 default（R-5、AGENTS.md 第一條）。
- [ ] 1.2 建立 `templates/etc/tweaks.cfg` 模板，列出全部 key 的 default 與註解。
- [ ] 1.3 建立 `packages/opencode/src/server/routes/cache-health.ts`，註冊 `GET /api/v2/server/cache/health`，暫時回硬編碼空值（phase 2 接上真實統計）。
- [ ] 1.4 在 `app.ts` 或 routes 註冊點掛上 `/cache/health`；確認它不走 rate-limit middleware（DD-7）。
- [ ] 1.5 單元測試 `config/tweaks.test.ts`：覆蓋「檔案缺」「格式錯」「完整讀取」三情境；驗 log 輸出。

## 2. Session read cache

- [ ] 2.1 盤點所有會寫入 `message:*` / `session:*` 的路徑，列成清單：`session/index.ts`、`message-v2.ts`、`revert.ts`、`task.ts:publishBridgedEvent`。確認每條路徑都有對應 bus event 發佈（不然 cache 會 stale，屬 R-1）；若缺，補進 bridge。
- [ ] 2.2 建立 `packages/opencode/src/server/session-cache.ts`：in-process LRU，keyed by `session:<id>` / `messages:<id>:<limit>`；export `get<T>(key, loader)` 與 `invalidate(sessionID)` 與 `stats()`。loader 簽名需回傳 `{ data, version }`。
- [ ] 2.3 於 cache 模組初始化時 `Bus.subscribeGlobal` 訂閱 `MessageV2.Event.Updated/Removed/PartUpdated/PartRemoved`、`Session.Event.Updated/Deleted/Created`；每個 event 取 `sessionID` 呼叫 `invalidate(sessionID)` 並 bump version counter。
- [ ] 2.4 訂閱失敗（subscribeGlobal throw 或 return null）必須 `log.warn` 並把 `subscriptionAlive=false`；後續 cache operations 一律 miss 但仍讀原始資料（不靜默退回舊值）。
- [ ] 2.5 `Session.Event.Deleted` 時額外清除 version counter。
- [ ] 2.6 單元測試 `server/session-cache.test.ts`：hit、miss、TTL expiry、LRU evict、invalidate、訂閱失敗路徑。

## 3. Route integration — ETag + 304

- [ ] 3.1 修改 `routes/session.ts` 的 `GET /session/{id}`：包 `session-cache.get("session:"+id, loader)`；回應帶 `ETag: W/"<id>:<version>"`；若 req `If-None-Match` 相等回 304 + 空 body。
- [ ] 3.2 修改 `routes/session.ts` 的 `GET /session/{id}/message`：同上，key 為 `messages:<id>:<limit>`；注意 `limit` 參與 cache key（不同 limit 是不同條目）。
- [ ] 3.3 修改 `routes/session.ts` 的 `GET /session/{id}/autonomous/health`：若其內部使用 `Session.get`，確保走同一 cache（避免重複讀磁碟）。
- [ ] 3.4 整合測試 `test/session-route-cache.test.ts`：driven by real HTTP（bun test + 啟 app）；驗第一次 200+ETag、第二次 304、worker 寫入後第三次 200+新 ETag。
- [ ] 3.5 確認 hono 的 ETag middleware 若已存在就用、否則手寫（不要依賴上游 pattern match 壞掉）。

## 4. Rate limit middleware

- [ ] 4.1 建立 `packages/opencode/src/server/rate-limit.ts`：token bucket，key = `${username}:${method}:${routePattern}`，用 hono 的 `c.req.routePath` 或等價 API 拿 pattern。
- [ ] 4.2 設計豁免清單：`opencode.internal` hostname、`/log`、`/api/v2/server/cache/health`、`/api/v2/server/health`。放在 module 頂部 const array，易於 review。
- [ ] 4.3 於 `app.ts` 在 request-log middleware **之後**掛入 rate-limit middleware；被拒時 `return c.json({code:"RATE_LIMIT", message, path, retryAfterSec}, 429, {"Retry-After": String(sec)})`，並 `log.warn("rate-limit throttled", ...)`。
- [ ] 4.4 `ratelimit_enabled=0` 時 middleware short-circuit；啟動時 `log.info("rate-limit disabled via tweaks")`。
- [ ] 4.5 單元測試 `server/rate-limit.test.ts`：quota 內放行、耗盡回 429、Retry-After 合理、豁免路徑不計次、disable 時全放行。

## 5. Health endpoint wiring

- [ ] 5.1 `routes/cache-health.ts` 接上 `session-cache.stats()` 與 `rate-limit.stats()`，回傳 R-4 spec 定義的完整 JSON。
- [ ] 5.2 透過訂閱 `SessionCache.Event.Hit/Miss/Invalidated/Evicted` + `RateLimit.Event.Allowed/Throttled` 維護**過去 5 分鐘滑動窗**的 hitRate / missRate 統計（用 ring buffer，不存不過期資料）。
- [ ] 5.3 整合測試：啟 app、打幾次 session GET、驗 `/cache/health` 數字變化。

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
