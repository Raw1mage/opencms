# No-account provider UI adaptation plan

## Goal

讓 `ollama` 這類「可直接使用、沒有 account 設定步驟」的 provider，能無縫適應既有 model 管理員三欄介面，而不破壞既有 account-based providers。

## Problem

- runtime / session model contract 已允許 `accountID` 為空。
- 但 `packages/app/src/components/dialog-select-model.tsx` 仍把 account column 視為半必經流程：
  - 中間欄沒有 account 時只顯示 `No account data`
  - draft / submit / unavailable hint / mobile summary 仍優先圍繞 `selectedAccountId()`
- 對 `ollama` 類 provider 來說，這會讓 UI 看起來像「少一塊設定」而不是「本來就不需要帳號」。

## Scope

### IN

- `packages/app/src/components/dialog-select-model.tsx`
- 必要時補 `packages/app/src/components/model-selector-state.test.ts`
- 必要時補前端 component tests（若 repo 既有最小測試面可用）

### OUT

- 不改後端 account/auth/provider registry contract
- 不新增 fake account / synthetic fallback account
- 不改 TUI admin account model

## Design

### UX rule

- 若 selected provider 有 account rows：維持現狀。
- 若 selected provider 沒有 account rows，且該 provider 有可選 models：
  - account column 改為顯式 `FreeToUse`（而不是 error-like `undefined` / `--`）
  - selection / submit 路徑允許 runtime `accountID` 為空，但 UI 文案不直接暴露 `undefined`
  - model unavailable / summary 顯示改用 `FreeToUse`，不再把 `--` 當成缺漏錯誤語意

### Implementation sketch

1. 在 `dialog-select-model.tsx` 建立 `providerRequiresAccount` / `hasAccountsForSelectedProvider` 之類的前端 derived state。
2. account 欄位 UI 對 no-account provider 顯示 `FreeToUse`，而不是 `No account data`。
3. `draftSelection` / `submitSelection` / model unavailable hint 改為：
   - 有 account 時沿用現在邏輯
   - 無 account 時 runtime 明確傳空 account，不做 account fallback
4. 檢查 mobile summary / apply toast / dirty detection，避免顯示誤導性的 `--` 或 `undefined`。
5. 補 regression test，確保 no-account provider 不會被 UI 流程阻斷。

## Risks

- account-based providers 的 current selection / dirty detection 回歸
- unavailable hint 若仍以空 account 誤判，可能錯誤顯示 blocked

## Validation

- 相關前端測試
- 最小手動驗證路徑：選 `ollama` → 不需 account 仍可直接選 model / submit
