# Event: Refactor System to 3D Coordinate Identification

Date: 2026-02-10
Status: Done

## 1. 需求分析

- [x] 使用者質疑為何 `AccountID` 必須在全域唯一且包含 Provider。
- [x] 目標：貫徹 3D 座標 `(Provider, Model, Account)` 辨識機制，讓 `AccountID` 回歸為簡單的帳號名稱。
- [x] 技術方案：
    - 修改 `Account.generateId` 移除冗餘前綴。
    - 重構 `HealthScoreTracker` 和 `RateLimitTracker` 內部 Key，將 Provider 納入唯一性考量。
    - 更新全系統呼叫點，強制傳遞 Provider 資訊。

## 2. 執行計畫

- [x] 修改 `packages/opencode/src/account/index.ts` 中的 `generateId`。
- [x] 修改 `packages/opencode/src/account/rotation.ts` 中的 Tracker，實作 `makeKey(provider, accountId)`。
- [x] 更新 `Account.recordSuccess`, `recordRateLimit`, `recordFailure` 等 API 簽名。
- [x] 更新 `packages/opencode/src/session/llm.ts` 配合新的 Tracker API。
- [x] 更新 `Account.getNextAvailable` 配合新的 Tracker API。
- [x] 驗證 3D 座標在 Rotation Toast 中的顯示。

## 3. 關鍵決策與發現

- **相容性處理**：在 `makeKey` 中加入檢查，若舊 ID 已包含 Provider 則不重複拼接，確保既有帳號資料在遷移期仍可運作。
- **架構優化**：現在 `HealthScore` 是根據 `Provider:Account` 追蹤，真正實現了不同 Provider 之間同名帳號的隔離。

## 4. 遺留問題 (Pending Issues)

- 無。
