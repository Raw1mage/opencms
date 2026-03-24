# Design

## Context

OpenCode 已有 Google Calendar managed app 運作中，採用 raw fetch REST client + fail-fast + Markdown 輸出的模式。Gmail 是同一 GCP 專案下的自然延伸，架構上完全比照 Calendar。

現有 OAuth flow 硬編為 google-calendar 專用，需泛化為支援多個 Google app。

## Goals / Non-Goals

**Goals:**

- 新增 Gmail managed app，完全比照 Calendar 架構
- 泛化 OAuth flow 為 Google app 通用機制
- 共用 gauth.json token，一次授權多 app

**Non-Goals:**

- 不改動 Calendar app 的 tool 行為
- 不處理 HTML email 渲染
- 不處理附件

## Decisions

- DD-1: **Full scope `https://mail.google.com/`** — 使用者明確要求，避免 scope 不足需要反覆重新授權
- DD-2: **共用 `gauth.json`** — 使用者明確要求，減少 token 管理複雜度
- DD-3: **OAuth connect scope 合併** — connect 任一 Google app 時，收集所有已安裝 Google apps 的 scopes 合併請求。確保一次授權涵蓋所有 app
- DD-4: **OAuth callback 連動 enable** — callback 成功後，對所有已安裝的 Google OAuth apps 呼叫 setConfigKeys + enable，不只是發起 connect 的那個 app
- DD-5: **Google OAuth app 白名單** — 在 OAuth route 中維護 `GOOGLE_OAUTH_APPS` 白名單（目前 `["google-calendar", "gmail"]`），其他 appId 仍回傳 400
- DD-6: **Config key 共用 `googleOAuth`** — 兩個 app 使用相同的 config key，因為 token 相同。OAuth callback 後兩者都標記 config complete
- DD-7: **Env vars 沿用 `GOOGLE_CALENDAR_*`** — CLIENT_ID/SECRET/AUTH_URI/TOKEN_URI 沿用現有命名（同一 GCP 專案），只新增 `GOOGLE_GMAIL_SCOPE`

## Data / State / Control Flow

### OAuth Connect Flow（泛化後）

```
User clicks Connect on Gmail (or Calendar)
  → GET /api/v2/mcp/apps/gmail/oauth/connect
  → Backend collects scopes from all installed Google OAuth apps
  → Redirect to Google OAuth consent with merged scopes
  → User authorizes
  → GET /api/v2/mcp/apps/gmail/oauth/callback?code=...
  → Backend exchanges code for tokens
  → Write tokens to gauth.json
  → For each installed Google OAuth app:
      → setConfigKeys(appId, ["googleOAuth"])
      → enable(appId)
  → Return success HTML
```

### Tool Execution Flow

```
AI calls gmail_list_messages(query="...")
  → MCP.convertManagedAppTool() dispatches to GmailApp.execute()
  → resolveAccessToken() reads gauth.json
  → GmailClient.listMessages() calls Gmail REST API
  → Format response as Markdown
  → Return to AI session
```

## Risks / Trade-offs

- **Risk: OAuth re-auth 覆蓋 Calendar token** → Mitigation: 合併 scopes 確保新 token 涵蓋兩者。如果使用者只安裝 Gmail 而未安裝 Calendar，token 只會有 Gmail scope，但這是正確行為
- **Risk: GCP Console 未啟用 Gmail API** → Mitigation: 記錄手動步驟於 event log，OAuth 會在 consent screen 顯示錯誤
- **Risk: text/plain body 不存在（HTML-only email）** → Mitigation: fallback 到 message.snippet
- **Risk: base64url encode 大型郵件超過 AI context** → Mitigation: list-messages 限制回傳筆數（預設 10），get-message truncate body 到 2000 字元

## Critical Files

- `packages/opencode/src/mcp/apps/gmail/client.ts` — Gmail REST API client
- `packages/opencode/src/mcp/apps/gmail/index.ts` — Tool executors + formatters
- `packages/opencode/src/mcp/app-registry.ts` — BUILTIN_CATALOG (lines 269-501 for Calendar reference)
- `packages/opencode/src/mcp/index.ts` — managedAppExecutors routing (line 202)
- `packages/opencode/src/server/routes/mcp.ts` — OAuth connect (line 314) + callback (line 360)
- `.env` — Google OAuth config (lines 36-43)
