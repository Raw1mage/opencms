# Design: safe-daemon-restart

## Context

Gateway（C 程式，`/usr/local/bin/opencode-gateway`）以 root 執行，per-user fork+setuid 出 bun daemon，socket 於 `/run/user/<uid>/opencode/daemon.sock`。Gateway 用 `DaemonInfo` array 追蹤每個 user 的 daemon（state + pid + socket_path）。

目前問題鏈：

1. AI agent 用 Bash 跑 `webctl.sh dev-start` → spawn 了一個 gateway 不知道的 bun daemon（orphan）
2. 該 daemon 取得 gateway lock（`flock`）並綁 socket
3. 舊的 gateway-managed daemon 死了 / gateway 重啟 → 對新 orphan 一無所知
4. 使用者請求 → gateway 看自己的 `DaemonInfo.state=NONE` → 嘗試 adopt，connect 失敗（socket 檔被 unlink 或不可連）→ spawn 新 daemon
5. 新 daemon 搶不到 gateway lock → 立刻 exit 1
6. waitpid 收到 `ECHILD`（因為被 init 收養）→ 15s timeout → 清 JWT 踢登入

## Goals / Non-Goals

### Goals
- AI 有一條**唯一合法**的 self-restart 路徑
- Gateway 不論 orphan 怎麼製造出來，都能自癒
- Socket 父目錄消失不再是隱性失敗模式

### Non-Goals
- 重寫 gateway（補丁式改動）
- 改 daemon 主程式生命週期（只補 graceful shutdown 若缺）
- 處理跨機器多副本情境

## Decisions

- **DD-1** `restart_self` 走 **gateway HTTP admin endpoint**，不在 daemon 內處理。
  理由：daemon 自己處理會踩斷腳；gateway 是 lifecycle authority。
- **DD-2** Restart 流程為 **SIGTERM → 2s waitpid → SIGKILL → unlink(socket) → clear DaemonInfo**。
  理由：2s 對 bun daemon graceful shutdown 足夠；過長會拖使用者。
- ~~**DD-3** Orphan cleanup 用 **flock holder 偵測**（`fcntl(F_OFD_GETLK)` on the lock file），而非 process-scan，因為 flock 是既有單例保證機制。
  Fallback：若 lockfile 不存在，掃 `ss -xlp` 找持有 socket path 的 pid。~~ (v1, SUPERSEDED 2026-04-21 by DD-3b)
- **DD-3b** Orphan cleanup 用 **PID-file 讀取**（2026-04-21, amended from DD-3）。Codebase 的 "gateway lock" 是 `~/.config/opencode/daemon.lock` 的 JSON file（`{pid, acquiredAtMs}`）+ `process.kill(pid, 0)` liveness，不是 kernel `flock()`。正確偵測：讀 JSON → 取 pid → 驗 `/proc/<pid>` st_uid == target_uid → 返回 pid。
  理由：`fcntl(F_OFD_GETLK)` 會永遠回「沒人鎖」；實作時才發現。
  安全性：`/proc/<pid>` uid 檢查擋 pid 回收 + 跨 uid 攻擊面。
- **DD-4** Runtime-dir 保證執行在 **gateway 側（root）**，fork 前以 `mkdir -p` + `chown` 到目標 uid，避免 child setuid 後無權建立。
  理由：`/run/user/<uid>/` 是 0700 owned by uid，root 也需先建再移交。
- **DD-5** `execute_command` 的 denylist 用 **regex prefix match + argv 檢查**，而非純字串 contains。
  匹配：`webctl\.sh\s+(dev-start|dev-refresh|dev-stop)`、`\bbun\b.*\bserve\b.*--unix-socket`、`\bkill\s+-?\w*\s+<pid-of-daemon>`。
- **DD-6** `restart_self` **非同步**——回 202 立刻，真正的 kill/respawn 在 gateway 背景執行。
  理由：讓 MCP 不會因為 SIGKILL 自己而連線被掐斷還沒收到回應。
- **DD-7** SSE 重連靠**前端現有邏輯**（登入 cookie 仍在，daemon 重生後下一次 ping 就重連），不為此功能新寫重連層。
- **DD-8** AGENTS.md 新增一條 top-level 規則：「AI 禁止自行 spawn / kill / restart daemon 行程；restart 必須透過 `restart_self` tool」。

## Risks / Trade-offs

- **R1** Gateway 的 HTTP endpoint 送 SIGKILL 給正在處理 restart_self 請求的 daemon，可能造成 MCP stdio 連線中斷，tool 回應送不出去。
  Mitigation：DD-6 非同步 + 202 Accepted；tool 側不依賴 daemon 回應 200 才認為成功。
- **R2** Flock 偵測在 Linux 不同 kernel / fs 行為不一致。
  Mitigation：`F_OFD_GETLK` + `ss` 雙路徑；任一成功即可。
- **R3** Denylist bypass（AI 用 `bash -c '...'` 繞過 argv 檢查）。
  Mitigation：execute_command 本來就不該讓 AI 執行任意 bash；denylist 是防呆不是安全邊界。真正的 hard gate 是 AGENTS.md + code review。
- **R4** `/run/user/<uid>/` mkdir 需要 root，但 gateway spawn flow 是 fork 後設 uid 再 exec；目前順序必須保證 mkdir 在 fork 前或 child setuid 前完成。
  Mitigation：DD-4 明確放 root context 執行。

## Critical Files

- `daemon/opencode-gateway.c`
  - `resolve_runtime_dir()` (line ~715-770) — 擴充 `mkdir -p opencode/` 子目錄
  - `ensure_daemon_running()` (line ~1491) — 加 orphan detect + cleanup
  - 新增 HTTP route handler for `/api/v2/global/restart-self`
- `packages/mcp/system-manager/src/index.ts`
  - tools array (line ~417) — 新增 `restart_self` tool
  - `execute_command` handler (line ~825) — 加 denylist
- `AGENTS.md` — 新條款
- `specs/architecture.md` — daemon lifecycle authority 小節
- `docs/events/event_2026-04-20_daemon-orphan.md` — 事件記錄

## Open Questions

- O1. Gateway HTTP endpoint 的 auth：沿用現有 JWT 驗證即可？還是需要 admin scope？（傾向：JWT 所屬 uid 必須等於目標 daemon uid，不需另開 scope）
- O2. Restart 期間 gateway 要不要阻擋新請求（return 503 restart-in-progress）？還是直接等 spawn 完成？（傾向：阻擋 2-3s 比讓使用者體驗 cold-start 好）
