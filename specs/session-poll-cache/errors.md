# Errors: session-poll-cache

## Error Codes

- `E_CACHE_001` — session-cache bus subscription failed; daemon runs without caching but logs warn (see E-CACHE-001 below).
- `E_CACHE_002` — tweaks.cfg key parse failure; default applied with warn.
- `E_CACHE_003` — cache loader (Session.get / messages) threw; propagated to route handler as 500.
- `RATE_LIMIT` — rate-limit bucket exhausted; HTTP 429 with Retry-After.
- `E_RATE_002` — username unresolvable under rate-limit; bypass with warn (not silent).
- `HEALTH_UNAVAILABLE` — /cache/health stats snapshot failed; HTTP 503.

## Error Catalogue

### E-CACHE-001 — Cache subscription unavailable

- **HTTP status**: 不影響用戶端（降級為無快取而已）；`/api/v2/server/cache/health` 回 `subscriptionAlive: false`
- **Log level**: `warn`
- **Message pattern**: `session-cache subscription failed: <error>`
- **Layer**: `packages/opencode/src/server/session-cache.ts`
- **Trigger**: `Bus.subscribeGlobal` throw 或 return null / undefined
- **Recovery**: 本模組將自身標記 `subscriptionAlive=false`，**每次**請求都走原始 loader（等於 cache disabled）；但不得回傳舊值。Ops 應修復 bus 註冊路徑後重啟 daemon。
- **AGENTS.md 第一條相關**：必須 log，不得沉默。

### E-CACHE-002 — tweaks.cfg parse error

- **HTTP status**: 無
- **Log level**: `warn`
- **Message pattern**: `tweaks.cfg invalid value for <key>: <raw>; using default <default>`
- **Layer**: `packages/opencode/src/config/tweaks.ts`
- **Trigger**: 某 key 存在但 parseInt / parseFloat / JSON.parse 失敗
- **Recovery**: 該 key 套用 default，其他 key 正常解析；daemon 繼續啟動。
- **AGENTS.md 第一條相關**：必須 log 指出哪個 key、原值、用了什麼 default。

### E-CACHE-003 — Loader threw during miss

- **HTTP status**: 500（沿用原本 `Session.get/messages` 的錯誤傳遞）
- **Log level**: `error`
- **Message pattern**: `session-cache loader failed: <key> <error>`
- **Layer**: `session-cache.ts`
- **Trigger**: `loader()`（= `Session.get` / `Session.messages`）throw
- **Recovery**: Cache 不寫入；錯誤原樣拋回 route handler，由現有 error middleware 處理。

### E-RATE-001 — Rate limit exceeded

- **HTTP status**: 429
- **Response body**: `{ "code": "RATE_LIMIT", "message": "...", "path": "<pattern>", "retryAfterSec": <n> }`
- **Response header**: `Retry-After: <ceil(secs-to-refill-1-token)>`
- **Log level**: `warn`
- **Message pattern**: `rate-limit throttled user=<u> method=<m> path=<p> burstRemaining=0`
- **Layer**: `packages/opencode/src/server/rate-limit.ts`
- **Trigger**: token bucket 對 `(username, method, routePattern)` 耗盡
- **Recovery**: 客戶端收到 `Retry-After` 應等待該秒數後重試。

### E-RATE-002 — Unidentified request under enabled rate-limit

- **HTTP status**: 無（不觸發 429，但必須 log）
- **Log level**: `warn`
- **Message pattern**: `rate-limit: username not resolvable for path <p>; bypassing check`
- **Layer**: `rate-limit.ts`
- **Trigger**: `RequestUser.username()` 回 undefined / 空字串
- **Recovery**: 讓 middleware 放行（避免阻擋合法的未認證流量），但 log 讓 ops 可判斷。
- **AGENTS.md 第一條相關**：此為降級路徑，必須 log 告知 ops「為什麼 bypass」。

### E-HEALTH-001 — Cache health endpoint cannot read stats

- **HTTP status**: 503
- **Response body**: `{ "code": "HEALTH_UNAVAILABLE", "message": "cache stats unavailable" }`
- **Log level**: `error`
- **Message pattern**: `cache-health: stats snapshot failed: <error>`
- **Layer**: `packages/opencode/src/server/routes/cache-health.ts`
- **Trigger**: `session-cache.stats()` 或 `rate-limit.stats()` throw
- **Recovery**: 用戶端應重試；同時 ops 檢視 daemon log。

## Error Code Table

| Code | HTTP | Layer | Recovery |
|---|---|---|---|
| `RATE_LIMIT` | 429 | middleware | Retry after header |
| `HEALTH_UNAVAILABLE` | 503 | route | Retry / inspect logs |

## Implementation Notes

- 錯誤回應 JSON 必須與現有 `error.ts` middleware 的格式相容（`{code, message, ...}`）。
- 不新增全新錯誤類別到 `MessageV2` namespace；rate-limit / cache 的錯誤都在 server 層表達。
