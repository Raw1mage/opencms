# Errors

## Error Catalogue

- **CLAUDE_CLI_AUTH_EXCHANGE_FAILED** — OAuth authorization code exchange 失敗
  - **Message**: "Token exchange failed ({status}): {error}. Please re-authenticate."
  - **Status**: varies (400, 401, 403)
  - **Trigger**: `exchange()` 回傳非 200
  - **Recovery**: 使用者重新執行 OAuth login flow
  - **Layer**: plugin/claude-cli/auth.ts

- **CLAUDE_CLI_TOKEN_REFRESH_FAILED** — Token refresh 失敗
  - **Message**: "Token refresh failed ({status}): {error}. Please re-authenticate."
  - **Status**: varies (400, 401)
  - **Trigger**: refresh_token 無效或過期
  - **Recovery**: 使用者重新登入；mutex 確保只有一個 refresh in flight
  - **Layer**: provider-claude/auth.ts（已有，不在此計畫修改）

- **CLAUDE_CLI_PROFILE_FETCH_FAILED** — OAuth profile fetch 失敗（非致命）
  - **Message**: (logged as warning, does not block auth)
  - **Status**: varies
  - **Trigger**: `api.anthropic.com/api/oauth/profile` 回傳非 200
  - **Recovery**: Auth 仍成功，但缺少 email/orgID 資訊
  - **Layer**: plugin/claude-cli/auth.ts

- **CLAUDE_CLI_PLUGIN_IMPORT_FAILED** — provider-claude package import 失敗
  - **Message**: "Failed to import @opencode-ai/provider-claude: {error}"
  - **Status**: startup error
  - **Trigger**: package 不存在或版本不相容
  - **Recovery**: 重新安裝 dependencies；明確報錯（AGENTS.md 第一條：不可靜默 fallback）
  - **Layer**: plugin/claude-cli/index.ts

## Error Code Format

`CLAUDE_CLI_` prefix + uppercase snake_case 描述。

## Recovery Strategies

- **Re-auth**: 引導使用者重新執行 OAuth login（最常見）
- **Explicit error**: 不可靜默 fallback，必須拋出或 log.error（Memory: No Silent Fallback）
- **Mutex guard**: Token refresh 使用 pending-promise pattern 防止 concurrent race
