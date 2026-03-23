# Proposal: Scheduler Persistence + Daemon Rewrite

## Why

OpenCode 的 cron 子系統（D.1-D.3）已交付完整的 job session、heartbeat、daemon lifecycle。但兩個核心缺口阻擋了 daemon mode 進入實用階段：

1. **Scheduler 重啟遺失 runtime context** — CronStore 確實 write-through 到 `jobs.json`（job 定義 + state 都有 persist），但 `Scheduler.register()` 用的是 `setInterval`，daemon restart 後需要從 persisted state 重建排程。如果 `nextRunAtMs` 已過期（長時間 downtime），需要 catchup 或 skip 策略。`SystemEvents` 純 in-memory，restart 後全丟。

2. **Daemon 缺乏 multi-channel 能力** — 目前 session 模型是 flat list，沒有「頻道」概念。Daemon mode 下需要支援多個獨立的 agent 對話同時執行（例如：一個在做 code review，另一個在跑 test，第三個在做 migration），每個 channel 有自己的 lane allocation 和 kill-switch scope。

## Original Requirement Wording (Baseline)

> "recurring scheduler persistence — Cron job 目前是 in-memory，daemon 重啟就丟失。開新 spec，用 JSON file store 或 SQLite 做持久化"
> "daemon rewrite + channel features — handoff.md 裡列的 daemon mode 完善、multi-channel 等"

## Requirement Revision History

- 2026-03-17: 初始需求合併為單一 spec

## Effective Requirement Description

1. Daemon restart 後，所有 enabled cron jobs 的排程狀態必須自動恢復（nextRunAtMs, consecutiveErrors, lastRunAtMs）
2. 長時間 downtime 後的 stale schedule 必須有明確的 catchup/skip 策略
3. SystemEvents queue 在 restart 後要能重建或安全清空（acceptable loss）
4. Daemon mode 支援多個 channel（獨立 agent 對話），每個 channel 有獨立的 session scope
5. Channel 之間有 lane isolation — 一個 channel 的 agent turn 不會擠壓另一個 channel 的 concurrency
6. Kill-switch 可以按 channel scope 或 global scope 觸發

## Scope

### IN
- Scheduler recovery on daemon boot（讀 CronStore → 重建 setInterval）
- Stale nextRunAtMs catchup 策略（skip-to-next vs execute-missed）
- Channel 資料模型（Channel.Info schema, CRUD, persistence）
- Per-channel lane allocation
- Per-channel kill-switch scope
- Daemon health endpoint 擴充（channel list, per-channel status）

### OUT
- SQLite migration（先用 JSON file store，跟 CronStore 一致）
- Web UI / TUI channel management 介面（本 spec 只做 backend + API）
- Channel 之間的 message routing / forwarding
- 跨 channel 的 shared context
- SystemEvents 持久化（acceptable loss on restart，只需清空重建）

## Non-Goals

- 不做 multi-node daemon（單機單進程）
- 不做 job queue 持久化（Lanes 是 in-memory FIFO，restart 就清空，由 scheduler recovery 重新觸發）
- 不做 cron expression parser 重寫（現有 Schedule module 夠用）

## Constraints

- 不引入新的外部依賴（已移除 aws4fetch/ioredis）
- Channel persistence 用 JSON file store（`~/.config/opencode/channels/`）
- 與現有 kill-switch + drain + lanes 共存，不破壞已有行為
- 實作在 `~/projects/opencode-runner` 的新 branch，最終 merge 回 `~/projects/opencode` 的 `cms`

## What Changes

- `cron/heartbeat.ts` — boot recovery: 讀 persisted state → 重算 stale schedule → 重新註冊
- `daemon/index.ts` — boot sequence 加入 scheduler recovery step
- `daemon/lanes.ts` — per-channel lane namespace
- New: `channel/` module — Channel.Info type, ChannelStore (JSON file), channel lifecycle
- `server/routes/session.ts` — channel-scoped session creation
- `server/killswitch/service.ts` — channel-scoped kill-switch

## Capabilities

### New Capabilities
- **Scheduler Recovery**: daemon restart 後自動恢復 cron job 排程
- **Stale Schedule Handling**: 長 downtime 後依據 job config 選擇 skip-to-next 或 execute-once
- **Channel**: 獨立的 agent 對話頻道，有自己的 session pool 和 lane allocation
- **Channel-scoped Kill-switch**: 可以只停一個 channel 而不影響其他 channel

### Modified Capabilities
- **Daemon Boot**: 增加 scheduler recovery 和 channel restoration 步驟
- **Lanes**: 從 global 4-lane 變為 per-channel lane set
- **Health Endpoint**: 增加 channel 維度的狀態回報

## Impact

- `packages/opencode/src/cron/` — heartbeat boot recovery
- `packages/opencode/src/daemon/` — boot sequence, lane namespace
- `packages/opencode/src/channel/` — new module
- `packages/opencode/src/server/routes/` — channel API endpoints
- `packages/opencode/src/server/killswitch/` — channel scope extension
- `specs/20260316_kill-switch/runbook.md` — channel-scoped trigger paths
