## Requirements

- 補齊 web `SettingsAccounts` 畫面在 `setActive` flow 上的 providerKey canonical request-body 對齊。
- 保持 non-breaking：沿用 legacy `family`，但在同一請求中顯式帶入 canonical `providerKey`。

## Scope

### In

- `packages/app/src/components/settings-accounts.tsx`
- event ledger / validation

### Out

- route shape 變更
- schema / storage migration
- 移除 legacy `family` 欄位

## Task List

- [x] 檢查 `SettingsAccounts` 的 `setActive` request payload
- [x] 補入 `providerKey` 與 legacy `family` 並行傳遞
- [x] 執行 scoped 驗證
- [x] 記錄 event 與 architecture sync 結論

## Baseline

- provider-key migration 已在 server/contract 層建立 canonical `providerKey` compatibility surface。
- `SettingsAccounts` 的 active-account 切換仍只送出 legacy `family` 欄位，與目前 canonical request-body 方向不完全一致。

## Changes

- `packages/app/src/components/settings-accounts.tsx`
  - `account.setActive(...)` 由 `{ family: providerKey, accountId }`
  - 改為 `{ providerKey, family: providerKey, accountId }`

## Decisions

1. 這是 additive non-breaking 對齊：保留 legacy `family`，同時顯式送出 canonical `providerKey`。
2. 不修改 route shape；由既有 compatibility contract 同時接受兩者。

## Validation

- `bun test packages/app/src/components/settings-accounts.tsx` ✅
- Architecture Sync: Verified (No doc changes)

## Next

- 若其他 first-party consumers 仍有只送 legacy `family` 的 account action payload，可用同樣模式補齊 providerKey request-body。
