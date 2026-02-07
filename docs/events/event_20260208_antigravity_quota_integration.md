# Event: Antigravity Quota Tracking & Rotation3D Integration

Date: 2026-02-08
Status: Done
Topic: Synchronizing Antigravity cockpit quota reset times with global Rotation3D system.

## 1. 需求分析

- CMS 的 `Rotation3D` 需要精確的 `waitTimeMs` 才能在多帳號間進行有效切換。
- 原本 Antigravity Plugin 遇到 429 時僅使用硬編碼的指數退避 (Exponential Backoff)，無法得知真實重置時間。
- 需要在 TUI (Admin Panel) 顯示具體的重置倒數。

## 2. 關鍵決策與發現

- **Real-time Query**: 在觸發 429 錯誤或計算 Fallback 候選名單時，主動向 Antigravity Cockpit API 查詢 `fetchAvailableModels`。
- **Claude Quota Logic**: 發現 Claude 模型經常回傳 `resetTime` 但 `remainingFraction` 為 undefined。決策：若重置時間在未來，一律視為配額用盡 (0%)。
- **Global Sync**: 修改 Plugin 核心，將偵測到的限額狀態即時推送到全域 `RateLimitTracker`，達成跨 Provider 的連動。

## 3. 執行項目 (Done)

- [x] `src/account/rotation3d.ts`: 整合 Antigravity 配額載入邏輯。
- [x] `src/plugin/antigravity/plugin/quota.ts`: 實作精準的 `resetTime` 擷取函式。
- [x] `src/plugin/antigravity/index.ts`: 429 處理流程介入 Cockpit 查詢並同步全域狀態。
- [x] `src/cli/cmd/tui/component/dialog-admin.tsx`: 介面支援顯示 `⏳` 倒數。

## 4. 遺留問題

- 頻繁查詢 Cockpit API 可能會受到該 API 本身的速率限制。
