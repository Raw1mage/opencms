# Event: TUI Footer Provider Label Fix

## 需求

- 修復 TUI 對話框 footer 中 provider 名稱被 account email 取代的問題。
- 保留 footer 的 account 欄顯示 active account label，但 provider 欄必須回到 provider family / provider name。

## 範圍

IN:

- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/local.tsx`
- `/home/pkcs12/projects/opencode/docs/events/event_20260306_tui_footer_provider_label_fix.md`

OUT:

- 不修改 provider runtime assembly 的 account display name 策略
- 不修改 web model manager
- 不修改 account storage/schema

## 任務清單

- [x] 追查 footer provider label 資料來源
- [x] 確認 account-scoped provider name 被 account display name 覆蓋的資料流
- [x] 在 TUI local model label 層做最小修補
- [x] 執行 targeted 驗證並補齊 Validation 紀錄

## Debug Checkpoints

### Baseline

- `Prompt` footer 使用 `local.model.parsed().provider` 顯示 provider 名稱。
- `local.model.parsed()` 直接讀取 `sync.data.provider.find((x) => x.id === value.providerId)?.name`。
- account-scoped provider entry 的 `name` 在 provider graph 內被設定為 `Account.getDisplayName(...)`，因此 OpenAI 這類 OAuth 帳號可能顯示 email。
- 結果造成 footer 內 provider 欄與 account 欄都顯示同一個 account email，例如 `pincyluo@gmail.com`。

### Execution

- 在 `local.tsx` 將 provider label 解析改為：
  - 優先由 `Account.parseProvider(providerId)` 取得 canonical family
  - 再優先顯示 family provider entry 的 `name`
  - 若 family entry 不存在，再 fallback 到當前 provider entry / raw id
- 同步調整 `formatModelAnnouncement()`，避免模型切換 toast 也出現同樣 provider/account 混淆。

### Validation

- `bun x tsc -p /home/pkcs12/projects/opencode/packages/opencode/tsconfig.json --noEmit`
  - 通過
- 程式碼層驗證：
  - `local.model.parsed().provider` 已優先以 `Account.parseProvider(providerId)` 回推 canonical family label
  - `formatModelAnnouncement()` 已同步改用 family provider label，避免 toast 與 footer 再次分裂
- 預期修正結果：
  - footer provider 欄恢復顯示 provider family / provider name（例如 `OpenAI`）
  - footer account 欄維持顯示 active account label（例如 `pincyluo@gmail.com`）
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅修正 TUI footer label 解析層，未改動 provider graph、API contract 或架構邊界
