# Grafcet Validation Fix — 2026-05-06

## 需求

- 修復 `specs/` 下 Grafcet JSON validation failure，讓除 `diagrams/` / `archive/` 以外的 spec 子資料夾都能重新產出 SVG。

## 範圍(IN)

- `specs/daemon/grafcet.json`
- `specs/grafcet-renderer-overhaul/grafcet.json`
- `specs/diagrams/*.svg`
- `specs/diagrams/grafcet-regeneration-report.json`

## 範圍(OUT)

- 不修改 drawmiat renderer 行為。
- 不修改 OpenCMS runtime code。

## Debug / Evidence Checkpoints

- Baseline: 13 份 `specs/*/grafcet.json` 中 `daemon` 因 `Condition` 數量與 `LinkOutputNumber` 不一致失敗，`grafcet-renderer-overhaul` 因 `StepType: final` 不在 validator enum 中失敗。
- Root Cause:
  - `daemon` 的 OR branch 欄位未把分支 target 顯式列出，且 failure path 匯入 steady step 後造成 layout warning。
  - `grafcet-renderer-overhaul` 使用非 validator 支援的 final step type。
- Fix:
  - `daemon` 補齊 divergence output targets，將 failure retry path 直接回到 initial step `0`，並將 steady step `13` 的 input 收斂為正常 health path。
  - `grafcet-renderer-overhaul` 將 final return step 改為 validator 支援的 `normal` step type。

## Validation

- 重跑 13 份 `specs/*/grafcet.json`（排除 `diagrams/` / `archive/` / `_archive/`）render。
- 結果：`13 total / 13 ok / 13 written / 0 warnings / 0 errors`。
- Report: `specs/diagrams/grafcet-regeneration-report.json`。
- Architecture Sync: Verified (No doc changes) — 本次只修正 spec Grafcet JSON validation 與輸出 SVG，不改 runtime architecture 或 renderer contract。
