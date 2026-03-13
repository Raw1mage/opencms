## Requirements

- 收斂 progress-circle 元件的顏色繼承方式，避免背景環與進度環綁死在固定 border token。
- 讓元件可跟隨父層文字/圖示色系變化。

## Scope

### In

- `packages/ui/src/components/progress-circle.css`
- event ledger / validation

### Out

- progress-circle API 變更
- 其他 UI 元件樣式重構

## Changes

- `packages/ui/src/components/progress-circle.css`
  - background stroke 改為 `currentColor` + `opacity: 0.5`
  - progress stroke 改為 `currentColor`

## Decisions

1. progress-circle 應繼承外層語意色，不應綁死到 border token。
2. background ring 以 opacity 區分層次，保留進度環主體辨識度。

## Validation

- 靜態檢查 CSS diff：僅更動 stroke color inheritance，未改 component API。✅
- Architecture Sync: Verified (No doc changes)

## Next

- 若後續需要更細的 semantic color slots，可另開 token/API 切片。
