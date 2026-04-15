# Event: No-account provider UI adaptation

## 需求

- 讓 `ollama` 這類無 API key / 無 account 設定步驟的 provider，能在 model 管理員中直接使用。
- UI 文案不要出現 error-like `undefined`，改用明確語意如 `FreeToUse`。

## 範圍

### IN

- model 管理員的 account 欄位、selection flow、提交顯示

### OUT

- 不改 server account/auth contract
- 不新增 synthetic account

## 任務清單

- [x] 盤點 account-required 假設
- [x] 設計 no-account provider UI 適配
- [x] 使用者確認 plan 後實作

## Debug Checkpoints

### Implementation

- `packages/app/src/components/dialog-select-model.tsx`
  - 對沒有 account rows、但仍有可選 models 的 provider，account 欄位與 mobile summary 顯示 `FreeToUse`。
  - submit/toast 顯示改用 `FreeToUse`，但 runtime 仍維持 `accountID` 可省略。
  - `Add` / `Manage` account 操作對 no-account provider 會停用，避免誤導使用者去找不存在的帳號設定。
- `packages/app/src/components/model-selector-state.ts`
  - 抽出 `FREE_TO_USE_ACCOUNT_LABEL` 與對應 helper，讓 no-account 顯示邏輯集中。
- `packages/app/src/components/model-selector-state.test.ts`
  - 補上 `FreeToUse` 與 account-based fallback regression tests。

### Validation

- `bun test /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.test.ts` ✅
- `bun x eslint /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx` ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本次變更僅調整既有前端 presentation/state derivation，不改動 backend contract、模組邊界或 runtime state authority。
