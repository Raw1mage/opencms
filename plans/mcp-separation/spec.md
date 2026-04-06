# Spec

## Purpose

建立標準化的 MCP App 擴充介面，使任何符合 `mcp.json` 規格的目錄都能作為 App 掛載，並透過對話或 UI 完成全生命週期管理。

## Requirements

### Requirement: mcp.json Manifest 驗證（Layer 1）

The system SHALL 讀取並驗證 App 目錄下的 `mcp.json` manifest。

#### Scenario: 合法的 mcp.json

- **GIVEN** 目錄 `/opt/opencode-apps/my-app/` 包含合法 `mcp.json`（含 id, name, command）
- **WHEN** 系統讀取該目錄時
- **THEN** 成功解析為 `McpAppManifest`，回傳完整的 App 描述

#### Scenario: 缺少 mcp.json

- **GIVEN** 目錄不包含 `mcp.json`
- **WHEN** 系統嘗試讀取時
- **THEN** 嘗試推斷 command（從 package.json / pyproject.toml / requirements.txt）
- **AND** 推斷成功則自動生成 `mcp.json` 並 log.info
- **AND** 推斷失敗則 log.warn + 拋出 `McpManifestNotFoundError`，不靜默跳過

#### Scenario: mcp.json schema 不合法

- **GIVEN** `mcp.json` 存在但缺少必填欄位或類型不匹配
- **WHEN** 系統以 Zod schema 驗證時
- **THEN** log.warn + 拋出 `McpManifestInvalidError`，附帶具體的 validation 錯誤訊息

### Requirement: mcp-apps.json 生命週期管理（Layer 2）

The system SHALL 從 `mcp-apps.json` 載入已登記的 App，並在 runtime 建立 stdio 連線。

#### Scenario: 正常啟動載入

- **GIVEN** `/etc/opencode/mcp-apps.json` 登記了 3 個 App，其中 2 個 enabled
- **WHEN** 系統啟動時
- **THEN** 對 2 個 enabled App 執行 stdio spawn → MCP Client → tools/list
- **AND** 取得的工具註冊到 session tool pool

#### Scenario: App 啟動失敗

- **GIVEN** 某個 enabled App 的 command 指向不存在的路徑
- **WHEN** 系統嘗試 spawn 時
- **THEN** 該 App status 設為 `error`，log.warn 記錄具體錯誤
- **AND** 其他 App 不受影響，繼續正常啟動

#### Scenario: 新增 App

- **GIVEN** 使用者透過 API 或 tool 指定一個新路徑
- **WHEN** 系統讀取 mcp.json + probe（stdio → tools/list）成功
- **THEN** 寫入 mcp-apps.json，App 卡片出現在 UI，工具即時可用

#### Scenario: 移除 App

- **GIVEN** 某個 App 已登記且 connected
- **WHEN** 使用者執行 remove
- **THEN** 斷開 stdio 連線，從 mcp-apps.json 移除，UI 卡片消失
- **AND** 不刪除磁碟上的檔案

### Requirement: 對話驅動安裝（Layer 3）

The system SHALL 透過 system-manager MCP tool 支援對話式 App 安裝。

#### Scenario: 從 GitHub URL 安裝

- **GIVEN** 使用者說「把 github.com/owner/repo 加進來當 MCP server」
- **WHEN** AI 呼叫 `install_mcp_app({ source: "https://github.com/owner/repo" })`
- **THEN** 系統執行 git clone → 讀取/推斷 mcp.json → 安裝依賴 → probe 驗證 → 寫入 mcp-apps.json
- **AND** 回傳 App 資訊（id, name, tools, status）

#### Scenario: 從本機路徑安裝

- **GIVEN** 使用者說「把 /home/user/my-mcp-server 掛載成 App」
- **WHEN** AI 呼叫 `install_mcp_app({ source: "/home/user/my-mcp-server" })`
- **THEN** 系統讀取 mcp.json → probe 驗證 → 寫入 mcp-apps.json

#### Scenario: 安裝失敗回報

- **GIVEN** GitHub repo clone 成功但 probe 失敗（command 無法執行）
- **WHEN** probe 階段 timeout 或 protocol error
- **THEN** 不寫入 mcp-apps.json，回傳具體錯誤讓 AI 告知使用者

### Requirement: 內建 App 標準化（Layer 0）

The system SHALL 將內建 App 的 BUILTIN_CATALOG 硬編碼移至各 App 目錄下的 manifest.ts。

#### Scenario: 內建 App 載入（Phase A）

- **GIVEN** BUILTIN_CATALOG 已移除，Gmail/Calendar 的 manifest 在各自目錄
- **WHEN** 系統啟動時
- **THEN** 從 manifest.ts import → managedAppExecutors → 功能與重構前完全一致

## Acceptance Checks

- [ ] `mcp.json` 不存在且推斷失敗時，runtime log.warn 且不靜默跳過
- [ ] `mcp.json` schema 錯誤時，回傳具體 Zod validation 錯誤
- [ ] 從 GitHub URL 安裝一個公開的 MCP server，tool 在 session 中可用
- [ ] 從本機路徑掛載 drawmiat，tool 在 session 中可用
- [ ] Admin UI 能顯示所有已登記 App 的卡片（name, icon, status, tool count）
- [ ] 移除 BUILTIN_CATALOG 後，Gmail/Calendar 功能不受影響
- [ ] 路徑穿越攻擊被阻擋
- [ ] `bun test` 全部通過
