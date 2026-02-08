# Event: Mimic Claude CLI Subscription Protocol

Date: 2026-02-08
Status: Planning
Topic: Protocol Mimicry

## 1. 需求分析
- 核心目標：背景完全復刻 Claude CLI v2.1.37 的 "Claude account with subscription" 通訊協議。
- 登入身分：使用 OAuth 獲取訂閱權限，並確保 `orgID` 與 `email` 正確持久化於 `accounts.json`。
- 對話協議：
  - 必須執行 `POST /v1/sessions` 初始化會話。
  - `/v1/messages` 請求體必須包含 `session_id`, `user_type`, `client_type`。
  - 實作 `mcp_` 前綴轉換以相容伺服器限制。

## 2. 執行計畫
- [ ] **Step 1: OAuth 身分強化** - 確保 `src/plugin/anthropic.ts` 的 `exchange` 與 `callback` 能正確將 `orgID` 寫入帳號 metadata。
- [ ] **Step 2: Session 初始化復刻** - 驗證 `loader` 的 `fetch` 攔截器能正確觸發 `POST /v1/sessions`，並包含正確的 `env` 參數。
- [ ] **Step 3: 請求體注入** - 確保對話請求的 Body 內容完全模仿 CLI 抓包結果（注入 `session_id` 等欄位）。
- [ ] **Step 4: 標頭模擬** - 驗證 `User-Agent`, `x-app`, `x-anthropic-additional-protection`, `x-organization-uuid` 等標頭的正確性。

## 3. 關鍵決策
- 專注於後端協議與身分模仿，UI 標籤僅作為輔助，不作為核心目標。
- 透過 `accounts.json` 的 `metadata` 儲存 `orgID`，確保多帳號與持久化穩定。
