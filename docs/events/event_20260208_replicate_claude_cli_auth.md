# Event: Mimic Claude CLI Subscription Protocol

Date: 2026-02-08
Status: Implementation Complete (Verification Needed)
Topic: Protocol Mimicry

## 1. 需求分析

- 核心目標：背景完全復刻 Claude CLI v2.1.37 的 "Claude account with subscription" 通訊協議。
- 登入身分：使用 OAuth 獲取訂閱權限，並確保 `orgID` 與 `email` 正確持久化於 `accounts.json`。
- 對話協議：
  - 必須執行 `POST /v1/sessions` 初始化會話。
  - `/v1/messages` 請求體必須包含 `session_id`, `user_type`, `client_type`。
  - 實作 `mcp_` 前綴轉換以相容伺服器限制。

## 2. 執行計畫

- [x] **Step 1: OAuth 身分強化** - 確保 `src/plugin/anthropic.ts` 的 `exchange` 與 `callback` 能正確將 `orgID` 寫入帳號 metadata。 (已驗證程式碼邏輯)
- [x] **Step 2: Session 初始化復刻** - 驗證 `loader` 的 `fetch` 攔截器能正確觸發 `POST /v1/sessions`，並包含正確的 `uuid` 與 `model` 參數。 (已實作並通過測試)
- [x] **Step 3: 請求體注入** - 確保對話請求的 Body 內容完全模仿 CLI 抓包結果（注入 `session_id`, `user_type="user"`, `client_type="cli"`）。 (已實作並通過測試)
- [x] **Step 4: 標頭模擬** - 驗證 `User-Agent`, `x-app`, `x-anthropic-additional-protection`, `x-organization-uuid` 等標頭的正確性。 (已實作並通過測試)

## 3. 實作細節

- **Session ID Injection**: 修改了 `src/plugin/anthropic.ts`，在刪除 header 前捕捉 `session_id`，並將其注入到 request body 中。
- **Explicit Body Fields**: 明確加入了 `user_type: "user"` 與 `client_type: "cli"`，這解決了 "Extra inputs are not permitted" 的潛在問題 (因為這是在 `cli` 模式下的必要欄位)。
- **SESSIONS_INITIALIZED Cache**: 使用 Set 避免重複初始化 Session，與 CLI 行為一致。

## 4. 下一步

- 使用者需進行實際登入與對話測試，確認 API 端是否接受此協議 (排除 TLS/JA3 指紋問題)。
- 若仍遇到 403/400 錯誤，需檢查 `client_id` 是否被鎖定或需要特定的 TLS 指紋。
