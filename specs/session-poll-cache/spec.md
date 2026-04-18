# Spec: session-poll-cache

## Purpose

讓 daemon 對 session metadata 與訊息列表查詢具備抗 polling 能力：把單次查詢從「必然磁碟 I/O」降為「多數命中記憶體」，並在上游加入 conditional GET 與速率限制，避免 CPU 因輪詢而線性成長。

## Requirements

### Requirement: R-1 — Session read cache with bus-driven invalidation

#### Scenario: First read populates cache

- **GIVEN** daemon 啟動後還沒有快取 session `S`
- **WHEN** 收到 `GET /api/v2/session/S` 或 `GET /api/v2/session/S/message`
- **THEN** 執行原本的磁碟讀取，並把結果以 `session:S` / `messages:S:<limit>` 作為 key 寫進記憶體快取
- **AND** 記錄一筆 `SessionCache.Event.Miss` bus event（level=debug）

#### Scenario: Cached read serves subsequent requests

- **GIVEN** session `S` 已被快取且 TTL 未過期、invalidation 未發生
- **WHEN** 收到相同 key 的讀取請求
- **THEN** 直接回傳快取內容，**不**進行磁碟 I/O
- **AND** 記錄一筆 `SessionCache.Event.Hit` bus event（level=debug）
- **AND** 單筆 handler 執行時間（排除網路）< 5 ms（p95）

#### Scenario: Write event invalidates cache

- **GIVEN** session `S` 的快取存在
- **WHEN** bus 上出現 `MessageV2.Event.Updated` / `Removed` / `PartUpdated` / `PartRemoved` 且 `sessionID === S`，**或** `Session.Event.Updated` / `Deleted` 對 session `S`
- **THEN** 所有 `session:S*` / `messages:S*` 的 key 必須在**同一 tick** 內被清除
- **AND** 記錄一筆 `SessionCache.Event.Invalidated` bus event（level=info）並附上觸發事件 type

#### Scenario: Invalidation subscription wiring failure is not silent

- **GIVEN** 快取模組啟動時嘗試註冊 bus 訂閱
- **WHEN** 訂閱呼叫 throw 或回傳 null
- **THEN** 必須 `log.warn("session-cache subscription failed", { type, error })` 並把快取標記為 `unhealthy`
- **AND** `GET /api/v2/server/cache/health` 回應 `subscriptionAlive=false`
- **AND** 此狀況下**不允許**落回「靜默停用快取」，daemon 啟動日誌必須顯示警示（AGENTS.md 第一條）

#### Scenario: TTL expiry evicts stale entries

- **GIVEN** 快取條目年齡超過 `session_cache_ttl_sec`
- **WHEN** 下一次查詢到該 key
- **THEN** 視為 miss 並重新讀取、更新條目

#### Scenario: LRU cap limits memory

- **GIVEN** 快取條目數達到 `session_cache_max_entries`
- **WHEN** 需要新增條目
- **THEN** 清除最舊（最久未使用）條目，記錄 `SessionCache.Event.Evicted`

### Requirement: R-2 — Conditional GET with ETag / 304

#### Scenario: Response includes ETag

- **WHEN** daemon 回應 `GET /api/v2/session/{id}` 或 `GET /api/v2/session/{id}/message`（成功 200）
- **THEN** response header 必須包含 `ETag: W/"<version-token>"`
- **AND** version-token 為 `{sessionID}:{version}`，其中 `version` = 該 session 的單調遞增計數器，任何 `MessageV2.Event.*` 或 `Session.Event.Updated` 均 +1

#### Scenario: If-None-Match matches — 304

- **GIVEN** 前端以 `If-None-Match: W/"<token>"` 打同一端點
- **WHEN** 後端目前的 ETag 與之相等
- **THEN** 回應 `304 Not Modified`，**不**回傳 body、**不**執行 JSON 序列化
- **AND** 仍記錄 rate-limit 計數（304 不是免費通行證）

#### Scenario: If-None-Match mismatches — normal response

- **GIVEN** If-None-Match 存在但與目前 ETag 不同
- **WHEN** 請求進來
- **THEN** 正常回 `200` 帶最新 body 與新 ETag

### Requirement: R-3 — Per-user × per-path rate limit

#### Scenario: Request within quota is allowed

- **GIVEN** 使用者 `U` 在最近 1 秒內對 path pattern `P` 的請求數 ≤ `ratelimit_qps_per_user_per_path`（tokens 充足）
- **WHEN** 新請求到達
- **THEN** 消耗一個 token、放行、記錄 `RateLimit.Event.Allowed`（level=debug）

#### Scenario: Request over quota is throttled

- **GIVEN** 使用者 `U` 已耗盡 `P` 的 tokens
- **WHEN** 新請求到達
- **THEN** 回應 `429 Too Many Requests` 並包含：
  - header `Retry-After: <ceil(secs-to-refill-1-token)>`
  - JSON body `{ "code": "RATE_LIMIT", "message": "...", "path": "<pattern>", "retryAfterSec": <n> }`
- **AND** 記錄 `RateLimit.Event.Throttled`（level=warn）附上 username、path pattern、current QPS

#### Scenario: Internal worker and health endpoints are exempt

- **WHEN** 請求 hostname 為 `opencode.internal`（由 `app.ts` 區分）或 path 為 `/log` / `/api/v2/server/health` / `/api/v2/server/cache/health`
- **THEN** rate limit 不適用、不計次

#### Scenario: Rate limit can be disabled by tweaks

- **GIVEN** `/etc/opencode/tweaks.cfg` 設 `ratelimit_enabled=0`
- **WHEN** 任何請求進來
- **THEN** 不檢查、不計次、不回 429
- **AND** daemon 啟動日誌必須明確印出 `rate-limit disabled via tweaks.cfg`

### Requirement: R-4 — Cache health endpoint

#### Scenario: Health endpoint reports cache state

- **WHEN** 收到 `GET /api/v2/server/cache/health`
- **THEN** 回應 JSON：
  ```
  {
    "entries": <number>,
    "maxEntries": <number>,
    "hitRate": <0..1 — 過去 5 分鐘>,
    "missRate": <0..1>,
    "invalidationCount": <累計>,
    "evictionCount": <累計>,
    "subscriptionAlive": <boolean>,
    "ttlSec": <number>
  }
  ```
- **AND** 回應時間 < 10 ms

### Requirement: R-5 — Tunables in `/etc/opencode/tweaks.cfg`

#### Scenario: All thresholds loaded from tweaks.cfg

- **GIVEN** daemon 啟動
- **WHEN** 初始化 cache / rate-limit 模組
- **THEN** 從 `/etc/opencode/tweaks.cfg` 讀取以下 key：
  - `session_cache_enabled`（bool，default 1）
  - `session_cache_ttl_sec`（int，default 60）
  - `session_cache_max_entries`（int，default 500）
  - `ratelimit_enabled`（bool，default 1）
  - `ratelimit_qps_per_user_per_path`（int 或 ratio，default 10）
  - `ratelimit_burst`（int，default 20）
- **AND** 檔案不存在時使用 default 並 `log.info("tweaks.cfg not found; using defaults", { defaults: {...} })`
- **AND** key 存在但格式錯誤時 `log.warn` 並退回 default（格式錯誤不是靜默 fallback，必須 warn）

## Acceptance Checks

### AC-1: CPU drop under polling

以固定 20 QPS 對 `GET /api/v2/session/{id}/message` 打 5 分鐘，啟用 cache+ETag 後：

- daemon `bun` 進程的 wall-clock CPU 平均 < 10%（目前 ~44%）
- p95 handler 耗時 < 5 ms（目前 48–61 ms）

### AC-2: 304 observable

前端帶 `If-None-Match` 時：

- 至少 95% 的請求回 304（前提：該 session 無寫入）
- 304 請求的後端 handler 耗時 < 2 ms

### AC-3: Invalidation correctness

當 worker 在 session 上 append 新訊息：

- daemon 下一次查詢必然看到新訊息（不得回傳舊快取）
- `SessionCache.Event.Invalidated` event 必須出現在 daemon `debug.log`
- 測試需涵蓋 worker 程序寫入經由 `publishBridgedEvent` 到達 daemon 的路徑

### AC-4: Rate limit 429 observable

以 100 QPS 打同一 path：

- 超過 `ratelimit_qps_per_user_per_path + burst` 的請求必回 429
- `Retry-After` header 必存在且為合理秒數（1..60）
- `debug.log` 必有 `RateLimit.Event.Throttled` warn 紀錄

### AC-5: No silent fallback

手動斷掉 bus 訂閱（測試時 monkey-patch subscribeGlobal 丟錯）：

- daemon 啟動日誌必須有 warn
- `GET /api/v2/server/cache/health` 必須回 `subscriptionAlive: false`
- 快取**不得**在此情況下繼續回傳舊資料（必須改為每次直寫 miss）

### AC-6: tweaks.cfg disable switches

`session_cache_enabled=0` → 每次都 miss；`ratelimit_enabled=0` → 永不回 429。兩者都必須在啟動時印出狀態。
