# Tasks

## 0. Discovery & Design

- [x] 0.1 盤點現有 multi-server 功能的限制，確認 remote terminal 的必要性
- [x] 0.2 定義本地/遠端職責分離：大腦（LLM）在本地、手腳（tool execution）在遠端
- [x] 0.3 建立 spec plan（本文件及同目錄 artifacts）
- [ ] 0.4 盤點現有 tool dispatch 架構（task.ts / worker protocol / supervisor），識別抽象化切入點
- [ ] 0.5 確認 remote agent binary 技術選型（Go vs Bun compile vs Rust）— 需使用者決策
- [ ] 0.6 定義 remote agent JSON protocol（基於現有 worker protocol 擴展）

## 1. Remote Agent Binary

- [ ] 1.1 定義 agent protocol schema（exec / read / write / glob / git / heartbeat / error）
- [ ] 1.2 實作 remote agent core（stdin/stdout JSON loop）
- [ ] 1.3 實作 exec handler（shell command 執行，含 timeout / signal）
- [ ] 1.4 實作 file handler（read / write / glob）
- [ ] 1.5 實作 git handler（git CLI wrapper）
- [ ] 1.6 實作 heartbeat handler
- [ ] 1.7 Cross-compile 驗證（linux-amd64, linux-arm64, darwin-arm64）
- [ ] 1.8 獨立 binary 測試（無 bun/node 環境下可執行）

## 2. SSH Tunnel Manager

- [ ] 2.1 設計 SSH tunnel manager API（connect / disconnect / send / onMessage / onError）
- [ ] 2.2 實作 tunnel spawner（ssh process with stdio forwarding）
- [ ] 2.3 實作 heartbeat loop 與斷線偵測
- [ ] 2.4 實作自動重連機制（exponential backoff）
- [ ] 2.5 支援 SSH config（host alias / identity file / proxy jump）
- [ ] 2.6 整合到 ProcessSupervisor 或獨立 RemoteSupervisor

## 3. Tool Dispatch 抽象化

- [ ] 3.1 定義 ToolBackend interface（exec / readFile / writeFile / glob / gitOp / heartbeat / dispose）
- [ ] 3.2 重構現有 tool execution 為 LocalToolBackend
- [ ] 3.3 實作 RemoteToolBackend（透過 SSH tunnel 派發）
- [ ] 3.4 Project config schema 增加 remoteTarget 欄位
- [ ] 3.5 Tool dispatch 路由邏輯：根據 session → project → remoteTarget 選擇 backend
- [ ] 3.6 錯誤處理：tunnel 斷線時的 graceful degradation

## 4. Bootstrap & UX

- [ ] 4.1 實作 `opencode remote setup user@host`（scp binary + 驗證連線）
- [ ] 4.2 實作 `opencode remote test user@host`（連線測試 + latency report）
- [ ] 4.3 TUI 顯示 remote connection 狀態（在 session header 或 status bar）
- [ ] 4.4 Webapp sidebar 顯示 remote target 資訊
- [ ] 4.5 佈建腳本模板化到 `templates/`

## 5. Validation & Documentation

- [ ] 5.1 End-to-end 測試：本地 session 透過 SSH 在遠端執行 tool call
- [ ] 5.2 斷線重連測試
- [ ] 5.3 延遲 benchmark（LAN / WAN）
- [ ] 5.4 更新 specs/architecture.md
- [ ] 5.5 更新 docs/events/ 記錄本次開發
