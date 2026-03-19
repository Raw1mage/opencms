# Spec

## Purpose

建立安全的 per-user process isolation，讓 TUI 和 webapp 共享同一個 per-user daemon，消除 sudo-n 全域特權風險和多 client state desync 問題。

## Requirements

### Requirement: C Root Daemon Auth Gateway (R1)

C root daemon SHALL 在固定 port 監聽，處理 PAM 認證，並透過 splice() 將已認證連線 proxy 到 per-user daemon。

#### Scenario: Successful login

- **GIVEN** C root daemon 在 :1080 監聽
- **WHEN** 使用者透過 login page 提交正確的 PAM 帳密
- **THEN** root daemon 簽發 JWT cookie、spawn per-user daemon（若不存在）、建立 splice proxy，使用者看到完整 opencode webapp

#### Scenario: Failed login

- **GIVEN** C root daemon 在 :1080 監聽
- **WHEN** 使用者提交錯誤帳密
- **THEN** root daemon 回傳 401 錯誤，不 spawn 任何 daemon

#### Scenario: Subsequent request with JWT

- **GIVEN** 使用者已登入（持有有效 JWT cookie）
- **WHEN** 新的 TCP 連線建立（browser 開新 tab 或 SSE/WS reconnect）
- **THEN** root daemon 驗證 JWT → 直接 splice 到對應 per-user daemon（不重新 PAM auth）

#### Scenario: splice() transparent forwarding

- **GIVEN** splice proxy 已建立在 client TCP fd 和 per-user daemon Unix socket 之間
- **WHEN** 使用者透過 webapp 操作（HTTP API / SSE / WebSocket）
- **THEN** 所有 bytes 透過 kernel-level splice() 轉發，per-user daemon 處理請求如同直接連線

### Requirement: Per-user Process Isolation (R2)

每個已認證使用者 SHALL 有自己的 opencode daemon process，以該使用者身份運行，完全隔離。

#### Scenario: Per-user daemon spawn with correct identity

- **GIVEN** 使用者 alice（uid=1000）首次登入
- **WHEN** root daemon 準備 spawn per-user daemon
- **THEN** fork() + setuid(1000) + exec("opencode serve --unix-socket /run/user/1000/opencode/daemon.sock")，daemon process `whoami` 回傳 "alice"

#### Scenario: User isolation

- **GIVEN** alice 和 bob 都已登入，各自有 per-user daemon
- **WHEN** alice 的 daemon 執行 `ls ~/`
- **THEN** 只看到 alice 的 home 目錄，看不到 bob 的檔案

#### Scenario: No sudo required

- **GIVEN** alice 的 per-user daemon 正在運行
- **WHEN** alice 透過 webapp 執行 bash command
- **THEN** command 直接 spawn（無 sudo -n），audit log 中不出現 sudo 記錄

### Requirement: TUI Thin Client Attach (R3)

TUI SHALL 作為 thin client 透過 Unix socket 直連 per-user daemon，與 webapp 共享 state。

#### Scenario: TUI auto-discover and attach

- **GIVEN** alice 的 per-user daemon 正在運行，discovery file 存在
- **WHEN** alice 在 terminal 執行 `opencode`（TUI mode）
- **THEN** TUI 讀取 discovery file，直連 Unix socket，不經 root daemon

#### Scenario: TUI and webapp see same state

- **GIVEN** TUI 和 webapp 都連接到 alice 的 per-user daemon
- **WHEN** 在 TUI 建立新 session
- **THEN** webapp 即時看到該 session（透過 SSE event）

#### Scenario: TUI without daemon — fail fast

- **GIVEN** per-user daemon 未啟動
- **WHEN** alice 執行 `opencode`（TUI mode）
- **THEN** 顯示明確錯誤：「Per-user daemon 未啟動，請透過 web 登入或執行 webctl.sh dev-start」，exit 1

### Requirement: Account Bus Events (R4)

Account 的新增、刪除、啟用 SHALL publish Bus event，payload 包含完整資料（secrets 除外）。

#### Scenario: Account added — all clients notified

- **GIVEN** TUI 和 webapp 都連接到同一 per-user daemon
- **WHEN** 透過 webapp 新增 API key 帳號
- **THEN** TUI 收到 `account.added` event，payload 包含完整 Account.Info（無 apiKey）

#### Scenario: Account removed — all clients notified

- **GIVEN** TUI 和 webapp 都連接
- **WHEN** 透過 TUI 刪除帳號
- **THEN** webapp 收到 `account.removed` event

#### Scenario: Event payload sanitized

- **GIVEN** 帳號 event 被 publish
- **WHEN** event 透過 SSE 傳送
- **THEN** payload 不包含 apiKey、refreshToken 等 secrets

### Requirement: SSE Event ID + Catch-up (R5)

SSE endpoint SHALL 支援 event ID sequencing + 斷線重連補發。

#### Scenario: Reconnect with catch-up

- **GIVEN** client 已收到 event ID 100
- **WHEN** 斷線 5 秒後重連，攜帶 Last-Event-ID: 100
- **THEN** server 補發 event 101~115，client state 與 server 一致

#### Scenario: Buffer overflow

- **GIVEN** 斷線時間過長，buffer 中最舊的 event ID > client 的 Last-Event-ID
- **WHEN** client 重連
- **THEN** server 發送 sync.required event，client 執行 full refresh

### Requirement: Performance Stability (R6)

Backend daemon SHALL 在長時間運行下保持 memory 和 connection 穩定。

#### Scenario: SDK cache bounded

- **GIVEN** daemon 運行超過 1 小時，期間使用多個 provider
- **WHEN** SDK cache 達到上限（50）
- **THEN** 最舊的 SDK instance 被 evict，memory 不持續增長

#### Scenario: SSE broadcast non-blocking

- **GIVEN** 10 個 SSE client 連接，其中一個 client 處理很慢
- **WHEN** Bus event 被 publish
- **THEN** 其他 9 個 client 不被慢 client 阻塞，event 正常送達

### Requirement: webctl.sh Daemon Mode (R7)

webctl.sh SHALL 管理 C root daemon + per-user daemon，保留 production/dev 雙模式。

#### Scenario: dev-start

- **GIVEN** 開發環境
- **WHEN** 執行 webctl.sh dev-start
- **THEN** C root daemon 啟動 + frontend dev server 啟動，使用者可透過 :1080 登入並使用

#### Scenario: systemd-start

- **GIVEN** production 環境
- **WHEN** 執行 webctl.sh systemd-start
- **THEN** C root daemon 作為 systemd service 啟動

## Acceptance Checks

- C root daemon 編譯成功且 PAM auth 正常
- splice() 對 HTTP / SSE / WebSocket 三種協定均正確轉發
- Per-user daemon 以正確使用者身份運行（whoami 確認）
- 無 sudo -n 調用殘留
- TUI 啟動 → auto-discover → Unix socket attach → send message → response
- TUI 與 webapp 同時連接，帳號/session 即時同步
- SSE 斷線重連 → event 補發 → state 一致
- Bus event payload 是 sanitized full object
- SDK cache memory 在長時間運行後穩定
- webctl.sh dev-start → 完整流程可用
- tsc --noEmit EXIT 0
- architecture.md 與 codebase 一致
