# Event: Session Fork Seed Guard

Date: 2026-02-13
Status: Done

## 1. 需求分析

- [x] 避免不完整 seed session 進入正式 fork 流程，降低 UI 出現 `QUEUED` 浮動殘留風險
- [x] 為 fork 建立可重現的驗證機制（可見性與內容完整性）
- [x] 將本次 RCA 與修復紀錄到 `docs/events`

## 2. 執行計畫

- [x] 抽出 `system-manager` fork 驗證邏輯成可測試模組 (Done)
- [x] 在 fork 前驗證 source session 結構，fatal 時直接阻擋 (Done)
- [x] 在 fork 後驗證 result session（index + message history）(Done)
- [x] 對疑似 seed session（只有 user 無 assistant）輸出 warning (Done)
- [x] 新增測試覆蓋 source/result 驗證情境 (Done)

## 3. 關鍵決策與發現

- 手動 seed session 的主要風險不是單一檔案缺失，而是「訊息狀態鏈不完整」，容易導致 TUI 將最後狀態視為 pending。
- 採用「fork 前 + fork 後」雙階段驗證：
  - 前置：避免從壞 source 繼續複製問題。
  - 後置：確保新 session 至少具備 UI 需要的索引與訊息資料。
- 對 `only user/no assistant` 採 warning（非硬擋），避免誤殺合法但尚未回覆的短 session。

## 4. 遺留問題 (Pending Issues)

- [ ] 若未來要完全阻擋 seed session，需要在 runtime 事件流引入更精確的 pending/working 狀態判定，而非僅靠檔案靜態判斷。
