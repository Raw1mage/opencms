# Spec

## Purpose

讓使用者在 AI session 中透過自然語言操作 Gmail 信箱，包括讀取、搜尋、寄信、回覆、轉寄、標籤管理和草稿管理。

## Requirements

### Requirement: Gmail Tools Available

系統 SHALL 在 `gmail` managed app 處於 ready 狀態時，向 AI session 暴露 10 個 Gmail tools。

#### Scenario: App Market 顯示 Gmail app

- **GIVEN** gmail 已註冊於 BUILTIN_CATALOG
- **WHEN** 使用者開啟 App Market
- **THEN** 顯示 Gmail app（含名稱、描述、capabilities）

#### Scenario: 安裝並連線後 tools 可用

- **GIVEN** 使用者已安裝 gmail app
- **WHEN** 完成 OAuth 連線
- **THEN** gauth.json 包含有效 access_token，gmail app 狀態變為 ready，10 個 tools 可被 AI 呼叫

### Requirement: Gmail Message Read

系統 SHALL 支援搜尋和讀取 Gmail 郵件，輸出為 Markdown 格式。

#### Scenario: 搜尋郵件

- **GIVEN** gmail app 處於 ready 狀態
- **WHEN** AI 呼叫 `list-messages` tool，傳入 query="from:someone@example.com"
- **THEN** 回傳符合條件的郵件清單（含 subject, from, date, snippet），最多 10 筆

#### Scenario: 讀取單封郵件

- **GIVEN** gmail app 處於 ready 狀態
- **WHEN** AI 呼叫 `get-message` tool，傳入 messageId
- **THEN** 回傳完整郵件內容（headers + text/plain body），超過 2000 字元時 truncate

### Requirement: Gmail Message Write

系統 SHALL 支援寄信、回覆和轉寄，正確處理 RFC 2822 格式和 threading headers。

#### Scenario: 寄送新郵件

- **GIVEN** gmail app 處於 ready 狀態
- **WHEN** AI 呼叫 `send-message` tool，傳入 to, subject, body
- **THEN** 郵件成功送出，回傳 message ID 和 thread ID

#### Scenario: 回覆郵件

- **GIVEN** gmail app 處於 ready 狀態，且已有原始郵件 ID
- **WHEN** AI 呼叫 `reply-message` tool，傳入 messageId, body
- **THEN** 回覆郵件帶有正確的 In-Reply-To, References headers，且屬於同一 thread

#### Scenario: 轉寄郵件

- **GIVEN** gmail app 處於 ready 狀態，且已有原始郵件 ID
- **WHEN** AI 呼叫 `forward-message` tool，傳入 messageId, to
- **THEN** 轉寄郵件包含原始郵件的 header 資訊和 body

### Requirement: Gmail Label Management

系統 SHALL 支援列出 labels 和修改郵件的 labels。

#### Scenario: 列出 labels

- **GIVEN** gmail app 處於 ready 狀態
- **WHEN** AI 呼叫 `list-labels` tool
- **THEN** 回傳 system labels 和 user labels（含 unread count）

#### Scenario: 標記郵件已讀

- **GIVEN** gmail app 處於 ready 狀態
- **WHEN** AI 呼叫 `modify-labels` tool，傳入 messageId, removeLabelIds=["UNREAD"]
- **THEN** 郵件的 UNREAD label 被移除

### Requirement: Shared OAuth Token

系統 SHALL 讓 Gmail 和 Calendar 共用同一個 OAuth token（gauth.json）。

#### Scenario: OAuth connect 合併 scopes

- **GIVEN** google-calendar 和 gmail 都已安裝
- **WHEN** 使用者從任一 app 發起 OAuth connect
- **THEN** OAuth 請求包含 Calendar scopes + Gmail scope，callback 後兩個 app 都被 enable

#### Scenario: 只安裝 Gmail 時 OAuth connect

- **GIVEN** 只有 gmail 已安裝，google-calendar 未安裝
- **WHEN** 使用者發起 OAuth connect
- **THEN** OAuth 請求只包含 Gmail scope

### Requirement: Trash with Confirmation

系統 SHALL 要求使用者確認才能將郵件移到垃圾桶。

#### Scenario: Trash 需要確認

- **GIVEN** gmail app 處於 ready 狀態
- **WHEN** AI 嘗試呼叫 `trash-message` tool
- **THEN** 系統因 `requiresConfirmation: true` 先向使用者確認，獲同意後才執行

## Acceptance Checks

- App Market 可見 Gmail app 並可安裝
- OAuth connect 後 gauth.json 有效
- list-labels 回傳 label 清單
- list-messages 支援 Gmail query syntax
- get-message 回傳完整郵件（含 decoded body）
- send-message 成功寄出郵件
- reply-message 正確串接 thread
- forward-message 包含原始郵件內容
- modify-labels 可加/移除 labels
- trash-message 需要確認
- list-drafts 回傳草稿清單
- create-draft 成功建立草稿
- 既有 Calendar tools 正常運作
