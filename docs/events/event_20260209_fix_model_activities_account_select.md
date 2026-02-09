# Event: Fix Model Activities Account Selection

Date: 2026-02-09
Status: Done

## 1. 需求分析

- **問題描述**: 在 Admin Panel 的 Model Activities 頁面中，如果一個模型有多個帳號，且當前帳號 (第一個) 處於 Rate Limit 狀態，使用者無法透過游標選擇同模型的第二個帳號。系統會強制切換回第一個帳號。
- **成因分析**:
    - `selectActivity` 函數僅調用了 `local.model.set` 來切換模型 ID，但沒有調用 `Account.setActive` 來切換該 Provider 的活動帳號。
    - 由於 Provider 的活動帳號在後端依然是第一個帳號，LLM 請求發出時會繼續使用第一個帳號，觸發 Rate Limit 或 Fallback 邏輯。
- **解決方案**:
    - 修改 `selectActivity`，在切換模型的同時，根據選中的行資訊調用 `handleSetActive` 切換活動帳號。
    - 確保 `activityAccounts` 資源能響應 `refreshSignal`，使 UI 上的活動帳號標記 (✅) 能即時更新。

## 2. 執行計畫

- [x] 修改 `src/cli/cmd/tui/component/dialog-admin.tsx`:
    - [x] 將 `selectActivity` 改為 `async` 函數。
    - [x] 在 `selectActivity` 中解析選中的 `accountId` 並調用 `handleSetActive`。
    - [x] 將 `activityAccounts` Resource 改為依賴 `refreshSignal` 並調用 `Account.refresh()`。
- [x] 驗證變更 (語法檢查通過)。

## 3. 關鍵決策與發現

- 選擇直接調用 `handleSetActive` 而不是 `Account.setActive`，因為 `handleSetActive` 封裝了 Antigravity 帳號管理員的重載邏輯與 `forceRefresh` 調用。
- 將 `activityAccounts` 改為 Resource 並連結 `refreshSignal` 是確保 UI 狀態同步的關鍵。

## 4. 遺留問題 (Pending Issues)

- 無。
