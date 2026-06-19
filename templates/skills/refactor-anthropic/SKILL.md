---
name: refactor-anthropic
description: 專用於維護與更新 CMS 的 Anthropic Provider，使其與 Claude CLI (claude-code) 的行為保持同步。當官方 claude-code (refs/claude-code-npm) 有更新、或需要修復 Anthropic OAuth、Session 管理、身分模擬 (Headers/Prompt) 時使用。
---

# Refactor Anthropic Skill

本技能旨在指導如何將官方 claude-code (`refs/claude-code-npm/cli.js`) 的最新邏輯同步到 CMS 的 `packages/provider-claude/`（HTTP/OAuth/headers）與 `packages/opencode/src/plugin/claude-cli/`（plugin 接線），確保認證流程、請求標頭與 Session 機制始終與官方 CLI 一致。

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

#### 1.4 Authorize 端點依登入型態而異 (2026-05-30 補)

官方依 `loginWithClaudeAi` 旗標選擇 **authorize server**，opencode 的兩個 auth method 一一對應：

| 登入型態 | Authorize URL | 常數 |
| --- | --- | --- |
| 訂閱 (Pro/Max/Team/Enterprise) | `https://claude.com/cai/oauth/authorize` | `CLAUDE_AI_AUTHORIZE_URL` / 本 repo `OAUTH.authorizeClaude` |
| Console (API key) | `https://platform.claude.com/oauth/authorize` | `CONSOLE_AUTHORIZE_URL` / 本 repo `OAUTH.authorizeConsole` |

- **關鍵**: `redirect_uri` 與 token 端點 (`/v1/oauth/token`) 兩種登入**共用 `platform.claude.com`**，不隨 authorize host 改變。
- **錯誤案例**: `authorize()` 若不分模式一律用 `authorizeConsole`，訂閱登入會在 console AS 拿到 console 脈絡的 code，換 Max token 失敗（曾誤判為 rate limit）。修正：`new URL(mode === "console" ? OAUTH.authorizeConsole : OAUTH.authorizeClaude)`。

### 2. 請求標頭 (Headers) 模擬

Anthropic 對於 Subscription Token 實施了嚴格的客戶端驗證。

- **User-Agent（依端點而異！2026-05-30 補，務必區分）**:
  - **推論端點** (`api.anthropic.com`，Messages/Session API): `claude-code/<ver>`（如 `claude-code/2.1.156`）。
  - **OAuth token 端點** (`platform.claude.com/v1/oauth/token`，即 exchange / refresh): **必須用 `axios/x`**（官方 OAuth 呼叫 `Zn8`/refresh 走 plain axios，UA 自然是 `axios/<ver>`）。
    - 實測（2026-05-30，送無效 refresh_token 探測）：此端點**按 User-Agent 分桶節流**，`claude-code/<ver>` →429 `rate_limit_error`（憑證未驗即擋），`axios/*`／`node`／`Bun/x`／任意非 claude-code UA →400（進到正常驗證）。推測為反冒充節流：真實 CLI 不在此端點用 claude-code UA。
    - **切勿**把推論的 `claude-code/<ver>` 套到 OAuth 呼叫 —— 會把 429 鎖死（本 repo 2026-05-30 踩過一次）。
    - 舊「回退到 `claude-cli/2.1.37 (external, cli)`」字樣僅針對推論端點的歷史備案，與 OAuth 端點無關。
- **anthropic-version**: 推論端點必須設為 `2023-06-01`。OAuth exchange/refresh 官方**只送 `Content-Type`**（不送 anthropic-version/beta）；profile 呼叫會帶 `anthropic-beta: oauth-2025-04-20`。
- **anthropic-beta**: 推論端點必須包含 `claude-code-20250219` 與 `oauth-2025-04-20`。
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

1. **分析官方 bundle**: protocol 真相在 npm bundle，已 vendored 於 `refs/claude-code-npm/cli.js`（`refs/claude-code` 只含文檔/issue 腳本，非 CLI 源碼）。`refs/claude-code` submodule 已移除。
2. **自動對帳**: 跑 `bun packages/provider-claude/scripts/sync-from-cli.ts`（抓 npm binary，對 `protocol.ts`/`models.ts` 做 drift check，含 OAuth host/UA/scope 行為斷言）。
3. **對比實作**: 對正式 wire datasheet `specs/claude-cli/cli-reversed-spec/chapters/protocol-datasheets.md` + 本 SKILL §1–3 檢查程式碼。
4. **更新實作**: 變更落在 `packages/provider-claude/src/{auth,protocol,headers}.ts` 與 `packages/opencode/src/plugin/claude-cli/{index,auth}.ts`（舊 `src/plugin/anthropic.ts` 已移除）。
5. **測試 Session**: 確保新的對話能成功觸發伺服器端的 Session 初始化。

## 參考資料

- 正式 wire 協議 datasheet（SSOT）：`specs/claude-cli/cli-reversed-spec/chapters/protocol-datasheets.md`
- OAuth 層 RCA 與決策留痕（2026-05-30 host/UA/scope）：`specs/claude-cli/cli-reversed-spec/events/`
- 對帳工具：`packages/provider-claude/scripts/sync-from-cli.ts`（`--version` 可指定版本）
