# Proposal

## Why

- opencode 目前是單機架構：LLM 大腦、tool execution、file system access 全綁在同一台機器
- 使用者可能需要在遠端機器上開發（不同 workstation、cloud VM、NAS、CI runner 等），但完整部署 opencode 到遠端成本高且不必要
- 現有的「新增伺服器」功能（webapp multi-server）本質上只是 URL 書籤，無法共享 per-user daemon state，對分散式工作場景無實質幫助
- VSCode / Antigravity 的 SSH Remote 模式已經證明「大腦在本地、手腳在遠端」是可行且高效的架構

## Original Requirement Wording (Baseline)

- "比較有意義的做法可能是透過 ssh tunnel 連到 remote terminal 去工作"
- "讓 remote 端的安裝包最小化。LLM 大腦應該留在本地端"

## Requirement Revision History

- 2026-03-20: 初始構想，從 multi-server 功能討論中衍生

## Effective Requirement Description

1. 本地 opencode daemon 保留所有 LLM API 通訊能力（大腦），遠端只部署最小化的 tool execution agent（手腳）
2. 透過 SSH tunnel 建立本地與遠端的安全通道
3. 遠端 agent 僅負責：shell command 執行、file system 讀寫、git 操作、結果回報
4. 遠端不需要任何 LLM API key、不需要完整 opencode 安裝、不需要 bun/node runtime（理想狀態）
5. 本地 webapp/TUI 的使用體驗應與本地開發一致，使用者不需感知 tool execution 發生在遠端

## Scope

### IN

- 本地 ↔ 遠端的 tool execution 分離架構設計
- 最小化遠端安裝包定義（remote agent binary）
- SSH tunnel 建立與管理機制
- Session / project 層級的 remote target 綁定
- 遠端 file system browsing、shell execution、git operation 代理

### OUT

- LLM API 通訊不在遠端發生
- 遠端不需要 webapp / TUI 服務
- 不涉及多使用者共用遠端（一個 SSH user = 一個 remote target）
- 不涉及遠端 daemon 間的 session state 同步
- 不涉及現有 multi-server UI 的改造（那是獨立功能）

## Non-Goals

- 取代 VSCode Remote SSH（opencode remote 是 CLI/agent 層級，不是 IDE 層級）
- 支援 Windows remote target（初期僅 Linux/macOS remote）
- 即時檔案同步（rsync/watch）— 遠端 agent 直接操作遠端 filesystem，不做雙向 sync

## Constraints

- 必須透過 SSH 建立通道（不引入額外 VPN / overlay network）
- 遠端安裝包應可透過 `scp` + single script 完成佈建
- 遠端 agent 的通訊協定必須是 stdin/stdout JSON（與現有 worker protocol 對齊）
- 本地端 opencode 的 tool dispatch 層需要可插拔（local vs remote）

## What Changes

- 新增 remote agent binary（輕量、無 LLM 依賴）
- TaskTool / tool dispatch 層抽象化，支援 local process 和 SSH remote process 兩種 backend
- Session 或 project 增加 remote target 設定欄位
- SSH tunnel 生命週期管理（建立 / heartbeat / 斷線重連）
- 佈建腳本（bootstrap remote agent to target host）

## Capabilities

### New Capabilities

- **Remote Tool Execution**: 本地 daemon 將 tool call（shell、file read/write、git）透過 SSH tunnel 派發到遠端 agent 執行
- **Minimal Remote Agent**: 單一 binary，無外部依賴，接收 JSON 指令、執行、回報結果
- **SSH Tunnel Management**: 自動建立 / 維護 / 重連 SSH tunnel，支援 key-based auth
- **Remote Bootstrap**: 一鍵佈建遠端 agent（scp binary + 啟動）

### Modified Capabilities

- **Tool Dispatch**: 現有 tool execution 路徑需抽象化，增加 remote backend 選項
- **Session Config**: Session / project 設定增加 remote target 欄位（host、user、port、identity file）
- **Process Supervisor**: 需感知 remote process 的 liveness（透過 heartbeat over tunnel）

## Impact

- `packages/opencode/src/tool/` — tool dispatch 層需重構為可插拔架構
- `packages/opencode/src/session/` — session config 增加 remote target
- `packages/opencode/src/process/supervisor.ts` — remote process 生命週期管理
- 新增 `packages/opencode-remote-agent/` 或 `packages/remote-agent/` — 遠端 agent 獨立 package
- `templates/` — 遠端佈建腳本模板
- `specs/architecture.md` — 架構文件需反映 local/remote 分離
