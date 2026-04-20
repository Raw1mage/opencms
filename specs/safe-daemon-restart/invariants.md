# Invariants: safe-daemon-restart

| ID | Invariant | Enforcement point |
|---|---|---|
| INV-1 | 每個 uid 最多一隻活的 bun daemon | gateway.lock（flock）+ orphan cleanup |
| INV-2 | Daemon 的 pid 必須同時在 `DaemonInfo.pid` 裡，gateway 從未失去對其認知 | 只有 gateway fork 出 daemon；denylist 擋 AI 自行 spawn |
| INV-3 | Socket file 存在 ⇔ daemon alive & listening | daemon 啟動時 bind、SIGTERM 時 unlink；gateway 在 clear DaemonInfo 時也 unlink |
| INV-4 | `/run/user/<uid>/opencode/` 存在 ⇒ owner=uid, mode=0700 | gateway spawn 前 `mkdir + chown + chmod` |
| INV-5 | Restart 流程中 MCP tool 回應一定先於 daemon 被 SIGKILL 離線 | DD-6 非同步 202 Accepted |
| INV-6 | JWT uid 必須 = 目標 daemon uid | gateway endpoint 驗證 |

違反任一 invariant 都是 P0 bug，需要回到 design 層面處理。
