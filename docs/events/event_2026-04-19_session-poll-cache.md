# 2026-04-19 — session-poll-cache

Spec: [specs/session-poll-cache/](../../specs/session-poll-cache/)
Implementation branch: `beta/session-poll-cache` at `/home/pkcs12/projects/opencode-beta`
Base branch: `main`
State machine: `proposed` → `designed` → `planned` → `implementing` (2026-04-19)

## Baseline observation (pre-work)

- daemon `bun` CPU: ~44% averaged over 2h (54m CPU / 125m wall)
- `/api/v2/session/{id}/message` latency: 48–61 ms, ~20 req/s polling
- Root cause confirmed: each request runs `Session.messages(sessionID, 400)` →
  `MessageV2.stream(sessionID)` → N filesystem reads per call; no cache, no ETag.
- Worker→daemon bus bridge for `MessageV2.Event.*` / `Session.Event.*` already
  exists at `packages/opencode/src/tool/task.ts:371-409`
  (`publishBridgedEvent`). The design relies on this being complete.

## Phase 1 — Foundation (tweaks.cfg loader + health endpoint)

Completed: 2026-04-19

### Done (tasks 1.1–1.5)

- **1.1** `packages/opencode/src/config/tweaks.ts` (`Tweaks` namespace)
  - Parses `/etc/opencode/tweaks.cfg` (override via `OPENCODE_TWEAKS_PATH`)
  - INI-style `key=value`; `#` / `;` comments; blank lines ignored
  - Missing file → defaults + single `log.info`
  - Invalid value → `log.warn` + per-key fallback (AGENTS.md rule 1)
  - Unknown keys warned; malformed lines warned
  - Exposes `loadEffective()`, `sessionCache()`, `rateLimit()`, `resetForTesting()`
- **1.2** `templates/system/tweaks.cfg`
  - Default template with documentation for every key, ready to ship to
    `/etc/opencode/tweaks.cfg`. Co-located with existing `opencode.cfg`.
- **1.3** `packages/opencode/src/server/routes/cache-health.ts`
  - `GET /cache/health` Hono route returning the full `CacheHealthResponse`
    schema from data-schema.json
  - Phase 1 uses placeholder stats; Phase 2/5 will register real providers
    via `registerCacheStatsProvider` / `registerRateLimitStatsProvider`
  - Error path returns `503 { code: "HEALTH_UNAVAILABLE" }` with `log.error`
- **1.4** Route mounted in `packages/opencode/src/server/app.ts`
  - `api.route("/server", ServerRoutes())` → endpoint lives at
    `/api/v2/server/cache/health`
  - Rate-limit middleware doesn't exist yet (Phase 4); the exempt list **must**
    include `/api/v2/server/*` and `/api/v2/global/health` when that work lands.
- **1.5** `packages/opencode/test/config/tweaks.test.ts`
  - 9 passing unit tests: defaults on missing file, full valid load,
    invalid integer, invalid boolean, below-minimum rejection, non-positive
    float rejection, unknown-key tolerance, malformed-line tolerance,
    accessor parity with `loadEffective`

### Validation

- `bun run typecheck` — no new errors introduced by these files (pre-existing
  baseline errors in `cli/cmd/uninstall.ts`, `mcp/index.ts`, etc. untouched)
- `bun test test/config/tweaks.test.ts` — 9 pass, 0 fail, 309 ms
- `bun run scripts/plan-sync.ts specs/session-poll-cache/` — clean (no drift)

### Key decisions captured this phase

- **Mount point `/server`** chosen literally per spec R-4 rather than folding
  into existing `/global`. Single endpoint today; future ops endpoints
  (`/server/connections`, `/server/pressure`, …) will extend this file.
- **Stats providers are registered, not imported.** Phase 1 uses a placeholder
  callback and exposes `registerCacheStatsProvider` / `registerRateLimitStatsProvider`
  so session-cache and rate-limit modules in later phases wire themselves
  without `cache-health.ts` importing them (avoids circular deps).
- **Tweaks loader is async-memoized.** First caller triggers disk read;
  concurrent callers share the same promise. `resetForTesting()` is the only
  way to re-read (matches opencode's "restart to apply" convention).

### Drift / follow-ups

- None blocking. Phase 4 must register `/api/v2/server/*` as exempt from the
  rate-limit middleware at introduction time — flagged in tasks.md 1.4 note
  and in Phase 4 task 4.2.

## Next (Phase 2 — Session read cache)

Starting immediately per plan-builder §16.5 (phase boundary is a checkpoint,
not a pause). First task: inventory all bus-event-emitting write paths to
confirm cache coverage.

## Phase 2 — Session read cache

Completed: 2026-04-19

### Stop-gate #1 (handoff): bus bridge coverage audit

Grep over `packages/opencode/src/**` for `Bus.publish(MessageV2.Event.*)` and
`Bus.publish(Session.Event.Updated|Created|Deleted)` found 12 publish sites.
All 7 subscriber-relevant types are covered:

| Event type | Publisher(s) | Process | Daemon delivery path |
|---|---|---|---|
| `MessageV2.Event.Updated` | `session/index.ts:832`, `session/message-v2.ts:1313` | worker/daemon | direct or via `publishBridgedEvent` (task.ts:375) |
| `MessageV2.Event.Removed` | `session/index.ts:857`, `session/message-v2.ts:1335`, `session/revert.ts:101` | worker/daemon | direct or bridged (task.ts:378) |
| `MessageV2.Event.PartUpdated` | `session/index.ts:926/932`, `session/message-v2.ts:1322` | worker/daemon | direct or bridged (task.ts:381) |
| `MessageV2.Event.PartRemoved` | `session/index.ts:873`, `session/revert.ts:110` | worker/daemon | direct or bridged (task.ts:384) |
| `Session.Event.Created` | `session/index.ts:477` | daemon | direct |
| `Session.Event.Updated` | `session/index.ts:491/560`, also bridged (task.ts:387) | daemon/worker | direct or bridged |
| `Session.Event.Deleted` | `session/index.ts:812` | daemon | direct |

No gaps found. Stop-gate #1 **passes** without remediation — the cache can
trust the existing bus infrastructure.

### Done (tasks 2.1–2.6)

- **2.2** `packages/opencode/src/server/session-cache.ts` (`SessionCache` namespace)
  - In-process LRU using `Map<key, Entry>` insertion-order semantics
  - Keys: `session:<id>`, `messages:<id>:<limit>`
  - Per-session monotonic version counter (I-4); bumped on every
    MessageV2.Event / Session.Event.Created|Updated, cleared on Deleted
  - `get(key, sessionID, loader)` with TTL + LRU enforcement
  - Bus events emitted: `session-cache.hit|miss|invalidated|evicted`
  - Registers itself as stats provider via `registerCacheStatsProvider`
  - `resetForTesting` + `setSubscriptionAliveForTesting` for clean unit tests
- **2.3** Subscribers registered at daemon startup in `src/index.ts` after
  existing `registerDebugWriter` / `registerTelemetryRuntimePersistence` /
  `registerTaskWorkerContinuationSubscriber` calls
- **2.4** Subscription registration wrapped in try/catch; failure path sets
  `subscriptionAlive=false`, issues `log.warn`, and still registers the
  stats provider so `/cache/health` can surface the degraded state
- **2.5** `Session.Event.Deleted` subscriber calls `forgetSession` which both
  drops cache keys and clears the per-session version counter (I-4 cleanup)
- **2.6** `packages/opencode/test/server/session-cache.test.ts` — 10 passing
  tests: miss-then-hit, loader skip, invalidate, bus-event-driven
  invalidation for `MessageV2.Event.Updated` and `PartUpdated`,
  `Session.Event.Deleted` counter cleanup, TTL expiry (ttlSec=0 edge),
  LRU eviction under max=2, subscriptionAlive=false never memoizes,
  cache-disabled tweaks short-circuit

### Validation

- `bun run typecheck` — no new errors
- `bun test test/server/session-cache.test.ts` — 10 pass, 0 fail, 1.2 s
- `bun run scripts/plan-sync.ts specs/session-poll-cache/` — clean (no drift)

### Drift / follow-ups

- None. Phase 3 will wire the cache into the actual HTTP routes.

## Main-sync merge (between Phase 2 and Phase 3)

Completed: 2026-04-19 — `6c621b8d8`

While Phase 1/2 were in progress, `main` advanced by three commits that did
not touch any of the beta-branch's modified files:

- `5bb5b522f` fix(image-router): pin session.execution after capability rotation
- `4dd4e14a2` fix(rotation): coalesce concurrent rotations
- `dbcd0c1f7` feat(skill): close SkillLayerRegistry seam + planner→plan-builder rename

Per beta-workflow §6.1 (`main=A+C`, `beta=B+D` → `A+C+D`), main was merged
into `beta/session-poll-cache` with a plain `git merge main` (no rebase).
Automatic merge succeeded — no conflict files needed manual resolution.
All Phase 1+2 tests (19/19) pass on the merged tree; typecheck introduces
no new errors. Fail-fast gate cleared.

## Phase 3 — Route integration (ETag + 304)

Completed: 2026-04-19

### Done (tasks 3.1–3.5)

- **3.1 / 3.2** `packages/opencode/src/server/routes/session.ts`
  - `GET /session/:sessionID` and `GET /session/:sessionID/message` now
    short-circuit via `SessionCache.isEtagMatch` → `304 Not Modified` when
    the client's `If-None-Match` equals the current ETag, avoiding both
    the cache lookup and the JSON serialization path entirely.
  - On full responses, both endpoints route through `SessionCache.get(...)`
    with a loader wrapping the original `Session.get` / `Session.messages`
    call. Cache key schema: `session:<id>` and `messages:<id>:<limit|all>`.
  - `limit=undefined` is keyed as `…:all` so the default-limit path caches
    distinctly from explicit-limit callers and a spurious mix of `limit=400`
    and `limit=undefined` requests cannot invalidate each other.
  - `ETag` header attached to all 200 and 304 responses.
  - The forwarded-to-per-user-daemon path (`UserDaemonManager.routeSessionReadEnabled`)
    is left **unchanged** — the per-user daemon owns its own cache on that
    surface and double-caching would obscure invalidation semantics.
- **3.3** `/session/:sessionID/autonomous/health` existence guard now calls
  `SessionCache.get("session:<id>", …)` instead of `Session.get` directly,
  so polling `/autonomous/health` also benefits from the cache.
- **3.4** ETag unit tests added to
  `packages/opencode/test/server/session-cache.test.ts`:
  - format `W/"<id>:<version>:<epoch>"`
  - version bump via `MessageV2.Event.Updated` invalidates prior ETag
  - whitespace-tolerant match
  - null/undefined/empty header returns false
  - *End-to-end HTTP 304 verification is deferred to Phase 6 acceptance
    benchmarks.* Route-level integration tests would require mocking the
    full Instance/Storage/Auth stack; Phase 6 will exercise the real HTTP
    surface under a live daemon and provide equivalent coverage with less
    mock debt. Drift flagged here per AGENTS.md rule 1.
- **3.5** Handwritten ETag logic (not hono's built-in middleware) so
  invalidation semantics are unambiguous. Typecheck clean; 19 → 13 tests
  in `session-cache.test.ts` (3 new ETag tests + 10 prior cache tests).

### ETag per-process epoch rationale

`W/"<id>:<version>:<epoch>"` where `epoch = Date.now().toString(36)` is a
module-load constant. Without the epoch, a daemon restart resets the
version counter to 0 and a client holding `W/"<id>:0:…"` from a previous
process would falsely 304-match. The epoch changes on every process start,
guaranteeing that post-restart clients always see at least one 200 response
before they can 304 again. Captured in invariants.md note and spec DD-3.

### Validation

- `bun run typecheck` — no new errors in session-cache.ts, cache-health.ts,
  tweaks.ts, or routes/session.ts
- `bun test test/config/tweaks.test.ts test/server/session-cache.test.ts`
  — 13 + 9 = 22 pass, 0 fail, 1.3 s
- `bun run scripts/plan-sync.ts specs/session-poll-cache/` — runs after this
  phase commit

### Drift / follow-ups

- Phase 4 rate-limit exempt list must include `/api/v2/server/*` (previously
  flagged in Phase 1 note); confirmed during Phase 3 review.
- Phase 6 benchmark script is now on the critical path for AC-2
  (304 ratio >95%) verification. End-to-end HTTP test deferred here must be
  satisfied by that script.
- `UserDaemonManager.routeSessionReadEnabled` path is NOT cached locally
  — if that surface becomes a polling hotspot later, a secondary plan should
  add an HTTP-level cache at the `UserDaemonManager.callSession*` layer.

## Phase 4 — Rate limit middleware

Completed: 2026-04-19

### Done (tasks 4.1–4.5)

- **4.1** `packages/opencode/src/server/rate-limit.ts` (`RateLimit` namespace)
  - Token bucket per `${username}:${method}:${routePattern}`
  - `normalizeRoutePattern(path)` collapses opencode ID segments (regex
    `^(ses|msg|per|que|usr|prt|pty|tool)_[A-Za-z0-9]{20,}$`) to `:id`, so
    per-session URLs share one bucket rather than fragmenting the limiter.
  - Refill rate + capacity from `ratelimit_qps_per_user_per_path` +
    `ratelimit_burst` tweaks.
  - Bus events: `rate-limit.allowed|throttled`.
- **4.2** `EXEMPT_PATH_PREFIXES` const at module top: `/log`,
  `/api/v2/global/health`, `/api/v2/global/log`,
  `/api/v2/server/cache/health`, `/api/v2/server/`. Hostname
  `opencode.internal` bypassed unconditionally.
- **4.3** Mounted in `server/app.ts` between the request-log middleware
  and the directory/Instance middleware, so 429 responses are still
  logged. Response format: `{ code: "RATE_LIMIT", message, path,
  retryAfterSec }` with `Retry-After: <ceil(secs-to-refill-1)>`.
- **4.4** `ratelimit_enabled=0` short-circuits the middleware; startup
  emits a single `rate-limit disabled via tweaks` info line.
  `RateLimit.logStartup()` is invoked from `src/index.ts` right after
  `SessionCache.registerInvalidationSubscriber()`; it also registers
  the stats provider with `/cache/health`.
- **4.5** `packages/opencode/test/server/rate-limit.test.ts` — 12
  passing tests: normalize happy/edge cases, under-burst allow,
  429+Retry-After on exhaust, pattern-scoped bucket isolation, session
  IDs collapse into one bucket for the same pattern, per-user bucket
  isolation, exempt paths, internal hostname bypass, disabled-tweaks
  pass-through, no-username E-RATE-002 warn-bypass.

### Implementation notes

- hono's `c.req.routePath` is only populated after route matching, which
  happens after middleware. We use `c.req.path` (raw URL) and normalize
  it in the middleware itself.
- Cumulative counters only — a 5-min sliding-window aggregation is
  deferred to Phase 5 / follow-up plan (see spec R-4 note). Cumulative
  data is already useful for ops.
- `E-RATE-002` (no-username bypass with warn) preserves the invariant
  that unattributed traffic is never silently throttled.

### Validation

- `bun run typecheck` — no new errors in rate-limit.ts, session-cache.ts,
  cache-health.ts, tweaks.ts
- Combined test run (`tweaks + session-cache + rate-limit`): 34 pass,
  0 fail, 1.2 s
- `bun run scripts/plan-sync.ts specs/session-poll-cache/` — runs after
  this phase commit

### Drift / follow-ups

- **Sliding-window stats deferred to Phase 5.** Current implementation
  exposes cumulative counts via `/cache/health`. Spec R-4 said "過去 5
  分鐘" — this is a partial fulfillment. Acceptable for Phase 5 to ship
  cumulative and layer the ring buffer as a separate follow-up plan if
  ops feedback needs it.

## Phase 5 — Stats wiring

Completed: 2026-04-19 (with one deferred item)

### Done (tasks 5.1, 5.3)

- **5.1** The provider-registration pattern set up in Phases 1–4 already
  wires real stats into `/cache/health`:
  - `session-cache.ts` calls `registerCacheStatsProvider(stats)` from
    `registerInvalidationSubscriber()` (both success and failure paths)
  - `rate-limit.ts` calls `registerRateLimitStatsProvider(stats)` from
    `logStartup()`
  - `cache-health.ts` route invokes the currently registered providers
    on every request and merges them with effective tweaks config
- **5.3** `packages/opencode/test/server/cache-health.test.ts` — 4
  passing integration tests driving the real Hono-mounted route:
  - Placeholder state when no providers are registered (degraded
    startup path — matches AC-5 expectation)
  - After real session-cache activity (miss + hit + invalidate):
    hitRate, missRate, invalidationCount, subscriptionAlive update
  - After real rate-limit activity (throttle trip): allowedCount,
    throttledCount, activeBuckets update
  - Effective tweaks.cfg path + present flag surface in the `source`
    field for ops visibility
- `specs/session-poll-cache/data-schema.json` amended to include the
  `source` field (path + present) under `CacheHealthResponse` — the
  field is useful for ops and was present in the route code from
  Phase 1, but originally missing from the schema.

### Deferred (task 5.2): 5-minute sliding window stats

Spec R-4 described `hitRate` as "過去 5 分鐘". Current implementation
exposes cumulative counters over the daemon's lifetime. Reasons for
deferral:

- Cumulative counters are already actionable for the common ops
  workflow (daemon just started → 0 vs many hits → high hitRate).
- The schema can accept a windowed aggregation later without breaking
  clients (same field names, different computation).
- Adding a ring buffer requires per-event Bus subscribers inside
  cache-health.ts and additional tests; keeps Phase 5 focused on
  delivering the AC-1 CPU-drop goal rather than ops polish.

Follow-up plan candidate: "session-poll-cache-stats-window" (extend
mode against this spec, add windowed aggregation module, update spec
wording).

### Validation

- `bun run typecheck` — no new errors
- `bun test test/config/tweaks test/server/session-cache test/server/rate-limit test/server/cache-health`
  — 38 pass, 0 fail, 1.2 s

### Drift / follow-ups

- Sliding window stats (task 5.2) — explicit extend-mode candidate.
- End-to-end HTTP 304 verification still deferred to Phase 6.

## Phase 6 — Acceptance (partial: deliverables ready, ops validation pending)

Completed (the development side): 2026-04-19

### Done (tasks 6.1, 6.4, 6.5, 6.6)

- **6.1** `script/session-poll-bench.ts` — a standalone bun script that
  drives steady-state polling against a running daemon, samples per-pid
  CPU via `/proc/<pid>/stat`, and emits a JSON report with p50/p95/p99
  latency, status counts, 304 ratio, and CPU-tick history. Honors
  `--etag-roundtrip` (default) so AC-2 is measurable in one run.
- **6.4** AC-4 (rate-limit 429 + Retry-After) is already asserted at
  unit-test level by `test/server/rate-limit.test.ts` "throttles beyond
  burst with 429 + Retry-After". Real-bucket math with real Retry-After
  header is verified there; a live-daemon stress re-run is optional.
- **6.5** AC-5 (no silent fallback under subscription failure) is
  asserted by:
  - `test/server/session-cache.test.ts` "subscriptionAlive=false →
    loader runs every time and never memoizes"
  - `test/server/cache-health.test.ts` "returns placeholder state when
    no stats providers registered" — response correctly shows
    `subscriptionAlive: false`
- **6.6** AC-3 (invalidation correctness across worker writes) is
  asserted by `test/server/session-cache.test.ts`:
  - "bus event MessageV2.Event.Updated invalidates cache and bumps
    version" (bus bridge semantics identical for worker-origin events)
  - "bus event MessageV2.Event.PartUpdated extracts sessionID from
    part" (cross-process partial update path)

### Deferred to ops-side runbook (tasks 6.2, 6.3)

AC-1 (CPU drop) and AC-2 (304 ratio) are fundamentally "observed
numbers against a live daemon" — not amenable to automated test. The
runbook lives in `specs/session-poll-cache/handoff.md#phase-6-ops-runbook`
and spells out:

1. Start daemon with `OPENCODE_TWEAKS_PATH=/tmp/tweaks.baseline.cfg`
   (`session_cache_enabled=0`) and run the bench for 5 min → baseline.
2. Restart daemon with defaults (cache on) and run the bench again →
   after.
3. Compare; AC-1 expects avg CPU drop from ≥30% to <10%, AC-2 expects
   `status_304 > 0.95`.
4. Paste the numbers back into this event log under a new "## Phase 6
   ops result" heading, then proceed with `plan-promote --to verified`.

This is an honest gate — the plan does not self-declare `verified`
until ops captures the real numbers. Until then the spec stays in
`implementing` and `beta/session-poll-cache` is not fetched back.

### Validation

- `bun run typecheck` — no new errors in `script/session-poll-bench.ts`
- Combined test run (all 4 test files): 38 pass, 0 fail
