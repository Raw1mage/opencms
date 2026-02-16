#### 功能：修復 Model Activities 顯示邏輯並新增刪除收藏快捷鍵

**需求**

- 修復 Model Activities 的過濾邏輯，使其僅顯示「收藏的項目」(Favorites) 及其相關的帳號與配額資訊。
- 在 Model Activities 介面中新增 (D)elete 鍵，讓使用者能按 `d` 將選中的項目從收藏中移除。

**範圍**

- IN：`src/cli/cmd/tui/component/dialog-admin.tsx` 的 `activityData` 過濾邏輯調整。
- IN：`src/cli/cmd/tui/component/dialog-admin.tsx` 的 `DialogSelect` 快捷鍵配置。
- OUT：修改 `local.model.toggleFavorite` 本身的邏輯（維持現狀即可）。

**方法**

- 修改 `activityData` 中的 `createMemo`，移除除了 `favorites` 以外的所有模型來源。
- 在 `DialogSelect` 的 `keybind` 陣列中，針對 `page() === "activities"` 新增 `d` 鍵的 `onTrigger` 處理，解析選中的 `value` 並呼叫 `toggleFavorite`。

**任務**

1. [x] 修改 `src/cli/cmd/tui/component/dialog-admin.tsx` 中的 `activityData` 過濾邏輯。
2. [x] 在 `src/cli/cmd/tui/component/dialog-admin.tsx` 中為 `activities` 頁面新增 `d` 鍵快捷鍵。
3. [ ] 驗證變更。

**待解問題**

- 無。
