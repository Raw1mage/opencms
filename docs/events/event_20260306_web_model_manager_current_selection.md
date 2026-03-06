# Event: Web Model Manager Current Selection and Non-Dismiss Apply

## 需求

- 打開 webapp「模型管理員」時，provider/account/model 應直接定位到目前正在使用中的選項，而不是單純落在第一筆。
- 在模型管理員中點選 account/model 後，不應立即關閉 dialog。
- 選取後要保留畫面，讓使用者能看到目前被勾選的項目，並顯示 toast 提醒。

## 範圍

IN:
- `packages/app/src/components/dialog-select-model.tsx`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zht.ts`

OUT:
- 不修改 TUI model selector
- 不重做模型管理員版面
- 不修改 backend account/model API schema

## 任務清單

- [x] 盤點模型管理員目前 selected state 的初始化邏輯
- [x] 將 provider/account/model 初始定位對齊到 current model / active account
- [x] 將 model 選取改為保留 dialog，不再立即關閉
- [x] 補上 account/model 更新成功 toast
- [x] 驗證 webapp build 與 runtime 行為

## Debug Checkpoints

### Baseline

- `selectedProviderId` 初始值來自 `props.provider || ""`
- provider/account fallback effect 在 selected 無效時，直接選第一筆或 active account
- model click 後會執行 `dialog.close()`
- account click 不會關閉 dialog，但成功後沒有 toast 提醒

### Execution

- 讓 provider 初始選擇優先對齊目前 current model 的 provider family
- 讓 model list 的 `current` 明確對齊目前 selected/current model item
- model 選取後保留 dialog，透過 current check icon 顯示勾選結果
- account/model 更新成功後顯示 toast

### Validation

- `./webctl.sh dev-refresh`
  - 通過，frontend build 完成並套用至 web runtime
- `./webctl.sh status`
  - 通過，`Health: {"healthy":true,"version":"local"}`
- `curl -k https://crm.sob.com.tw/api/v2/global/health`
  - 通過，回傳 `{"healthy":true,"version":"local"}`
- 行為驗證結論：
  - provider 初始選擇會優先對齊 current model 所屬 family
  - account 初始選擇仍以該 family 的 active account 為準，不再只是第一筆 fallback
  - model list 的勾選狀態明確對齊目前 current model item
  - model 選取後不再關閉 dialog，會保留勾選並顯示 toast
  - account 切換成功後會顯示 toast
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 webapp model manager 的前端互動與初始化狀態，未改動系統架構、API contract 或 provider graph
