---
name: refactor-anthropic
description: 專用於維護與更新 CMS 的 Anthropic Provider，使其與 Claude CLI (claude-code) 的行為保持同步。當 refs/claude-code submodule 有更新、或需要修復 Anthropic OAuth、Session 管理、身分模擬 (Headers/Prompt) 時使用。
---

# Refactor Anthropic Skill

本技能旨在指導如何將 `refs/claude-code` 中的最新邏輯遷移至 CMS 的 `src/plugin/anthropic.ts` 中，確保認證流程、請求標頭與 Session 機制始終與官方官方 CLI 一致。

## 關鍵維護領域 (v2.1.37+ Protocol Update)

### 1. OAuth 與權限 (Scopes)

官方 CLI (`v2.1.37+`) 使用**兩組不同的 Scope**，這是 Token Refresh 成功的關鍵。

#### 1.1 Scope 分組 (重要！)

| 用途              | 變數名 | Scope 列表                                                                                  |
| ----------------- | ------ | ------------------------------------------------------------------------------------------- |
| **Authorization** | `XAL`  | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers` |
| **Refresh Token** | `Fb$`  | `user:profile user:inference user:sessions:claude_code user:mcp_servers`                    |

**關鍵差異**: Refresh Token 時**不包含** `org:create_api_key`！

#### 1.2 錯誤案例

若在 refresh_token grant 中包含 `org:create_api_key`，會收到 `invalid_scope` 錯誤。

#### 1.3 逆向工程參考

```javascript
// 官方 CLI 中的定義 (minified)
Fb$ = ["user:profile", VR, "user:sessions:claude_code", "user:mcp_servers"]  // VR = "user:inference"
XAL = Array.from(new Set([...WgB, ...Fb$]))  // WgB 包含 org:create_api_key

// Refresh 請求
{
  grant_type: "refresh_token",
  refresh_token: H,
  client_id: XD().CLIENT_ID,
  scope: Fb$.join(" ")  // 只用 Fb$，不用 XAL
}
```

- **注意**: 缺少 `user:sessions:claude_code` 會導致 Session API 404 或 Message API 400 錯誤。

### 2. 請求標頭 (Headers) 模擬

Anthropic 對於 Subscription Token 實施了嚴格的客戶端驗證。

- **User-Agent**:
  - 官方格式: `claude-code/2.1.37`
  - **回退策略**: 若官方格式被擋，可嘗試 `claude-cli/2.1.37 (external, cli)` (Legacy format)。
- **anthropic-version**: 必須設為 `2023-06-01`，否則會被拒絕。
- **anthropic-beta**: 必須包含 `claude-code-20250219` 與 `oauth-2025-04-20`。
- **anthropic-client**: 源碼分析顯示未被使用，應移除以避免特徵不符。

### 3. Session 初始化機制 (Session API)

Claude Code 的對話模式（特別是 Tool Use）依賴 Session API。

- **API**: `POST /v1/sessions` (Endpoint 可能為 `https://api.anthropic.com/v1/sessions`)
- **狀態**: 目前該 Endpoint 對於外部模擬可能回傳 404，但 **Haiku 等輕量模型** 可透過正確的 Headers (`anthropic-version`) 直接使用 `/v1/messages` 繞過。
- **限制**: Opus 模型或複雜 Tool Use 可能因 Session 初始化失敗而受限。

### 4. 逆向工程指南

若需更新協議，可直接分析已安裝的 Claude CLI 二進位檔：

```bash
# 方法 1: 從二進位提取字串 (推薦)
which claude  # 通常在 ~/.local/bin/claude

# 搜尋 refresh token 相關邏輯
node -e "const fs=require('fs'); const c=fs.readFileSync('$(which claude)','utf8'); console.log(c.match(/grant_type.*refresh_token[^}]{0,300}/g))"

# 搜尋 scope 定義
node -e "const fs=require('fs'); const c=fs.readFileSync('$(which claude)','utf8'); console.log(c.match(/Fb\\\$=\[.*?\]/g))"

# 搜尋 VR 變數 (user:inference)
node -e "const fs=require('fs'); const c=fs.readFileSync('$(which claude)','utf8'); console.log(c.match(/VR=\"[^\"]+\"/g))"
```

**關鍵變數名稱** (可能隨版本變動):

- `Fb$`: Refresh Token 用的 scope 陣列
- `XAL`: Authorization 用的完整 scope 陣列
- `VR`: 通常是 `"user:inference"`
- `XD()`: 返回 OAuth 設定物件 (CLIENT_ID, TOKEN_URL 等)

或分析 `node_modules/@anthropic-ai/claude-code/cli.js` (需先安裝):

1. 搜尋 `v1/sessions` 找出 Session Endpoint 與 Body 結構。
2. 搜尋 `function S0` 找出 Header 構造邏輯。
3. 搜尋 `Fb$` 或 `user:sessions` 找出 Refresh Token 的 Scope 列表。
4. 搜尋 `XAL` 找出 Authorization 的完整 Scope 列表。

## 維護工作流

1. **分析 Submodule**: 檢查 `refs/claude-code` 的變更。若該目錄僅含文檔，請嘗試 `npm install @anthropic-ai/claude-code` 並分析 `cli.js`。
2. **對比實作**: 使用 [reproduction_summary.md](references/reproduction_summary.md) 中的要點檢查現有程式碼。
3. **更新憑證**: 若 OAuth 域名有變 (如從 console 移至 platform)，同步更新 `src/plugin/anthropic.ts`。
4. **測試 Session**: 確保新的對話能成功觸發伺服器端的 Session 初始化。

## 參考資料

詳細的實作細節與參數範例請見：[references/reproduction_summary.md](references/reproduction_summary.md)
以及失敗嘗試記錄：[docs/events/faillog_claude_code_protocol.md](../../../docs/events/faillog_claude_code_protocol.md)
