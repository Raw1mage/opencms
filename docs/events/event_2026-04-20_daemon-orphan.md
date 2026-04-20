# Event — Daemon orphan / user kicked to login (2026-04-20)

## Symptom

使用者 pkcs12 在 web UI 被持續踢回登入頁；每次重新登入幾秒後又被踢。發生多次。

## Timeline

- ~19:54 起 `/var/log/opencode-gateway` 開始反覆列印 `waitpid ECHILD for pkcs12 pid 95814 — child may have been reaped, checking socket`，每 15s 一次 `daemon did not become ready within 15000ms` → `clearing JWT and redirecting to login`。
- 20:15 使用者回報問題；我介入診斷。

## Root cause

1. **19:54** AI agent（前一會話）透過 Bash tool 跑 `webctl.sh dev-start`（或等效指令），spawn 了一個獨立的 bun daemon（pid 31934）。該 daemon 綁住 unix socket + 寫 `~/.config/opencode/daemon.lock` 聲稱自己持有 gateway lock。
2. Gateway 之後（systemd 重啟或其他原因）失去對 pid 31934 的追蹤，`DaemonInfo.state = NONE`。
3. 使用者 HTTP 請求觸發 `ensure_daemon_running` → `try_adopt_from_discovery` 失敗（socket 檔可能被 tmpfs 或手動 rm 過，但 31934 kernel listener 還在）。
4. Gateway fork 新 daemon。新 daemon 啟動 → 呼叫 `GatewayLock.acquire()` → 讀 `daemon.lock` → `isProcessRunning(31934) === true` → **refuse**，exit 1。
5. 新 daemon 是 gateway 的 child，但因設了 `setsid()` + 快速 exit，gateway 的 `waitpid` 常回 ECHILD（init 或其他代收）。Loop 15s 後 gateway 認定 daemon 沒起來，清 JWT + 302 到 login。
6. 使用者重新登入 → 請求進來 → 又循環第 4 步 → 又被踢。直到我 `kill 31934`，下一次請求才 spawn 成功。

## Why it kept happening

- Gateway `ensure_daemon_running` 沒有偵測 orphan lock-holder 的邏輯。`adopt failed` 直接走 spawn，永遠撞 lock。
- Daemon lock 是 PID JSON file（`packages/opencode/src/daemon/gateway-lock.ts`）不是 kernel flock，所以原本以為 `fcntl(F_OFD_GETLK)` 能偵測的思路不適用。
- `/run/user/1000/opencode/` 在 tmpfs 清理後不會自動重建，加劇 adopt 失敗的機率。
- AI 透過 Bash tool 自行 spawn daemon 的能力從未被限制；這次不是第一次發生，只是第一次造成使用者可見衝擊。

## Fix (spec: `specs/safe-daemon-restart/`)

- **Phase 1** — Gateway C 補三個 helper + 接入 `ensure_daemon_running`:
  - `ensure_socket_parent_dir()` — spawn 前 mkdir+chown+chmod 0700 socket 父目錄
  - `detect_lock_holder_pid()` — 讀 daemon.lock JSON，驗 `/proc/<pid>` uid
  - `cleanup_orphan_daemon()` — SIGTERM → poll → SIGKILL → reap（含 `waitpid WNOHANG` 防殭屍）
  - 單元測試 9 個斷言全過
- **Phase 2** — `/api/v2/global/web/restart` gateway-daemon 分支改成**先跑 webctl rebuild 再自殺**（原本只自殺不 rebuild）；exit ≠ 0 回 5xx 不自殺；stderr 帶「already in progress」→ 409；接受 `targets?` 指定要不要 `--force-gateway`。
- **Phase 3** — 新增 `system-manager:restart_self` MCP tool，只是薄層 POST 這個既有 endpoint；失敗不做本地 fallback。
- **Phase 4** — Bash tool 加 `DAEMON_SPAWN_DENYLIST`，擋 `webctl.sh (dev-start|restart|...)`、`bun serve --unix-socket`、`opencode serve`、`systemctl restart opencode-gateway`、針對 daemon pid 的 `kill`。14 個單元測試全過。
- **Phase 5** — AGENTS.md + architecture.md 正式定義「Daemon Lifecycle Authority」原則；事件記錄留在此檔。

## Forbidden going forward

AI 不准用 Bash 自行 spawn / kill / restart opencode daemon 或 gateway。要改 code 讓它生效 → `restart_self` tool。

## Related

- Fix branch: `beta/safe-daemon-restart-20260421`
- Spec: `specs/safe-daemon-restart/`
- Phase 1 event: `docs/events/event_2026-04-21_safe-daemon-restart_phase1.md`
- Scope revise event: `docs/events/event_2026-04-21_safe-daemon-restart_revise.md`
