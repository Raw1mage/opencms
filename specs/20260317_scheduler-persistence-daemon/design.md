# Design: Scheduler Persistence + Daemon Channels

## Context

OpenCode daemon 子系統（D.1-D.3）已交付：gateway lock、signal dispatch、drain state machine、command lanes、heartbeat、retry policy。CronStore 已經 write-through 到 `~/.config/opencode/cron/jobs.json`（包含 CronJobState），但 daemon restart 後 `Scheduler.register()` 的 `setInterval` 消失，需要從 persisted state 重建排程。

Session 模型是 flat list，沒有分組概念。Daemon mode 需要支援多個獨立 agent 對話，各自有 lane allocation 和 kill-switch scope。

## Goals / Non-Goals

**Goals:**
- Daemon restart 後 cron 排程零手動介入恢復
- 長 downtime 後的 stale schedule 有明確處理策略
- 多 channel 隔離：lane、kill-switch、session scope
- 向下相容：無 channel 的使用方式行為不變

**Non-Goals:**
- Multi-node daemon
- SQLite migration
- Channel 間 message routing
- Web UI channel 管理

## Decisions

### DD-13: Stale schedule catchup 策略 — skip-to-next

選 **skip-to-next** 而非 execute-missed-runs。

**理由**: Daemon 可能停了數小時甚至數天。如果 execute-missed，一個 `every: 5min` 的 job 停 24h 就要 catchup 288 次，浪費 token 且語境過期。skip-to-next 從 now 重算下次 fire time，簡單且安全。

**例外**: One-shot (`at`) jobs 如果已過期，直接 disable（不執行也不 reschedule）。

### DD-14: Channel persistence — per-file JSON

每個 channel 一個 JSON 檔：`~/.config/opencode/channels/<channelId>.json`。

**理由**: 跟 CronStore 風格一致（JSON file store）。單一 `channels.json` 在頻繁更新 per-channel state 時會有 write contention。Per-file 允許 per-channel 鎖。

**替代考慮**: 單一 `channels.json`（simpler，但 write contention on state updates）。SQLite（overkill for ≤10 channels）。

### DD-15: Lane namespace — channel:lane 複合 key

Lanes module 的 key 從 `"Main"` 變為 `"<channelId>:Main"`。每個 channel 有獨立的 concurrency tracking。

**理由**: 最小改動。現有 `Lanes.enqueue(lane, task)` 變為 `Lanes.enqueue(channelLane, task)` 其中 `channelLane = buildLaneKey(channelId, lane)`。

**Default channel**: `"default:Main"` etc.，concurrency limits = 現有全域值。

### DD-16: Kill-switch scope extension — optional channelId

Kill-switch state 增加 `channelId?: string`。

- `channelId = undefined` → global scope（所有 channel 都停）
- `channelId = "xxx"` → channel scope（只停該 channel）

`assertSchedulingAllowed()` 增加 channelId 參數：
```
assertSchedulingAllowed(channelId?) →
  if global kill active → block
  if channel kill active && channelId matches → block
  else → allow
```

Emergency abort-all endpoint 增加 optional `channelId` body param。

### DD-17: Default channel bootstrap

Daemon 啟動時如果 `~/.config/opencode/channels/` 為空，自動建立 `"default"` channel：
```json
{
  "id": "default",
  "name": "Default",
  "enabled": true,
  "lanePolicy": { "main": 1, "cron": 1, "subagent": 2, "nested": 1 },
  "killSwitchScope": "global"
}
```

所有未指定 channel 的 session/task 歸入 default channel。

## Data / State / Control Flow

### Scheduler Recovery Flow (Daemon Boot)

```
daemon.start()
  → GatewayLock.acquire()
  → Lanes.register()
  → Signals.register()
  → ChannelStore.restoreOrBootstrap()    ← new
  → Heartbeat.recoverSchedules()          ← new
  → Heartbeat.register()
  → Server.start()
```

`Heartbeat.recoverSchedules()`:
```
for job in CronStore.listEnabled():
  if job.state.nextRunAtMs > now:
    continue  // already future-scheduled, no action
  if job.schedule.kind === "at":
    CronStore.update(job.id, { enabled: false })  // expired one-shot
    continue
  // recurring + stale
  nextFire = Schedule.computeNextRunAtMs(job.schedule, now)
  backoff = RetryPolicy.backoffMs(job.state.consecutiveErrors ?? 0)
  nextRunAtMs = max(nextFire, now + backoff)
  CronStore.updateState(job.id, { nextRunAtMs })
```

### Channel Lane Flow

```
session.create({ channelId: "ch-1" })
  → Lanes.enqueue("ch-1:Main", task)
  → pump("ch-1:Main")  // checks ch-1 Main concurrency (isolated from other channels)
```

### Channel Kill-switch Flow

```
POST /api/v2/session/abort-all { channelId: "ch-1" }
  → list busy sessions filtered by channelId
  → SessionPrompt.cancel() each
  → KillSwitchService.setState({ channelId: "ch-1", scope: "channel" })
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│                  Daemon                          │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │Channel A │  │Channel B │  │ Default  │      │
│  │ Main:2   │  │ Main:1   │  │ Main:1   │      │
│  │ Cron:1   │  │ Cron:1   │  │ Cron:1   │      │
│  │ Sub:3    │  │ Sub:2    │  │ Sub:2    │      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘      │
│       │              │              │            │
│  ┌────┴──────────────┴──────────────┴────┐      │
│  │        Lanes (per-channel keys)       │      │
│  └───────────────────────────────────────┘      │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │Heartbeat │  │Kill-switch│  │  Health  │      │
│  │+Recovery │  │+Ch.Scope │  │+Ch.Info  │      │
│  └──────────┘  └──────────┘  └──────────┘      │
│                                                  │
│  ┌──────────────────────────────────────┐       │
│  │         CronStore (jobs.json)        │       │
│  └──────────────────────────────────────┘       │
│  ┌──────────────────────────────────────┐       │
│  │  ChannelStore (channels/<id>.json)   │       │
│  └──────────────────────────────────────┘       │
└─────────────────────────────────────────────────┘
```

## Risks / Trade-offs

- **Skip-to-next loses missed runs** → 可接受：missed heartbeat 的資訊在 downtime 期間已過期，catchup 執行只浪費 token
- **Per-channel files 增加 I/O** → 可接受：channel 數量 ≤10，每個 file 寫入 < 1KB
- **Lane namespace change 影響現有 test** → 需要 backward compat: default channel key 在 test 中透明
- **Channel-scoped kill-switch 增加複雜度** → 用 optional channelId 最小化改動，global kill 依然一鍵停全部
- **Daemon boot time 增加** → Recovery 讀一次 jobs.json + channels/*.json，< 10ms

## Critical Files

- `packages/opencode/src/cron/heartbeat.ts`
- `packages/opencode/src/cron/store.ts`
- `packages/opencode/src/daemon/index.ts`
- `packages/opencode/src/daemon/lanes.ts`
- `packages/opencode/src/channel/` (new module)
- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/src/server/routes/channel.ts` (new)
- `packages/opencode/src/server/killswitch/service.ts`
