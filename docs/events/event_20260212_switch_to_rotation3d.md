# Event: Switch Antigravity to Rotation3D

Date: 2026-02-12
Status: Implementation
Topic: rotation_unification

## 1. 需求 (Requirement)

用戶要求 Antigravity Plugin 停止使用內部的 `AccountManager` 進行帳號輪替，改為統一使用 CMS 的 `rotation3d` 機制。

## 2. 現狀分析 (Current State)

- `index.ts`: 使用 `AccountManager` 載入所有帳號，並在 `execute` 中使用 `accountManager.getCurrentOrNextForFamily` 進行輪替。
- `plugin/accounts.ts`: 包含複雜的 `AccountManager` 邏輯。
- `plugin/rotation.ts`: 包含內部的 `HealthScoreTracker` 和 `TokenBucketTracker`。

## 3. 修改計畫 (Plan)

1.  **Refactor `index.ts`**:
    - 移除 `AccountManager` 相關代碼。
    - 引入 `rotation3d` 的 `getNextAvailableVector` 和 `reportFailure` (需確認 API)。
    - 重寫 `google_search` 的執行迴圈：
      - 初始：`Account.getActive("antigravity")`。
      - 錯誤處理：
        - 判斷錯誤類型。
        - 更新 `rotation` 狀態 (Global Tracker)。
        - 呼叫 `getNextAvailableVector` 獲取下一個帳號。
        - 使用 `Account.get("antigravity", nextAccountId)` 獲取憑證。

2.  **Cleanup**:
    - 刪除或標記廢棄 `plugin/accounts.ts` 和 `plugin/rotation.ts` 中的冗餘邏輯。

## 4. 關鍵 API 確認

- `packages/opencode/src/account/rotation3d.ts`:
  - `getNextAvailableVector(current, config)`
  - `isVectorRateLimited(vector)`
- `packages/opencode/src/account/rotation.ts`:
  - `getHealthTracker().recordFailure(...)`
  - `getRateLimitTracker().markRateLimited(...)`

## 5. 執行步驟

- [ ] Modify `index.ts` to use `rotation3d`.
- [ ] Remove `plugin/accounts.ts` complex logic (keep types if needed).
- [ ] Remove `plugin/rotation.ts`.
