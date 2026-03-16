# Spec: Scheduler Persistence + Daemon Channels

## Purpose

確保 daemon restart 後 cron 排程自動恢復，並為多對話場景提供 channel 隔離機制。

## Requirements

### Requirement: Scheduler boot recovery

Daemon 啟動時，SHALL 從 CronStore 讀取所有 enabled jobs 並恢復排程。

#### Scenario: Clean boot with future nextRunAtMs
- **GIVEN** an enabled job with `nextRunAtMs = now + 30min`
- **WHEN** daemon starts
- **THEN** the job's schedule is preserved; heartbeat fires at the scheduled time

#### Scenario: Stale recurring job after downtime
- **GIVEN** an enabled recurring job (`every: 30min`) with `nextRunAtMs = now - 2h`
- **WHEN** daemon starts
- **THEN** `nextRunAtMs` is recomputed to the next future fire time (skip-to-next, no catchup execution)

#### Scenario: Stale one-shot job after downtime
- **GIVEN** an enabled one-shot job (`at: "2026-03-16T00:00Z"`) with past timestamp
- **WHEN** daemon starts
- **THEN** the job is disabled (`enabled = false`) with reason `"expired_on_boot"`

#### Scenario: Stale job with consecutive errors
- **GIVEN** an enabled recurring job with `consecutiveErrors = 3` and stale `nextRunAtMs`
- **WHEN** daemon starts
- **THEN** `nextRunAtMs = max(skip-to-next, now + backoffMs(3))` — retry backoff is respected

### Requirement: Channel isolation

Channels SHALL provide independent execution contexts for concurrent agent conversations.

#### Scenario: Create channel with custom lane policy
- **GIVEN** a POST to `/api/v2/channel/` with `lanePolicy: { main: 2, cron: 1, subagent: 3, nested: 1 }`
- **WHEN** the channel is created
- **THEN** the channel has its own lane set with the specified concurrency limits

#### Scenario: Cross-channel lane isolation
- **GIVEN** channel A with `main: 1` fully occupied
- **WHEN** channel B enqueues a Main task
- **THEN** channel B's task executes immediately (channel A's occupancy doesn't block B)

#### Scenario: Default channel backward compatibility
- **GIVEN** no explicit channel specified on session creation
- **WHEN** a session is created
- **THEN** it belongs to the `"default"` channel with current global lane limits (Main=1, Cron=1, Subagent=2, Nested=1)

### Requirement: Channel-scoped kill-switch

Kill-switch SHALL support both global and channel-scoped triggers.

#### Scenario: Channel-scoped emergency stop
- **GIVEN** channels A and B, both with active sessions
- **WHEN** abort-all is called with `channelId: "A"`
- **THEN** only channel A sessions are aborted; channel B continues running

#### Scenario: Global emergency stop overrides channel scope
- **GIVEN** channels A and B, channel A has a channel-scoped kill-switch active
- **WHEN** global abort-all is called (no channelId)
- **THEN** all sessions across all channels are aborted

### Requirement: Daemon health with channel info

Daemon health endpoint SHALL report per-channel status.

#### Scenario: Health includes channel breakdown
- **GIVEN** channels A and B with different active task counts
- **WHEN** `GET /api/v2/global/health` is called
- **THEN** response includes `channels: [{ id, name, lanes: {...}, activeTasks }]`

## Acceptance Checks

- Daemon restart preserves cron job schedules (no manual re-registration needed)
- Stale one-shot jobs are auto-disabled on boot
- Stale recurring jobs skip to next future fire time
- Two channels can run Main tasks concurrently (impossible with global lanes)
- Channel-scoped kill-switch only affects target channel
- Global kill-switch stops all channels
- Default channel behavior is identical to current non-channel behavior
- Health endpoint returns channel-level lane info
