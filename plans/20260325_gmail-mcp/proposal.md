# Proposal

## Why

- 使用者希望透過自然語言在 AI session 中直接存取 Gmail 信箱，處理郵件內容
- 系統已有 Google Calendar managed app 成功運作，Gmail 是同一 GCP 專案下的自然延伸
- 比照 Calendar 的 managed app 架構可最大化程式碼重用與一致性

## Original Requirement Wording (Baseline)

- "gmail api串接實作。我希望比照行事曆的做法，製成mcp後串接本系統和gmail，讓我能透過言語存取信箱和處理內容。"
- "直接拿一個full scope並且不用與calendar分token"

## Requirement Revision History

- 2026-03-25: 初始需求確立。Full scope + 共用 token 由使用者直接確認。

## Effective Requirement Description

1. 在 Managed App 架構下新增 `gmail` app，提供信箱讀取、搜尋、寄信、回覆、轉寄、標籤管理、草稿等操作
2. 使用 `https://mail.google.com/` full access scope
3. 與 Google Calendar 共用 `gauth.json` OAuth token，不分離儲存
4. OAuth 連線時合併所有已安裝 Google app 的 scopes

## Scope

### IN

- Gmail REST API client（raw fetch，比照 Calendar 模式）
- 10 個 tool executors
- BUILTIN_CATALOG 註冊
- OAuth connect/callback 泛化（支援多個 Google app 共用 token）
- MCP routing map 加入 gmail executor
- `.env` 新增 Gmail scope 設定
- GCP Console 手動步驟記錄

### OUT

- 附件下載/上傳（後續迭代）
- Gmail Push / Pub/Sub watch（refs/openclaw 的做法，不採用）
- Token refresh 機制改動（沿用現有）
- 前端 UI 改動（App Market 已泛化，自動支援新 app）

## Non-Goals

- 不建立獨立的 Gmail OAuth client，沿用 Calendar 的 GCP 專案
- 不修改現有 Calendar app 的行為
- 不實作 HTML email 渲染（使用 text/plain + snippet fallback）

## Constraints

- Gmail API base URL: `https://gmail.googleapis.com/gmail/v1`
- Message body 為 base64url 編碼，需 encode/decode
- 寄信需建構 RFC 2822 格式後 base64url encode
- Reply 需帶 `threadId` + `In-Reply-To` + `References` headers
- GCP Console 需手動啟用 Gmail API 並加入 scope（不在程式碼範圍）

## What Changes

- 新增 `packages/opencode/src/mcp/apps/gmail/` 目錄（client.ts + index.ts）
- 修改 `app-registry.ts` 加入 gmail catalog entry
- 修改 `mcp/index.ts` 加入 gmail executor routing
- 修改 `server/routes/mcp.ts` 泛化 OAuth connect/callback
- 修改 `.env` 加入 Gmail scope

## Capabilities

### New Capabilities

- `gmail.labels.read`: 列出信箱 labels
- `gmail.messages.read`: 搜尋/讀取郵件
- `gmail.messages.write`: 寄信、回覆、轉寄
- `gmail.messages.manage`: 標籤管理、移到垃圾桶
- `gmail.drafts`: 列出/建立草稿

### Modified Capabilities

- `google-calendar.oauth` → OAuth connect 泛化：連線任一 Google app 時合併所有 scopes，callback 後連動啟用所有已安裝的 Google apps

## Impact

- OAuth connect/callback route 從 Calendar 專用改為 Google app 通用
- 使用者需重新 OAuth 授權以取得 Gmail scope（既有 Calendar token 會被覆蓋為包含兩者的新 token）
- GCP Console 需手動操作（啟用 Gmail API + 加入 scope）
