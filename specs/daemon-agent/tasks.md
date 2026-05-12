# Tasks

## 1. Infrastructure

- [ ] 1.1 確認 `ProcessSupervisor` kind 列表，新增 `"daemon"` kind
- [ ] 1.2 在 `task-worker-continuation.ts` 加入 daemon kind guard：kind="daemon" 不走 completion handoff

## 2. DaemonStore & Runner

- [ ] 2.1 建立 `packages/opencode/src/daemon/agent-daemon.ts`：DaemonStore（JSON persistence）、register / recover / unregister
- [ ] 2.2 Daemon condition loop：初期支援 file watch（fs.watch）和 log pattern match（tail + regex）
- [ ] 2.3 條件觸發時 `Bus.publish(DaemonAgentEvent.Triggered, { sessionID, condition, detail })`
- [ ] 2.4 複用 `cron/delivery.ts` announce 路徑將 DaemonAgentEvent 通知送達 operator

## 3. Lifecycle

- [ ] 3.1 在 `daemon/index.ts` startup 加入 `DaemonStore.recover()` —— re-spawn 已登記的 daemon sessions
- [ ] 3.2 驗證：daemon session 在 ProcessSupervisor snapshot 中持續存在；restart 後自動恢復；條件觸發後 5 秒內通知送達
