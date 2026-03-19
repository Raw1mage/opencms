# Implementation Spec

## Goal

建立 C root daemon + per-user opencode daemon 架構，消除 sudo-n 全域特權風險，讓 TUI 和 webapp 共享同一個 per-user daemon，同時強化 Bus event 系統和修復效能瓶頸。

## Scope

### IN

- Slice α: C Root Daemon — PAM auth + login page + splice() proxy + per-user daemon lifecycle
- Slice β: Per-user Daemon Mode — opencode `--unix-socket` + discovery file + daemon lifecycle
- Slice γ: TUI Thin Client — 移除 Worker thread，改為 Unix socket client attach
- Slice δ: Security Migration — 移除 sudo-n / opencode-run-as-user 機制
- Slice ε: Account Bus Events — account.added / removed / activated 事件定義與 publish
- Slice ζ: SSE Event ID + Catch-up — event sequencing + reconnection buffer
- Slice η: Bus Event Payload 完整化 — 關鍵 event 攜帶 full object
- Slice θ: Performance Hardening — SDK cache eviction + 連線數限制 + SSE backpressure
- Slice ω: webctl.sh + Cross-cutting — daemon 模式改造 + architecture.md sync + regression

### OUT

- Bun runtime fork / 修改
- Webapp 前端 UI 變更（React 組件、頁面佈局、樣式）
- TUI 前端 UI 變更（Ink/React 渲染層、使用者操作流程）
- Phase 2 hardening（read-path clone、accountId reform、deploy gate）
- PTY session 孤兒回收
- 跨機器 TUI attach

## Assumptions

- Linux 是唯一目標平台（splice() 和 Unix socket 僅 Linux）
- Bun.serve() 支援 `unix:` 參數監聽 Unix domain socket
- C 編譯工具鏈（gcc/clang）在開發環境中可用
- PAM 開發庫（libpam-dev）在目標系統中已安裝
- systemd --user 在目標系統中可用
- 現有 `opencode serve` / `opencode web` 的 HTTP API 介面不變

## Stop Gates

- **SG-1**: Slice α 開始前，確認 PAM C API 在目標系統上可用且可編譯
- **SG-2**: Slice α 完成後，確認 splice() 對 HTTP / SSE / WebSocket 三種協定均能正確轉發
- **SG-3**: Slice γ 開始前，確認 Bun 的 Unix socket HTTP client 可正常運作（fetch over Unix socket）
- **SG-4**: Slice δ 開始前，確認所有使用 LinuxUserExec 的 call site 已列出並有替代方案
- **SG-5**: Slice θ 開始前，確認 SDK cache 的 memory footprint baseline（目前使用量）

## Critical Files

### 新增
- `daemon/opencode-gateway.c` — C root daemon 主程式
- `daemon/Makefile` — 編譯腳本
- `daemon/login.html` — Login 頁面（靜態 HTML）
- `daemon/opencode-gateway.service` — systemd unit（root-level）
- `daemon/opencode-user@.service` — systemd template unit（per-user）

### 大幅修改
- `packages/opencode/src/cli/cmd/tui/thread.ts` — Worker spawn → Unix socket client
- `packages/opencode/src/cli/cmd/tui/worker.ts` — 移除或重構
- `packages/opencode/src/cli/cmd/tui/attach.ts` — 升級為主要 attach 路徑
- `packages/opencode/src/cli/cmd/serve.ts` — 新增 --unix-socket 選項
- `packages/opencode/src/server/server.ts` — Unix socket listen + 連線數限制
- `packages/opencode/src/bus/index.ts` — account event types + payload 擴充
- `packages/opencode/src/server/routes/global.ts` — SSE event ID + buffer + backpressure
- `packages/opencode/src/account/manager.ts` — publish account events
- `packages/opencode/src/provider/provider.ts` — SDK cache eviction
- `packages/app/src/context/global-sdk.tsx` — SSE Last-Event-ID reconnection
- `webctl.sh` — daemon 模式改造

### 移除
- `scripts/opencode-run-as-user.sh` — sudo wrapper
- `packages/opencode/src/system/linux-user-exec.ts` — sudo invocation builder

## Structured Execution Phases

### Phase α — C Root Daemon（高價值，需 C 開發，可獨立）

α.1 C daemon 骨架：epoll event loop + signal handling + logging
α.2 PAM 整合：pam_authenticate + pam_acct_mgmt
α.3 Login page serve：靜態 HTML + POST /auth/login endpoint
α.4 Per-user daemon spawn：fork() + setuid() + exec("opencode serve --unix-socket ...")
α.5 Per-user daemon lifecycle：health check + restart on crash + idle timeout
α.6 splice() proxy：auth 成功後 epoll + splice() 在 client TCP fd ↔ per-user Unix socket 之間轉發
α.7 WebSocket upgrade 透過 splice 透傳（verify 不拆包）
α.8 多使用者並行：per-UID daemon registry + concurrent connection handling
α.9 Graceful shutdown：drain connections + SIGTERM per-user daemons
α.10 驗證：login → splice proxy → per-user opencode serve API 正常回應

### Phase β — Per-user Daemon Mode（中風險，opencode 核心改動）

β.1 serve command 新增 `--unix-socket <path>` 選項
β.2 Bun.serve() 改為支援 `{ unix: socketPath }` 啟動模式
β.3 Discovery file 寫入：`$XDG_RUNTIME_DIR/opencode/daemon.json`（url, pid, socketPath, startedAt, version）
β.4 Discovery file cleanup：process exit + SIGTERM handler
β.5 Daemon mode PID file：防止同一使用者重複啟動
β.6 驗證：`opencode serve --unix-socket /tmp/test.sock` → API 可透過 Unix socket 訪問

### Phase γ — TUI Attach Mode（中影響，依賴 β，保留獨立模式）

γ.1 CLI 新增 `--attach` flag
γ.2 discoverDaemon()：讀取 discovery file → 驗證 PID → 回傳 socket path
γ.3 TUI 啟動流程分支：--attach → discover + Unix socket attach；無 --attach → 維持現有 Worker thread
γ.4 Attach mode：HTTP client over Unix socket + SSE subscription
γ.5 RPC methods 替代（attach mode only）：fetch → HTTP, server → discovery info, shutdown → disconnect only
γ.6 TUI graceful disconnect
γ.7 驗證：`opencode --attach` → attach → message → response → webapp 同步可見
γ.8 驗證：`bun run dev`（無 --attach）維持現有行為不變

### Phase δ — Security Migration（中風險，移除舊機制）

δ.1 盤點所有 LinuxUserExec 使用點（bash.ts, pty/index.ts, shell-executor.ts 等）
δ.2 移除 LinuxUserExec.buildSudoInvocation() 調用 — per-user daemon 已以目標身份運行，直接 spawn
δ.3 移除 linux-user-exec.ts module
δ.4 移除 scripts/opencode-run-as-user.sh
δ.5 移除 sudoers rule 安裝邏輯
δ.6 更新 install.sh 移除 --system-init 相關的 sudo wrapper 安裝
δ.7 驗證：per-user daemon 執行 bash command → 以正確使用者身份 → 無 sudo 調用

### Phase ε — Account Bus Events（中風險，跨模組）

ε.1 定義 account event types：account.added, account.removed, account.activated
ε.2 AccountManager.connectApiKey/connectOAuth → publish account.added
ε.3 AccountManager.removeAccount → publish account.removed
ε.4 AccountManager.activateAccount → publish account.activated
ε.5 Event payload sanitization（移除 apiKey 等 secrets）
ε.6 webapp event handler 訂閱 account events → 更新 local state
ε.7 驗證：帳號操作 → SSE event → 多 client 即時同步

### Phase ζ — SSE Event ID + Catch-up（中風險，protocol 層改動）

ζ.1 SSE endpoint 新增 global monotonic event counter
ζ.2 每個 SSE event 附加 `id:` field
ζ.3 Event ring buffer（MAX_SIZE = 1000）
ζ.4 Last-Event-ID header 解析 + catch-up 邏輯
ζ.5 Buffer overflow → `sync.required` 特殊 event
ζ.6 webapp + TUI client 更新 Last-Event-ID reconnection
ζ.7 驗證：斷線重連 → event 補發 → state 一致

### Phase η — Bus Event Payload 完整化（低風險，漸進式）

η.1 盤點所有 Bus event payload 結構
η.2 Account events → full payload（Phase ε 已處理）
η.3 session.updated → full Session.Info
η.4 webapp event-reducer.ts 更新：直接使用 full payload
η.5 驗證：event consumer 不需 follow-up API call

### Phase θ — Performance Hardening（中風險，跨模組）

θ.1 SDK cache：新增 LRU eviction（MAX_SIZE = 50）或 TTL（1 hour）
θ.2 Server 連線數限制：maxConnections + idle timeout
θ.3 SSE broadcast：改為 fire-and-forget + per-subscriber queue + backpressure
θ.4 accounts.json stringify：改為 async write（不阻塞 event loop）
θ.5 驗證：daemon 長時間運行 memory stable、多 client 連接穩定

### Phase ω — webctl.sh + Cross-Cutting

ω.1 webctl.sh systemd 指令改為管理 root daemon + per-user daemon template
ω.2 dev-start：啟動 C root daemon（dev 模式）+ frontend dev server
ω.3 dev-refresh：重啟 daemon + rebuild frontend
ω.4 保留 production/dev 雙模式
ω.5 specs/architecture.md 全貌同步
ω.6 Runtime regression：TUI + webapp + admin panel + multi-user
ω.7 更新 docs/events/ event log

## Validation

- C root daemon 編譯成功且可在目標系統運行
- PAM auth 通過 → per-user daemon spawn → splice proxy 正常
- splice() 對 HTTP / SSE / WebSocket 三種協定均正確轉發
- TUI 啟動 → auto-discover → attach → send message → response rendered
- TUI 與 webapp 同時連接，帳號/session 即時同步
- SSE 斷線重連 → event 補發 → state 一致
- Bus event payload 是 full object
- sudo -n / opencode-run-as-user 完全移除，bash/PTY 以 per-user daemon 身份執行
- SDK cache memory 在長時間運行後保持穩定
- tsc --noEmit EXIT 0
- webctl.sh dev-start → root daemon + per-user daemon + frontend 均正常
- architecture.md 與 codebase 一致

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
- Phase α（C daemon）可獨立開發，不依賴其他 Phase。
- Phase β（Unix socket mode）可與 α 平行，只依賴 Bun.serve 支援。
- Phase γ（TUI）依賴 β。
- Phase δ（security migration）依賴 α + β 完成（per-user daemon 可運行後才能移除 sudo-n）。
- Phase ε/ζ/η（Bus 強化）可與 α/β 平行。
- Phase θ（效能）可在任何時間進行。
- Phase ω（webctl.sh）依賴 α + β。
- 實作在 opencode repo，建議從 cms 分出新 branch `daemon-refactor`。
