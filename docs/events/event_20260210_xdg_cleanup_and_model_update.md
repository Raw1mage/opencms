# Event: XDG Cleanup and Model Selector Update

Date: 2026-02-10
Status: Done

## 1. 需求分析 (Analysis)

...

- [x] **Step 4: 驗證**
  - [x] 檢查 `/admin` 或 `/models` 輸出。
  - [x] 模擬在 Home 目錄啟動，確認不加載 `~/.opencode/config.json`。

  - 檢查 `/admin` 或 `/models` 輸出。
  - 模擬在 Home 目錄啟動，確認不加載 `~/.opencode/config.json`。

## 3. 關鍵決策與發現

- 決策：不直接刪除 `~/.opencode` 的遷移代碼 (如 `Account` 模組)，因為仍有新用戶可能從舊版遷移。但必須切斷其「隱性加載」作為配置來源的路徑。

## 4. 遺留問題 (Pending Issues)

- 無。
