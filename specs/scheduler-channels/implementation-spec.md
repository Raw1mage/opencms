# Implementation Spec

## Goal

Daemon restart 後自動恢復 cron 排程，並引入 channel 模型實現多對話隔離。

## Scope

### IN
- Scheduler recovery on daemon boot
- Stale schedule catchup/skip 策略
- Channel 資料模型 + persistence
- Per-channel lane allocation
- Per-channel kill-switch scope
- Daemon health endpoint 擴充

### OUT
- SQLite（使用 JSON file store）
- Web UI / TUI channel 管理介面
- Channel 間 message routing
- SystemEvents 持久化（restart 清空可接受）
- Multi-node daemon

## Assumptions

- CronStore 的 write-through persistence 已正常運作（jobs.json 包含完整 CronJobState）
- Daemon 是單機單進程（GatewayLock 保證）
- 現有 lane concurrency limits（Main=1, Cron=1, Subagent=2, Nested=1）是全域值，channel 模式下需要 per-channel 分配

## Stop Gates

1. **Phase 1 必須通過 recovery test** 才能進入 Phase 2 — scheduler recovery 是後續所有 channel 工作的前提
2. **Channel 資料模型需要 user approval** 才能開始實作 — schema 決定了 lane allocation 和 kill-switch scope 的設計
3. **不得破壞現有 kill-switch 行為** — emergency abort-all 必須繼續運作
4. **不得引入新的外部依賴**

## Critical Files

- `packages/opencode/src/cron/heartbeat.ts` — boot recovery logic
- `packages/opencode/src/cron/store.ts` — stale state detection
- `packages/opencode/src/daemon/index.ts` — boot sequence orchestration
- `packages/opencode/src/daemon/lanes.ts` — per-channel lane namespace
- `packages/opencode/src/channel/types.ts` — Channel.Info schema (new)
- `packages/opencode/src/channel/store.ts` — ChannelStore persistence (new)
- `packages/opencode/src/channel/index.ts` — channel lifecycle (new)
- `packages/opencode/src/server/routes/channel.ts` — channel API (new)
- `packages/opencode/src/server/killswitch/service.ts` — channel scope

## Structured Execution Phases

### Phase 1: Scheduler Recovery（P0 — 前提）

在 daemon boot 時從 CronStore 讀取所有 enabled jobs，重建排程：

1. **Boot recovery function**: `Heartbeat.recoverSchedules()` — 讀所有 enabled jobs
2. **Stale detection**: 如果 `job.state.nextRunAtMs < now`，判斷為 stale
3. **Catchup 策略**:
   - `schedule.kind === "at"` (one-shot): 已過期 → disable job（因為 one-shot 只跑一次）
   - `schedule.kind === "every"` / `"cron"` (recurring): skip-to-next — 從 now 算下一個 fire time
   - 如果 `consecutiveErrors > 0`，overlay retry backoff（重用 RetryPolicy.backoffMs）
4. **Re-registration**: 更新 `nextRunAtMs` 到 CronStore，heartbeat tick 自然撿起

Validation: 20+ tests — boot recovery、stale one-shot、stale recurring、backoff overlay、clean boot（no stale）

### Phase 2: Channel 資料模型（P1）

定義 channel 的核心 schema 和 persistence：

1. **Channel.Info schema**:
   ```
   { id, name, description?, enabled, createdAtMs, updatedAtMs,
     lanePolicy: { main, cron, subagent, nested },
     killSwitchScope: "channel" | "global",
     sessionFilter?: { prefix, tags },
     state: { activeSessionCount, lastActivityAtMs } }
   ```
2. **ChannelStore**: JSON file at `~/.config/opencode/channels/<channelId>.json`，CRUD with file lock
3. **Default channel**: `"default"` channel 自動建立，承載所有非 channel-scoped sessions

Validation: store CRUD tests, schema validation, default channel bootstrap

### Phase 3: Per-channel Lanes（P1）

將 Lanes module 從全域單一 set 改為 per-channel namespace：

1. **Lane key**: 從 `Main/Cron/Subagent/Nested` 變為 `<channelId>:Main` etc.
2. **Concurrency cap**: 每個 channel 有自己的 lane policy，不互相擠壓
3. **Drain**: drain 可以按 channel 或 global（drain all channels）
4. **Backward compat**: default channel 保持現有行為，無 channel 的 session 歸 default

Validation: per-channel enqueue/dequeue, cross-channel isolation, default channel compat

### Phase 4: Channel-scoped Kill-switch（P2）

擴充 kill-switch 支援 channel scope：

1. **Kill-switch state 增加 channelId field**: `scope: "global" | "channel"`, `channelId?: string`
2. **assertSchedulingAllowed() 增加 channel check**: global kill → 全擋，channel kill → 只擋該 channel
3. **abort-all endpoint 增加 channelId param**: 可選只停某 channel

Validation: channel-scoped trigger/cancel, global override, backward compat

### Phase 5: API + Health（P2）

1. **Channel CRUD API**: `GET/POST/PATCH/DELETE /api/v2/channel/`
2. **Health endpoint 擴充**: `Daemon.info()` 增加 per-channel lane status
3. **Session creation 增加 channelId param**: session route 接受 `channelId` → 歸入對應 channel

Validation: API smoke tests, health endpoint includes channel info

## Validation

- Phase 1: `bun test cron/` — boot recovery tests (stale/clean/one-shot/recurring/backoff)
- Phase 2: `bun test channel/` — store CRUD, schema, default channel
- Phase 3: `bun test daemon/lanes` — per-channel isolation, drain, compat
- Phase 4: `bun test killswitch/` — channel-scoped trigger, global override
- Phase 5: API route tests — channel CRUD, health, session channelId
- Integration: daemon start → scheduler recovery → create channel → enqueue to channel lane → channel kill-switch → verify isolation

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
- Implementation happens in `~/projects/opencode-runner` on a new branch (e.g. `scheduler-daemon`).
- Final merge target: `~/projects/opencode` branch `cms`.
