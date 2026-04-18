# Proposal: session-poll-cache

## Why

前端（webapp / TUI / admin panel）每 2~3 秒會打一次 `GET /api/v2/session/{id}` 與 `GET /api/v2/session/{id}/message` 來刷新畫面。後端目前的 [`Session.messages`](../../packages/opencode/src/session/index.ts#L662-L676) 每次呼叫都會完整走 `MessageV2.stream(sessionID)`，把該 session 的全部訊息檔案從磁碟重讀一次。

實測狀況（2026-04-19，session `ses_25e814667...`，19 則訊息）：

- 單筆 `/message` 端點平均回應 48–61 ms
- 平均 QPS ~20（web app 分頁仍開著）
- daemon bun 程序 2 小時累積 ~54 分鐘 CPU，**等效平均 44%**
- worker bun 程序同時段 ~21% CPU（主要等 LLM 回覆，非本 plan 範圍）

此現象在使用者打開多個 webapp 分頁 / admin 頁面時會線性疊加。本專案已明確定義「不接受 polling 把 daemon CPU 燒到 100%」作為不可接受狀態。

## Original Requirement Wording (Baseline)

- 「我不能接受有 client 在 polling 就燒 CPU 到 100%。」
- 「做一個 fix plan 走 beta workflow 修掉。」

## Requirement Revision History

- 2026-04-19: initial draft created; Problem 觀察自當日 daemon log 取樣與 `ps` 取樣

## Effective Requirement Description

後端必須對「讀取 session metadata 與訊息列表」這類無副作用查詢具備**抗 polling 能力**：不論前端輪詢頻率多高，daemon 的 CPU 成本必須近似常數而非線性成長，且在快取或 invalidation 異常時必須**明確報錯**（遵守 AGENTS.md 第一條：禁止靜默 fallback）。

## Scope

### IN

- `Session.get(sessionID)`、`Session.messages(sessionID, limit)` 加上**記憶體快取**並以既有 Bus event 作 invalidation。
- `GET /api/v2/session/{id}`、`GET /api/v2/session/{id}/message` 支援 **ETag / `If-None-Match`**，未變更回 `304 Not Modified`。
- Request middleware 新增 **per-user × per-path 速率限制**；超過回 `429 Too Many Requests` 並帶 `Retry-After`。
- 所有 cache hit / miss、invalidation fail、rate-limit trip 必須有結構化 log（非靜默）。
- 驗收量測腳本：以固定 QPS 打 polling，比對 daemon CPU 與平均回應時間前後差異。

### OUT

- worker-side CPU 優化（等 LLM 回覆本來就占 CPU，不在本 plan）。
- 把 polling 改成 SSE/WebSocket 推播（屬另一 plan，本 plan 先做 defensive 層）。
- 換儲存後端（message 檔案存取機制不變，只在上游加 cache）。
- 跨 daemon instance 的分散式快取（單機 in-memory 即可）。

## Non-Goals

- 不處理 worker 本身高 CPU 的議題。
- 不改變 `MessageV2.stream` 的磁碟存取語意（只快取其結果）。
- 不引入外部 cache 套件（Redis、memcached 等）。

## Constraints

- 必須遵守 AGENTS.md 第一條「禁止靜默 fallback」：cache miss、invalidation 訂閱失敗、rate-limit 觸發都必須 log。
- 必須使用既有 Bus infrastructure 做 invalidation，不得自製 polling 或 setInterval（AGENTS.md「禁止繞過 Bus messaging 自製非同步協調」）。
- 常數（cache TTL、rate-limit 閾值）必須放在 `/etc/opencode/tweaks.cfg`，禁止硬編碼（記憶第 `feedback_tweaks_cfg.md` 條）。
- 必須走 beta-workflow 在 beta branch 實作並驗證，通過後 fetch-back 回 main。

## What Changes

- `packages/opencode/src/session/index.ts` — `Session.get` / `Session.messages` 包上快取層，訂閱 `MessageV2.Event.Updated/Removed/PartUpdated/PartRemoved` + `Session.Event.Updated/Deleted` 做 invalidation。
- `packages/opencode/src/server/routes/session.ts` — `GET /session/{id}` 與 `/message` 端點支援 ETag。
- `packages/opencode/src/server/app.ts` — middleware 追加 rate-limit。
- `templates/etc/opencode.cfg` / `/etc/opencode/tweaks.cfg` — 新增 tunables：`session_cache_ttl_sec`、`session_cache_max_entries`、`ratelimit_qps_per_user_per_path`、`ratelimit_burst`。
- `packages/opencode/src/**` 測試：新增 cache 與 rate-limit 的整合測試。
- `docs/events/event_2026-04-19_session-poll-cache.md` — 實作紀錄。

## Capabilities

### New Capabilities

- **Session read cache**：Session.get / messages 結果被記憶體快取，Bus event 驅動清除。
- **Conditional GET**：ETag / 304 短路，客戶端若未取得新資料則省去 JSON 序列化與網路傳輸。
- **Per-identity rate limit**：同一 `username + path` 每秒超過門檻回 429。

### Modified Capabilities

- `Session.messages()`：行為不變（回傳同樣的 `MessageV2.WithParts[]`），但多數 call 在 cache 命中時 <1 ms。
- `/api/v2/session/*` routes：新增 ETag/If-None-Match 支援（前端未升級時行為相容）。
- Request middleware：新增 429 可能回應（原本只有 200/4xx/5xx）。

## Impact

- **前端**：無強制變更；若升級為 send `If-None-Match` 可享 304 加速。
- **Operators**：可透過 `tweaks.cfg` 調整 cache TTL 與 rate-limit 閾值。
- **CLAUDE.md / AGENTS.md**：無需修改（本 plan 遵守既有規範）。
- **specs/architecture.md**：需補充「Session Read Cache + Rate Limit Layer」段落，記錄快取 invariants 與 Bus 事件連線。
- **風險**：
  - 若 invalidation Bus 訂閱意外失效，可能回傳過期資料 → 必須 log 並提供健康檢查端點 `GET /api/v2/server/cache/health` 揭露。
  - Rate limit 若設太低會誤擋正常使用；初始採保守值（例：10 QPS/user/path），以 tweaks 可調。
