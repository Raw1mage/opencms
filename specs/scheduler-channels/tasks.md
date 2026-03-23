# Tasks: Scheduler Persistence + Daemon Channels

## Phase 1 — Scheduler Recovery（P0）

- [x] 1.1 Implement `Heartbeat.recoverSchedules()` — read all enabled jobs, detect stale nextRunAtMs
- [x] 1.2 Implement stale one-shot handling — disable expired `at` jobs with `reason: "expired_on_boot"`
- [x] 1.3 Implement stale recurring skip-to-next — recompute nextRunAtMs from now via `Schedule.computeNextRunAtMs()`
- [x] 1.4 Implement backoff overlay for stale jobs with consecutiveErrors — `max(nextFire, now + backoffMs(errors))`
- [x] 1.5 Wire recovery into daemon boot sequence — `daemon/index.ts` calls `recoverSchedules()` before `register()`
- [x] 1.6 Test: clean boot (future nextRunAtMs preserved)
- [x] 1.7 Test: stale recurring (skip-to-next)
- [x] 1.8 Test: stale one-shot (disabled)
- [x] 1.9 Test: stale with consecutive errors (backoff respected)
- [x] 1.10 Test: empty store (no jobs, no crash)

## Phase 2 — Channel 資料模型（P1）

- [x] 2.1 Define `Channel.Info` schema (Zod) — id, name, enabled, lanePolicy, killSwitchScope, state
- [x] 2.2 Implement `ChannelStore` — per-file JSON persistence at `~/.config/opencode/channels/<id>.json`
- [x] 2.3 Implement `ChannelStore.restoreOrBootstrap()` — read existing channels or create default
- [x] 2.4 Implement channel CRUD — create, get, list, update, remove
- [x] 2.5 Implement default channel auto-creation — id="default", current global lane limits
- [x] 2.6 Test: store CRUD (create/read/update/delete)
- [x] 2.7 Test: default channel bootstrap on empty dir
- [x] 2.8 Test: schema validation rejects invalid lanePolicy

## Phase 3 — Per-channel Lanes（P1）

- [x] 3.1 Refactor `Lanes.register()` to accept channel lane policies — `registerChannel(config)`
- [x] 3.2 Implement `buildLaneKey(channelId, lane)` — `"<channelId>:<lane>"` composite key
- [x] 3.3 Refactor `Lanes.enqueue()` to use channel-scoped key
- [x] 3.4 Refactor `Lanes.pump()` for per-channel concurrency tracking
- [x] 3.5 Implement `Lanes.unregisterChannel(channelId)` — clear channel's lanes
- [x] 3.6 Preserve backward compat — `Lanes.enqueue("Main", task)` → defaults to `"default:Main"`
- [x] 3.7 Test: per-channel enqueue/dequeue isolation
- [x] 3.8 Test: cross-channel concurrent Main tasks (both execute)
- [x] 3.9 Test: channel unregister clears lanes
- [x] 3.10 Test: default channel backward compat (no explicit channelId)

## Phase 4 — Channel-scoped Kill-switch（P2）

- [x] 4.1 Extend `KillSwitchService.State` schema — add optional `channelId` field
- [x] 4.2 Extend `assertSchedulingAllowed(channelId?)` — check global + channel scope
- [x] 4.3 Extend `abort-all` endpoint — accept optional `channelId` body param
- [x] 4.4 Implement channel-scoped `listBusySessionIDs(channelId?)` — filter by channel
- [x] 4.5 Test: channel-scoped trigger only affects target channel
- [x] 4.6 Test: global trigger overrides channel scope
- [x] 4.7 Test: backward compat (no channelId = global scope)

## Phase 5 — API + Health（P2）

- [x] 5.1 Implement channel API routes — `GET/POST/PATCH/DELETE /api/v2/channel/`
- [x] 5.2 Extend session creation route — accept optional `channelId` param
- [x] 5.3 Extend `Daemon.info()` — include per-channel lane status
- [x] 5.4 Wire channel restoration into daemon boot — `ChannelStore.restoreOrBootstrap()` before lanes init
- [x] 5.5 Test: channel API CRUD
- [x] 5.6 Test: session creation with channelId
- [x] 5.7 Test: health endpoint includes channel breakdown
