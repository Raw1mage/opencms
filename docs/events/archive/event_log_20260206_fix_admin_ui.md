# Event: 2026-02-06 Fix Admin UI Redundancy and Version Consistency

## 需求

- 修復 TUI Admin Panel 中「新增帳號」功能點擊後在底部出現冗餘輸入框的問題。
- 解決 `bun run build` 與 `bun run dev` 版本號不一致的混淆。

## 變更紀錄

### UI 優化

- 修改 `src/cli/cmd/tui/component/dialog-admin.tsx`：
  - 將 `DialogGoogleApiAdd`、`DialogApiKeyAdd` 與 `DialogAccountEdit` 的 `textarea` 移至項目的 `For` 迴圈內。
  - 在編輯模式下，輸入框將直接顯示在 Label 右側，取代原本的數值文字。
  - 將 `textarea` 高度從 3 改為 1，以符合單行輸入的視覺預期。

### 版本一致性

- 修改 `packages/script/src/index.ts`：
  - 在開發環境下增加 `(dev)` 標記。
  - 優化版本獲取邏輯，減少因 git 分支或 npm 狀態導致的劇烈變動。

### /connect 機制修復

- 修改 `src/cli/cmd/tui/component/dialog-provider.tsx`：
  - `ApiMethod` 組件中 `description` prop 傳遞 JSX 元素給 `DialogPrompt`
  - 但 `dialog-prompt.tsx:119` 期望 `description` 是函數並調用 `props.description?.()`
  - 修復：將 JSX 元素包裝成函數 `() => (<box>...</box>)`
  - 錯誤訊息：`props.description is not a function. (In 'props.description?.()', 'props.description' is an instance of BoxRenderable)`

## 驗證結果

- [x] 進入 TUI Admin Panel -> Add Account -> Google-API。
- [x] 點擊 "Account name"，輸入框應出現在右側。
- [x] 執行 `bun run dev`，確認版本號標示。
- [ ] 執行 `/connect` 選擇 opencode，確認不再 crash。
