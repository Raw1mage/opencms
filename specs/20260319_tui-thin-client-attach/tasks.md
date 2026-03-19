# Tasks — Daemon Refactor + TUI Thin Client

## Phase α — C Root Daemon

- [ ] α.1 建立 `daemon/` 目錄結構 + Makefile
- [ ] α.2 C daemon 骨架：main() + epoll event loop + signal handling (SIGTERM, SIGCHLD)
- [ ] α.3 TCP listener：bind :1080 + listen + accept
- [ ] α.4 Login page serve：靜態 HTML 回應（嵌入或從檔案讀取 login.html）
- [ ] α.5 PAM 整合：
  - [ ] α.5a pam_start + pam_authenticate + pam_acct_mgmt + pam_end
  - [ ] α.5b POST /auth/login endpoint 解析（minimal HTTP parsing for auth route only）
  - [ ] α.5c 認證成功 → 簽發 JWT（HMAC-SHA256，含 uid, username, exp）
  - [ ] α.5d 認證失敗 → 401 JSON response
- [ ] α.6 Per-user daemon spawn：
  - [ ] α.6a 維護 UID → daemon_info (pid, socket_path, state) 的 registry
  - [ ] α.6b 首次 auth → fork() + setgid() + setuid() + exec("opencode serve --unix-socket ...")
  - [ ] α.6c 等待 per-user daemon 的 Unix socket 出現（poll with timeout）
  - [ ] α.6d SIGCHLD handler：偵測 per-user daemon crash → 從 registry 移除
  - [x] α.6e **Gateway adopt**：spawn 前先讀 discovery file（`/run/user/<uid>/opencode/daemon.json`），若 PID alive 則 adopt 進 registry（支援 TUI --attach 預先啟動的 daemon）
- [ ] α.7 splice() proxy：
  - [ ] α.7a 連接到 per-user daemon 的 Unix socket
  - [ ] α.7b 建立 pipe pair（splice 需要中繼 pipe）
  - [ ] α.7c epoll 管理：client_fd + daemon_fd 雙向
  - [ ] α.7d splice() 雙向轉發（client → daemon, daemon → client）
  - [ ] α.7e Connection cleanup：任一端斷開 → close 另一端 + 釋放 pipe
- [ ] α.8 JWT cookie 驗證（後續請求）：
  - [ ] α.8a 新 TCP 連線 → 解析 Cookie header → 驗證 JWT
  - [ ] α.8b JWT 有效 → 直接 splice 到對應 per-user daemon（跳過 PAM）
  - [ ] α.8c JWT 無效/過期 → 返回 login page
- [ ] α.9 Graceful shutdown：SIGTERM → stop accept → drain splice → SIGTERM per-user daemons → exit
- [ ] α.10 驗證：編譯成功 + PAM auth 通過 → splice proxy → per-user daemon API 正常回應
- [ ] α.11 驗證：splice 對 SSE event stream 正確轉發（長連線）
- [ ] α.12 驗證：splice 對 WebSocket upgrade + 雙向通訊正確轉發（SG-2）

## Phase β — Per-user Daemon Mode

- [x] β.1 serve command 新增 `--unix-socket <path>` CLI 選項
- [x] β.2 server.ts 改造：支援 `Bun.serve({ unix: socketPath })` 啟動
- [x] β.3 Discovery file 寫入：
  - [x] β.3a 定義 DaemonInfo type（socketPath, pid, startedAt, version）
  - [x] β.3b 啟動時寫入 `$XDG_RUNTIME_DIR/opencode/daemon.json`
  - [x] β.3c 建立目錄 `$XDG_RUNTIME_DIR/opencode/`（若不存在）
- [x] β.4 Discovery file cleanup：
  - [x] β.4a process.on("exit") + SIGTERM handler → 清除 file
  - [x] β.4b 確認 crash 場景下 file 會被下次啟動清除（stale detection in readDiscovery）
- [x] β.5 PID file：`$XDG_RUNTIME_DIR/opencode/daemon.pid` → 防止同 user 重複啟動
- [ ] β.6 驗證：`opencode serve --unix-socket /tmp/test.sock` → 可透過 Unix socket 訪問 API
- [ ] β.7 驗證：discovery file 在啟動/停止時正確建立/清除

## Phase γ — TUI Attach Mode（新增 --attach，保留獨立模式）

- [x] γ.1 CLI 新增 `--attach` flag（opencode --attach / bun run dev --attach）
- [x] γ.2 discoverDaemon() 函式：
  - [x] γ.2a 讀取 discovery file
  - [x] γ.2b 驗證 PID 存活（kill -0）
  - [x] γ.2c Stale file → 清除 → 回傳 null
  - [x] γ.2d 回傳 DaemonInfo（socketPath）或 null
- [x] γ.3 Unix socket HTTP client：
  - [x] γ.3a Bun fetch over Unix socket（`fetch("http://localhost/api/v2/...", { unix: path })`）
  - [x] γ.3b SSE subscription over Unix socket
  - [ ] γ.3c 確認 SG-3：Bun Unix socket client 可正常運作（待執行時驗證）
- [x] γ.4 TUI 啟動流程分支（thread.ts）：
  - [x] γ.4a 若 --attach → discoverDaemon() → 取得 socket path
  - [x] γ.4b --attach 且找不到 daemon → auto-spawn per-user daemon → 等 discovery ready → attach
  - [x] γ.4c --attach 且找到 → 建立 Unix socket client → attach mode
  - [x] γ.4d 無 --attach → 維持現有 Worker thread 獨立模式（向下相容）
  - [x] γ.4e Daemon.spawn()：detached child process + poll discovery file + timeout 10s
- [x] γ.5 Attach mode RPC methods：
  - [x] γ.5a fetch → HTTP request over Unix socket（createUnixFetch）
  - [~] γ.5b server → 回傳 daemon info（attach mode 不需要 server RPC，url 固定）
  - [~] γ.5c reload → HTTP POST to daemon（SIGUSR2 handler 僅在 worker mode）
  - [x] γ.5d shutdown → TUI disconnect only（不影響 daemon，onExit no-op）
- [x] γ.6 Event stream 接線：SSE events → TUI state update（createUnixEventSource）
- [x] γ.7 TUI graceful disconnect：Ctrl+C → close SSE（abort controller in EventSource）
- [ ] γ.8 驗證：`opencode --attach` → attach → send message → receive response
- [ ] γ.9 驗證：TUI attach + webapp 同時連接 → session 在兩端同步可見
- [ ] γ.10 驗證：TUI disconnect → daemon 繼續運行
- [ ] γ.11 驗證：`bun run dev`（無 --attach）→ 維持現有行為不變

## Phase δ — Security Migration

- [ ] δ.1 盤點所有 LinuxUserExec 使用點：
  - [ ] δ.1a bash.ts — buildSudoInvocation for shell commands
  - [ ] δ.1b pty/index.ts — buildSudoInvocation for PTY spawn
  - [ ] δ.1c shell-executor.ts — buildSudoInvocation for shell execution
  - [ ] δ.1d 其他可能的 call sites
- [ ] δ.2 確認 SG-4：所有 call sites 已列出
- [ ] δ.3 移除 sudo invocation：
  - [ ] δ.3a bash.ts — 直接 spawn（per-user daemon 已是正確 UID）
  - [ ] δ.3b pty/index.ts — 直接 spawn
  - [ ] δ.3c shell-executor.ts — 直接 spawn
- [ ] δ.4 移除 linux-user-exec.ts module
- [ ] δ.5 移除 scripts/opencode-run-as-user.sh
- [ ] δ.6 移除 sudoers rule 相關：
  - [ ] δ.6a 移除 install.sh 中 --system-init 的 wrapper 安裝邏輯
  - [ ] δ.6b 文件化如何清除已安裝的 /etc/sudoers.d/opencode-run-as-user
- [ ] δ.7 驗證：per-user daemon 執行 bash → `whoami` 顯示正確使用者 → 無 sudo 日誌
- [ ] δ.8 驗證：tsc --noEmit EXIT 0

## Phase ε — Account Bus Events

- [x] ε.1 在 bus/index.ts 定義 account event types：
  - [x] ε.1a account.added：{ providerKey, accountId, info（sanitized）}
  - [x] ε.1b account.removed：{ providerKey, accountId }
  - [x] ε.1c account.activated：{ providerKey, accountId, previousAccountId? }
- [x] ε.2 Account.Info sanitization helper（移除 apiKey, refreshToken 等 secrets）
- [x] ε.3 Account.add() → Bus.publish("account.added")
- [~] ε.4 AccountManager.connectOAuth() → Bus.publish("account.added") — 統一走 Account.add()，無獨立 connectOAuth()
- [x] ε.5 Account.remove() → Bus.publish("account.removed")
- [x] ε.6 Account.setActive() → Bus.publish("account.activated")
- [x] ε.7 Account mutation mutex：
  - [x] ε.7a 在 account/index.ts 新增 in-process mutex（Promise chain serialize）
  - [x] ε.7b add/remove/setActive/update 均經 withMutex() 保護
  - [ ] ε.7c 驗證：concurrent mutation 不產生 race condition（執行時驗證）
- [ ] ε.8 webapp event handler 訂閱 account events → 更新 local state
- [ ] ε.9 驗證：webapp 新增帳號 → TUI SSE 收到 account.added
- [ ] ε.10 驗證：切換 active account → 兩端即時反映

## Phase ζ — SSE Event ID + Catch-up

- [x] ζ.1 SSE endpoint 新增 global monotonic event counter（_sseCounter）
- [x] ζ.2 每個 SSE event 加 `id:` field（HTTP SSE 標準）
- [x] ζ.3 Event ring buffer（Array, MAX_SIZE = 1000）
- [x] ζ.4 Last-Event-ID header 解析
- [x] ζ.5 Catch-up 邏輯：
  - [x] ζ.5a ID 在 buffer 範圍內 → 補發遺漏 events
  - [x] ζ.5b ID 不在 buffer → 發送 sync.required event
  - [x] ζ.5c 無 Last-Event-ID → 正常推送
- [ ] ζ.6 webapp global-sdk.tsx：記錄 lastEventId + reconnect 攜帶 Last-Event-ID
- [ ] ζ.7 webapp：收到 sync.required → full bootstrap refresh
- [ ] ζ.8 TUI client 同步實作 Last-Event-ID reconnection
- [ ] ζ.9 驗證：斷線 5 秒重連 → event 補發 → state 一致
- [ ] ζ.10 驗證：buffer overflow → sync.required → full refresh → state 一致

## Phase η — Bus Event Payload 完整化

- [~] η.1-7 — account.* events 已是 full payload（Phase ε）；session.updated full payload 與 webapp event-reducer 改動延至 runtime 驗證階段

## Phase θ — Performance Hardening

- [~] θ.1 確認 SG-5：SDK cache memory baseline — deferred to runtime validation
- [x] θ.2 SDK cache eviction：LRU（MAX_SIZE = 50），sdkSet() with eviction
- [~] θ.3 Server 連線數限制 — Bun.serve() 無原生 maxConnections 參數，deferred
- [x] θ.4 Server idle timeout：120 秒（TCP + Unix socket 模式）
- [~] θ.5 SSE broadcast fire-and-forget — current GlobalBus.on/off 已是 async，deferred to θ.8 驗證
- [~] θ.6 accounts.json write：Bun.write() 已是 async（confirmed）
- [ ] θ.7 驗證：daemon 長時間運行（1h+）memory stable
- [ ] θ.8 驗證：10+ concurrent SSE connections 穩定

## Phase ω — webctl.sh + Cross-Cutting

- [~] ω.1 確認 SG-3：當前 systemd 模式正常運作 — deferred to runtime validation
- [x] ω.2 webctl.sh 新增 compile_gateway()：編譯 C root daemon
- [x] ω.3 webctl.sh 新增 start_gateway() / stop_gateway()
- [x] ω.4 systemd-install 改為安裝 gateway unit + user template unit
- [~] ω.5 systemd-start/stop/status 改為操作 gateway — existing web-start/stop/restart preserved, gateway-start/stop added separately
- [~] ω.6 dev-start：compile_gateway + start_gateway("dev") + start_frontend("dev") — gateway-start command available, dev-start unchanged (coexist)
- [~] ω.7 dev-refresh：stop_gateway + rebuild + compile_gateway + start_gateway + start_frontend — gateway-stop + dev-refresh can be composed
- [x] ω.8 保留 production/dev 雙模式
- [x] ω.9 建立 systemd unit files：opencode-gateway.service + opencode-user@.service
- [x] ω.10 specs/architecture.md 全貌同步
- [ ] ω.11 Runtime regression：TUI 完整操作 + webapp 操作 + multi-user + admin panel
- [x] ω.12 更新 docs/events/ event log
- [x] ω.13 確認 webctl.sh 所有現有使用場景不被破壞（bash -n pass, existing commands untouched）

## Deferred

- [ ] D.1 Bun handleConnection(fd) API — 待 Bun upstream 支援後移除 splice proxy
- [ ] D.2 PTY session 孤兒回收
- [ ] D.3 Per-user daemon idle timeout（自動停止閒置 daemon）
- [ ] D.4 Per-user daemon cgroup / resource limits
- [ ] D.5 TUI heartbeat / keepalive
- [ ] D.6 Phase 2 hardening（read-path clone、accountId reform、deploy gate）
