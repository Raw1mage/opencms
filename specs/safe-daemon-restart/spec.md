# Spec: safe-daemon-restart

## Purpose

消除「AI 自殺式重啟 → orphan daemon → 使用者被踢出登入」的循環。把 daemon 生命週期控制權收斂到 gateway，並在 gateway 側補上自癒與 runtime 目錄保證。

## Requirements

### Requirement: RESTART-001 AI 可透過正式 tool 請求自重啟

- **GIVEN** 一個 AI agent 在 daemon context 中執行
- **WHEN** 呼叫 `system-manager:restart_self` tool
- **THEN** MCP tool 會對 gateway 的 `/api/v2/global/restart-self` 發 POST（帶當前 JWT）
- **AND** gateway 回 `202 Accepted` 後異步對當前 daemon pid 執行 SIGTERM → 2s waitpid → SIGKILL
- **AND** gateway 清空 `DaemonInfo` 狀態並 `unlink(socket_path)`
- **AND** 下一個使用者請求進來會觸發乾淨的 spawn

#### Scenario: 正常 graceful restart
- **GIVEN** daemon 健康運作、無 in-flight 關鍵寫入
- **WHEN** AI 呼叫 restart_self
- **THEN** daemon 在 2 秒內於 SIGTERM 下收工退出
- **AND** 下一次請求成功 spawn 新 daemon（`DAEMON_READY`）
- **AND** 使用者瀏覽器的 SSE 自動重連，不被踢登入

#### Scenario: daemon hang 時的強制終結
- **GIVEN** daemon 因為某原因 SIGTERM 後 2s 內沒退出
- **WHEN** waitpid timeout
- **THEN** gateway 送 SIGKILL 並繼續清理流程
- **AND** event log 記錄 `forced-kill`

### Requirement: RESTART-002 Daemon 禁止 spawn 自己或兄弟

- **GIVEN** AI agent 透過 `system-manager:execute_command` 或 Bash 嘗試跑 `webctl.sh dev-start` / `bun ... serve --unix-socket` / `kill <daemon-pid>`
- **WHEN** MCP tool 解析指令
- **THEN** 命中 denylist 的指令**立即拒絕**，回錯誤訊息引導使用者改用 `restart_self`
- **AND** 不執行任何 side effect

### Requirement: RESTART-003 Gateway 自癒 flock orphan

- **GIVEN** 有一個 bun daemon process 持有 `/home/<user>/.local/share/opencode/gateway.lock`（或其等效 flock），但 gateway 的 `DaemonInfo.state ∈ {NONE, DEAD}`
- **WHEN** `ensure_daemon_running` 要 spawn 但 `try_adopt_from_discovery` 失敗
- **THEN** gateway **先**偵測 flock holder PID（透過 `fcntl(F_OFD_GETLK)` 或讀 `/proc/*/fd/` 掃 socket path）
- **AND** 若 holder PID 存在且屬於目標 uid：送 SIGTERM → 1s waitpid → SIGKILL
- **AND** 接著才 `unlink(socket_path)` + fork 新 daemon
- **AND** event log 記錄 `orphan-cleanup: pid=<N>`

### Requirement: RESTART-004 Runtime 目錄必被保證存在

- **GIVEN** 使用者登入成功（JWT 簽發）
- **AND** `/run/user/<uid>/opencode/` 不存在（被 tmpfs 清掉 / 首次 spawn / WSL 重啟）
- **WHEN** gateway 進入 daemon spawn flow
- **THEN** 在 fork 前 gateway 先 `mkdir -p /run/user/<uid>/opencode` 並 `chown <uid>:<gid>` 並 `chmod 0700`
- **AND** 父層 `/run/user/<uid>` 缺失時也一併 `mkdir`（既有 `resolve_runtime_dir` 行為）
- **AND** spawn 才進行；socket 父目錄缺失不再是沉默失敗

### Requirement: RESTART-005 觀測性最低線

- **GIVEN** 任一 restart / orphan cleanup / runtime-dir recreate 事件
- **WHEN** 事件發生
- **THEN** gateway log 以 `[INFO ]` 或 `[WARN ]` 寫入可 grep 關鍵字：`restart-self`, `orphan-cleanup`, `runtime-dir-created`
- **AND** 每個事件含 uid / pid / socket_path / reason
- **AND** restart_self 的 MCP 回應也帶 `eventId` 讓 AI 可追蹤

## Acceptance Checks

- A1. curl `/api/v2/global/restart-self` 帶合法 JWT → 202 + 實際 daemon 重啟 + 新 pid ≠ 舊 pid
- A2. 手動啟一個 orphan bun daemon（持 flock），gateway 請求觸發 → orphan 被 kill、新 daemon 起來、使用者不被踢
- A3. `rm -rf /run/user/1000/opencode/` 後觸發請求 → 目錄自動重建、daemon 正常 spawn
- A4. AI 在 execute_command 輸入 `webctl.sh dev-start` → 被 denylist 擋 + 回傳明確錯誤
- A5. restart_self 呼叫期間的 SSE 連線在 新 daemon 起來後 ≤ 5s 自動重連
- A6. 所有路徑觀察到對應 log keyword，事件可追蹤
