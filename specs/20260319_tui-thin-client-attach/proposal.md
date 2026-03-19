# Proposal

## Why

- 現行架構下，opencode backend daemon 用 `sudo -n opencode-run-as-user` 對每一句 shell/PTY 命令做身份切換 — daemon 持有全域 sudo 權限，攻擊面過大
- TUI 透過 Worker thread 自帶 embedded Server.App()，與 webapp backend 完全隔離，無法共享 state/event/session
- Bus event 系統有缺陷：account 事件未上 bus、payload 不完整、SSE 斷線無 catch-up
- Backend daemon 存在效能瓶頸：SDK cache 無限增長（memory leak）、無連線數限制、SSE broadcast 無 backpressure
- 需要一個根本性的架構改進，同時解決安全性、多 client 共享、事件系統完整性和效能問題

## Original Requirement Wording (Baseline)

- "opencode必須拆成一個core daemon，而把tui和webapp切成是兩個不同形式的frontend去attach該core daemon"
- "bus publish必須是完整資料，subscriber能夠透過filter拿到他需要的，而不需要再多呼叫其他的處理函式"
- "怎麼讓tui變成可以直接attach到這個正在run的backend opencode process中"
- "目前的webctl.sh的systemd模式直接改成啟動daemon"
- "user 透過pam auth login之後，process要su成對應的身份再工作"
- "root daemon變成一個C語言寫的thin server只做pam auth和fd passing...登入後用fd passing技術喚起per-user opencode daemon來服務frontend"

## Requirement Revision History

- 2026-03-19 (R1): 初始需求為完整 daemon 重構（root daemon + per-user daemon + reverse proxy）
- 2026-03-19 (R2): 使用者釐清現有 webapp 架構已滿足需求，核心痛點收斂為「TUI attach 到已在跑的 backend」
- 2026-03-19 (R3): 確認一併處理 Bus event 完整化、Account 事件上 bus、SSE catch-up
- 2026-03-19 (R4): 發現現行 sudo-n 模型有重大資安風險（daemon 持有全域 sudo），決定改為 per-user daemon 架構
- 2026-03-19 (R5): 確認 C root daemon + splice() proxy + per-user opencode on Unix socket 架構。Bun 不原生支援 fd passing，splice() 是 kernel-level 零拷貝轉發，效能等同 fd passing
- 2026-03-19 (R6): 確認一併處理效能瓶頸（SDK cache leak、連線數限制、SSE backpressure）

## Effective Requirement Description

1. **C root daemon**：用 C 語言寫的 thin server，負責 listen TCP :1080、serve login page、PAM auth、spawn per-user daemon、splice() proxy
2. **Per-user opencode daemon**：標準 opencode binary 以 `Bun.serve({ unix: socket_path })` 監聽 Unix socket，以使用者身份運行
3. **TUI thin client**：改為 HTTP+SSE client，直連 per-user daemon 的 Unix socket（同 UID，不經 root daemon）
4. **移除 sudo-n 機制**：不再用 sudo 做每一句命令的身份切換，per-user daemon 本身就以目標使用者身份運行
5. **Account Bus events**：account.added / account.removed / account.activated 上 bus
6. **SSE catch-up**：event ID sequencing + 斷線重連補發
7. **Event payload 完整化**：關鍵 event 攜帶 full object
8. **效能改善**：SDK cache eviction、連線數限制、SSE backpressure
9. **webctl.sh daemon 模式**：systemd 指令改為管理 C root daemon + per-user daemon
10. **保留 production/dev 雙模式**

## Scope

### IN

- C root daemon 開發（PAM auth + login page serve + per-user daemon spawn + splice proxy）
- Per-user opencode daemon 支援 Unix socket 模式（`--unix-socket` 選項）
- TUI Worker thread 移除，改為 Unix socket client
- 移除 sudo-n / opencode-run-as-user 機制
- Account Bus event 定義與 publish
- SSE event ID sequencing + reconnection catch-up buffer
- Bus event payload 完整化
- SDK cache eviction policy（LRU / TTL）
- Server 連線數限制
- SSE broadcast backpressure
- webctl.sh daemon 模式改造
- Discovery mechanism（per-user daemon → discovery file → TUI）

### OUT

- Bun runtime fork / 修改（未來待 Bun 原生支援 fd 接手後可切換）
- Webapp 前端 UI 變更
- Phase 2 hardening（read-path clone、accountId reform、deploy gate — 獨立計畫）
- PTY session 孤兒回收（延後）
- 跨機器 TUI attach

## Non-Goals

- 不 fork Bun runtime（splice proxy 是務實的替代方案）
- 不改變前端 SDK 的 API 介面
- 不改變前端使用者體驗（登入後看到的 webapp 完全不變）
- 不改變 TUI 前端渲染（Ink/React UI 層與使用者操作流程不變，只改底層連線方式）

## Constraints

- C root daemon 需以 root 或 privileged user 身份運行（PAM auth + setuid spawn）
- Per-user daemon 使用 Bun.serve() on Unix socket — Bun 原生支援
- splice() 僅 Linux 可用（本專案目標平台）
- TUI 使用 Ink/React 渲染，底層 Bun process，可做 HTTP client over Unix socket
- webctl.sh 需保持 production/dev 雙模式
- login page 需由 C root daemon serve（per-user daemon 啟動前使用者尚未認證）

## What Changes

- **新增 C root daemon binary**：~500-800 行 C code，PAM + epoll + splice + process management
- **opencode binary**：新增 `--unix-socket` 選項，Bun.serve() 改為支援 Unix socket 監聽
- **TUI 啟動流程**：Worker thread → Unix socket client
- **移除 sudo-n 相關**：opencode-run-as-user.sh、LinuxUserExec module、sudoers rule
- **Bus event 定義**：新增 account events、擴充 payload
- **SSE endpoint**：event ID + ring buffer + catch-up
- **SDK cache**：新增 eviction policy
- **webctl.sh**：systemd 指令改為管理 root daemon + per-user daemon template unit

## Capabilities

### New Capabilities

- **C root daemon**：獨立的 auth gateway + connection broker
- **Per-user process isolation**：每個使用者有自己的 opencode daemon process，完全隔離
- **TUI attach**：TUI 直連 per-user daemon，與 webapp 共享 state
- **Account event stream**：任何 client 即時收到帳號變更
- **SSE catch-up**：斷線重連自動補發遺漏事件

### Modified Capabilities

- **身份切換**：從 per-command sudo -n 改為 per-user daemon setuid（一次性切換）
- **Bus event payload**：從 ID-only 改為 full object
- **webctl.sh**：從啟動 webapp 改為管理 root daemon + per-user daemon
- **TUI 啟動模式**：從 embedded server 改為 attach mode

## Impact

- **新增檔案**：C root daemon source（`daemon/` 目錄）、Makefile、systemd unit files
- **大幅修改**：TUI thread.ts/worker.ts/attach.ts、webctl.sh
- **移除檔案**：opencode-run-as-user.sh、相關 sudoers config
- **修改模組**：bus/index.ts、server/routes/global.ts、account/manager.ts、server/app.ts、provider/provider.ts
- **修改前端**：global-sdk.tsx（SSE Last-Event-ID）、event-reducer.ts
