# Implementation Spec

## Goal

- 讓本地 opencode daemon 能透過 SSH tunnel 將 tool execution 派發到遠端機器，遠端僅需最小化 agent binary，LLM 大腦留在本地

## Scope

### IN

- Remote agent binary 設計與實作
- SSH tunnel 建立 / 管理 / 重連機制
- Tool dispatch 層抽象化（local process vs SSH remote）
- Session / project 的 remote target 設定
- Remote bootstrap 腳本
- 遠端 agent 的通訊協定（JSON over stdin/stdout over SSH）

### OUT

- LLM API 通訊的遠端化
- Webapp 的 remote 改造（webapp 始終在本地）
- Multi-server UI 整合
- Windows remote target 支援
- 雙向檔案同步

## Assumptions

- 遠端機器有 SSH server 且本地可透過 key-based auth 連線
- 遠端機器有基本工具鏈（git、shell、語言 runtime 依專案而定）
- SSH tunnel 的延遲在可接受範圍內（LAN 或低延遲 WAN）
- 一個 session 同時只連一個 remote target（不做 multi-remote fan-out）

## Stop Gates

- 如果現有 tool dispatch 的耦合程度太高，需先完成 tool dispatch 抽象化重構，再進行 remote 整合
- 如果 SSH tunnel 的建立需要互動式密碼輸入（無 key-based auth），需決定是否支援 agent-based auth forwarding
- 遠端 agent binary 的語言選擇（Go for static binary? Bun compile? Rust?）需使用者決策
- 若遠端 file I/O 延遲 > 500ms 導致 tool execution 顯著變慢，需評估是否加入批次操作或 prefetch

## Critical Files

- `packages/opencode/src/tool/task.ts` — 現有 worker/tool dispatch，需抽象化
- `packages/opencode/src/session/index.ts` — session config 增加 remote target
- `packages/opencode/src/process/supervisor.ts` — remote process liveness 管理
- `packages/opencode/src/cli/cmd/session.ts` — SessionWorkerCommand，現有 worker protocol 參考
- `packages/opencode/src/server/user-daemon/manager.ts` — daemon 間通訊參考

## Structured Execution Phases

### Phase 0: Discovery & Design（本階段）

- 盤點現有 tool dispatch 架構，識別抽象化切入點
- 定義 remote agent 通訊協定（基於現有 worker JSON protocol 擴展）
- 確認 remote agent binary 技術選型
- 設計 SSH tunnel 管理模組的 API

### Phase 1: Remote Agent Binary

- 實作最小化 remote agent：接收 JSON 指令（exec shell、read file、write file、git op）、執行、回報結果
- 支援 stdin/stdout JSON 通訊（與 SSH pipe 天然相容）
- 內建 heartbeat 機制
- 目標：單一 binary，scp 到遠端即可跑

### Phase 2: SSH Tunnel Manager

- 實作 SSH tunnel 建立模組（spawn `ssh` process with stdio forwarding）
- Tunnel lifecycle：connect → ready → heartbeat → disconnect → reconnect
- 整合到 ProcessSupervisor 或獨立的 RemoteSupervisor
- 支援 SSH config（host alias、identity file、proxy jump）

### Phase 3: Tool Dispatch 抽象化

- 將現有 tool execution 路徑重構為 `ToolBackend` 介面
  - `LocalToolBackend`：現有邏輯，spawn local process
  - `RemoteToolBackend`：透過 SSH tunnel 派發到 remote agent
- Session / project config 增加 `remoteTarget` 欄位
- Tool dispatch 根據 session config 選擇 backend

### Phase 4: Bootstrap & UX

- 遠端佈建腳本：`opencode remote setup user@host`
  - scp agent binary
  - 驗證連線
  - 選擇性部署 project config
- TUI / webapp 顯示 remote connection 狀態
- 錯誤處理：tunnel 斷線時的 graceful degradation

## Validation

- Remote agent binary 可獨立運行，接收 JSON 指令並正確執行 shell command、file read/write
- SSH tunnel 可建立並維持穩定連線，heartbeat 正常
- 本地 session 配置 remote target 後，tool call 透過 tunnel 在遠端執行
- 遠端執行結果正確回傳到本地 session（與本地執行一致）
- Tunnel 斷線後自動重連，in-flight tool call 正確報錯
- `opencode remote setup user@host` 可一鍵完成遠端佈建
- 本地端不持有任何遠端 file system state（所有 file 操作都是 remote agent 即時執行）

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
- 特別注意：Phase 0 完成後需使用者 review 並確認技術選型（remote agent binary 語言），才可進入 Phase 1。
