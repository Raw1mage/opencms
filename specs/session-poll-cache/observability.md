# Observability: session-poll-cache

## Events

| Event type | Level | Properties | Emitted by |
|---|---|---|---|
| `SessionCache.Event.Hit` | debug | `{ key, sessionID, durationMs }` | `session-cache.ts get()` cache hit |
| `SessionCache.Event.Miss` | debug | `{ key, sessionID, durationMs }` | cache miss + load completed |
| `SessionCache.Event.Invalidated` | info | `{ sessionID, triggeringEventType, keysDropped }` | bus subscriber after `invalidate(sessionID)` |
| `SessionCache.Event.Evicted` | info | `{ key, sessionID, reason: "lru" \| "ttl" }` | LRU or TTL eviction path |
| `RateLimit.Event.Allowed` | debug | `{ username, method, routePattern, tokensRemaining }` | middleware pass |
| `RateLimit.Event.Throttled` | warn | `{ username, method, routePattern, retryAfterSec }` | middleware reject |

All events use `BusEvent.define(...)` and are visible to the existing `telemetry-runtime` + `debug-writer` subscribers.

## Metrics

Aggregated over a 5-min sliding window unless noted.

Computed on demand by `/api/v2/server/cache/health` from the above bus events:

- `cache.entries` — current entry count
- `cache.hitRate` — `hits / (hits + misses)`
- `cache.missRate` — `1 - hitRate`
- `cache.invalidationCount` — cumulative since boot (not windowed)
- `cache.evictionCount` — cumulative since boot
- `cache.subscriptionAlive` — boolean
- `ratelimit.allowedCount` — windowed
- `ratelimit.throttledCount` — windowed
- `ratelimit.activeBuckets` — current distinct buckets in memory

## Log Lines

Log level is the default `log.{level}()` channel used by existing logger infra.

### Startup

- `log.info "session-cache init" { ttlSec, maxEntries, enabled }`
- `log.info "rate-limit init" { enabled, qps, burst, exemptPaths }`
- `log.info "tweaks.cfg loaded" { effective }` — OR `log.info "tweaks.cfg not found; using defaults" { defaults }` when file absent
- `log.warn "session-cache subscription failed" { type, error }` — if `subscribeGlobal` failed
- `log.info "rate-limit disabled via tweaks"` — if tweaks explicitly disable

### Runtime

- `log.debug "session-cache hit" { key, sessionID }` (optional; behind a flag to avoid noise)
- `log.debug "session-cache miss" { key, sessionID, durationMs }`
- `log.info "session-cache invalidated" { sessionID, triggeringEventType, keysDropped }`
- `log.warn "rate-limit throttled" { username, method, path, retryAfterSec }`
- `log.warn "rate-limit bypassed" { path, reason: "no-username" }` — E-RATE-002

### Failure

- `log.error "session-cache loader failed" { key, error }` — E-CACHE-003
- `log.error "cache-health stats failed" { error }` — E-HEALTH-001

## Alerts (suggested — not implemented by this plan)

Ops can set external alerts on the health endpoint:

- `subscriptionAlive === false` for > 30 seconds → page ops
- `cache.hitRate < 0.5` for > 10 min while `entries > 0` → investigate invalidation storm
- `ratelimit.throttledCount > 100` over 5 min → investigate client misbehavior or raise limits

## Integration with Existing Telemetry

- 本 plan 的事件會經 `telemetry-runtime` 訂閱者被記入現有 telemetry；不額外新增 sink。
- `debug-writer` 會把所有事件寫進 daemon 的 `debug.log`（現有行為）。
- 5-min 滑動窗統計**不新增**儲存後端；於 `session-cache.ts` 與 `rate-limit.ts` 模組內以 ring buffer 維持，daemon 重啟即歸零（可接受）。
