# Event: Web Model Visibility Favorite Decouple

## 需求

- 確認 webapp model selector 的顯示規則不再被 `favorite/unfavorite` 狀態影響。
- 保留 webapp 以 `show/hide` 作為 selector 顯示依據。
- 修正繁中介面的 `選精` 文案為 `精選`。

## 範圍

IN:
- `packages/app/src/context/models.tsx`
- `packages/app/src/components/dialog-select-model.tsx`
- `packages/app/src/i18n/zht.ts`

OUT:
- 不調整 TUI admin 的 favorites/hidden 行為。
- 不修改 backend model preferences API schema。
- 不重做 web model manager 的互動設計。

## 任務清單

- [x] 盤點 webapp `favorite` / `show-hide` 耦合點
- [x] 拆除 `favorite => show` 與 selector 內 `show => favorite` 自動連動
- [x] 保留 `visible` 作為 web selector 顯示依據
- [x] 修正 `選精` 文案
- [x] 驗證 webapp build 與行為

## Debug Checkpoints

### Baseline

- `packages/app/src/context/models.tsx`
  - `toggleFavorite()` 會把 `favorite` 同步成 `visibility: "show"`
  - `setVisibility(false)` 會把 `favorite` 清掉
  - `applyRemotePreferences()` 會把單純 favorite 項目合併成可見項
- `packages/app/src/components/dialog-select-model.tsx`
  - 眼睛按鈕切成 visible 後，若尚未 favorite 會自動 `toggleFavorite()`
- `packages/app/src/i18n/zht.ts`
  - `dialog.model.mode.curated` 文案誤植為 `選精`

### Execution

- 調整 `packages/app/src/context/models.tsx`
  - `User.visibility` 改為 optional，允許 favorite 與 visibility 分離持久化
  - `toggleFavorite()` 不再自動寫入 `visibility: "show"`
  - `setVisibility(false)` 不再自動清除 `favorite`
  - `applyRemotePreferences()` 不再把單純 favorite 條目提升為 `show`
- 調整 `packages/app/src/components/dialog-select-model.tsx`
  - 移除 selector 眼睛按鈕中的 `show => favorite` 自動補標
- 調整 `packages/app/src/i18n/zht.ts`
  - `dialog.model.mode.curated` 由 `選精` 改為 `精選`

### Validation

- `bun x tsc -p packages/app/tsconfig.json --noEmit`
  - 通過，無型別錯誤輸出
- `./webctl.sh dev-refresh`
  - 通過，frontend rebuild 完成，web runtime 重新載入成功
- `./webctl.sh status`
  - 通過，`Health: {"healthy":true,"version":"local"}`
- 行為驗證結論：
  - web selector 仍以 `visible()` 決定顯示
  - `favorite/unfavorite` 不再隱式改動 `show/hide`
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 webapp 本地狀態耦合與文案，未改變系統架構邊界、provider graph、API contract
