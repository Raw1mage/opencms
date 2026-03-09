# Event: session workflow chip style

Date: 2026-03-09
Status: Completed

## 需求

- 將 session header 的 workflow / arbitration chips 從 bubble 樣式改為方形圓角框。
- 視覺方向：底色高亮、文字低光，降低膨脹感。
- 後續依使用者回饋，標題列不再顯示 `Running` / `Waiting` 等 workflow chips，只保留異動數字 badge。
- 異動數字 badge 必須在 session 載入時即顯示，不可依賴先打開「檔案異動」面板才出現。

## 範圍 (IN / OUT)

### IN

- `packages/app/src/pages/session/message-timeline.tsx`

### OUT

- 不調整 workflow state 邏輯

## 任務清單

- [x] 盤點 chip 渲染位置
- [x] 將 bubble pill 改為 rounded-rect chip
- [x] 降低文字亮度並提升底色存在感
- [x] 自標題列移除 `Running` / `Waiting` chips
- [x] 將異動數字 badge 改為白底黑字的方形圓角泡泡
- [x] 讓 dirty diff 在 session 載入時即主動同步
- [x] 確認 `docs/ARCHITECTURE.md` 是否需要同步

## Debug Checkpoints

### Baseline

- 目前 workflow chips 採 `rounded-full` bubble 風格，視覺上較像 badge/pill。
- 使用者後續明確表示 `Running` / `Waiting` 在標題列意義不大，只要保留異動數字即可。
- 使用者觀察到 dirty count 目前要等打開「檔案異動」面板後才會出現，代表 diff 資料取得時機過晚。

### Execution

- 初版將 workflow 與 arbitration chips 的共用 class 從 `rounded-full` 改為 `rounded-md`，並降低文字亮度。
- 最終依使用者需求收斂：直接自標題列拿掉 workflow / arbitration chips，避免 `Running` / `Waiting` 佔位與分散注意力。
- 同時將 dirty-count badge 改為白底、黑字、`rounded-md` 的高亮方形圓角泡泡。
- 進一步修正兩個殘留問題：
  - 為避免 theme token 或 utility 解析落差，badge 顏色改成明確的 `#ffffff / #000000`。
  - `session.tsx` 新增 session-level diff preload，讓 `sync.session.diff(id)` 在 session 載入時就觸發，不再只綁定於 changes/review panel 開啟條件。

### Validation

- 本輪為局部樣式與資料預載調整，未執行 runtime 重啟。
- Architecture Sync: Verified (No doc changes)
  - 依據：僅調整 session header badge 呈現與 diff 預載時機，未改變架構邊界、資料流或模組責任。
