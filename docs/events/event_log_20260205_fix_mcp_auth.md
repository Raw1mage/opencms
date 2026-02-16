#### 功能：修復 MCP Server 連線與認證系統

**需求**

- 修復導致所有本地 MCP server (`filesystem`, `fetch`, etc.) 無法啟動的 npm 依賴衝突。
- 修復導致 `opencode auth` 指令崩潰的認證檔案問題。
- 恢復 Anthropic 與其他服務的連線能力。

**範圍**

- IN：
  - 修改 `package.json` 中的 overrides 設定以解決 `@babel/core` 衝突。
  - 重置或修復 `~/.local/share/opencode/auth.json`。
  - 驗證 MCP server 啟動狀態。
- OUT：
  - 不涉及 MCP server 本身的程式碼邏輯修改，僅處理依賴與配置。

**方法**

1.  **解決依賴衝突**：
    - 根據診斷，`package.json` 強制 override `@babel/core` 為 `7.28.0`，但執行環境需要 `7.28.4`。
    - 策略：更新 `package.json` 的 overrides 版本以匹配環境需求。

2.  **重置認證系統**：
    - `auth.json` 似乎已損壞或遺失（`ls` 顯示找不到）。
    - 策略：初始化一個空的有效 `auth.json` 結構，讓 `opencode auth` 指令能正常運作，以便重新登入。

**任務**

1. [ ] 更新 `opencode/package.json` 解除 npm 衝突
2. [ ] 重建 `~/.local/share/opencode/auth.json`
3. [ ] 執行 `npm install` (確保依賴樹更新)
4. [ ] 驗證 MCP server 狀態 (`opencode mcp list`)

**待解問題**

- 無。
