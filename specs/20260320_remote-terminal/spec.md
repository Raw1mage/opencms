# Spec

## Purpose

- 讓 opencode 的 tool execution 可以透明地發生在遠端 SSH host 上，使用者體驗與本地開發一致

## Requirements

### Requirement: Remote Agent Execution

系統 SHALL 支援透過 SSH tunnel 將 tool call 派發到遠端 agent 執行，並將結果回傳到本地 session。

#### Scenario: 遠端 shell 執行

- **GIVEN** session 的 project 設定了 remoteTarget（host=remote-dev, user=pkcs12）
- **WHEN** LLM 發出 shell tool call（例如 `ls -la /home/pkcs12/project`）
- **THEN** 指令透過 SSH tunnel 送到遠端 agent 執行，stdout/stderr/exit code 回傳到本地 session

#### Scenario: 遠端檔案讀取

- **GIVEN** session 配置了 remote target
- **WHEN** LLM 發出 file read tool call（路徑為遠端絕對路徑）
- **THEN** 遠端 agent 讀取檔案內容並回傳

#### Scenario: 遠端檔案寫入

- **GIVEN** session 配置了 remote target
- **WHEN** LLM 發出 file write tool call
- **THEN** 遠端 agent 在遠端 filesystem 寫入檔案並回報成功/失敗

### Requirement: SSH Tunnel Lifecycle

系統 SHALL 自動管理 SSH tunnel 的建立、維護、斷線偵測與重連。

#### Scenario: Tunnel 建立

- **GIVEN** 使用者開啟一個配置了 remote target 的 session
- **WHEN** 第一個 tool call 發出
- **THEN** 系統自動建立 SSH tunnel（若尚未建立），tunnel ready 後才派發指令

#### Scenario: Tunnel 斷線重連

- **GIVEN** SSH tunnel 已建立且正在使用中
- **WHEN** 網路斷線導致 tunnel 中斷
- **THEN** 系統偵測到斷線（heartbeat 失敗），自動嘗試重連，in-flight tool call 以明確錯誤回報

### Requirement: Minimal Remote Deployment

遠端 SHALL 只需要一個 binary 和 SSH server 即可運作，不需要 bun/node、不需要 LLM API key。

#### Scenario: 一鍵佈建

- **GIVEN** 遠端機器有 SSH server 且本地有 key-based auth
- **WHEN** 使用者執行 `opencode remote setup user@host`
- **THEN** 系統自動 scp agent binary 到遠端、驗證連線、回報就緒狀態

### Requirement: Tool Dispatch 透明切換

Tool dispatch 層 SHALL 根據 session/project config 自動選擇 local 或 remote backend，上層 LLM interaction 不需感知差異。

#### Scenario: 同一 tool 在 local 和 remote 執行

- **GIVEN** 兩個 session，一個設定 remote target，一個沒有
- **WHEN** 兩個 session 都發出相同的 shell tool call
- **THEN** 一個在本地執行、一個在遠端執行，回傳格式完全一致

## Acceptance Checks

- Remote agent binary 可在無 bun/node 的 Linux 機器上獨立運行
- SSH tunnel 建立時間 < 3 秒（LAN 環境）
- Tool call round-trip 延遲 < 100ms（LAN 環境，不含指令本身執行時間）
- Tunnel 斷線後 10 秒內自動重連
- `opencode remote setup` 完成遠端佈建 < 30 秒
- 遠端執行的 tool call 結果格式與本地執行完全一致
