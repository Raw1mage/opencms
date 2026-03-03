# Event: TUI OpenAI Intensity Toggle

Date: 2026-03-03
Status: Done

## 1. 需求

- 在 TUI 中恢復 OpenAI 強度（intensity / variant）切換能力。
- OpenAI 至少支援四種等級：`low` / `medium` / `high` / `extra`。
- 預設強度為 `medium`。
- 切換方式使用既有 picker UX（點擊 footer variant 後開啟選單）。

## 2. 範圍 (IN/OUT)

### IN

- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` footer 變體顯示與點擊行為。
- OpenAI 變體顯示策略（含 `extra/xhigh` 相容）。

### OUT

- 非 OpenAI provider 的 variant UX 重構。
- 後端 provider 能力模型定義調整。
- Admin 面板強度切換流程修改。

## 3. 任務清單

- [x] 盤點目前 TUI variant 顯示與 set 流程。
- [x] 實作 OpenAI variant 切換並統一沿用 picker UX。
- [x] 實作 OpenAI 預設 `medium` 顯示邏輯。
- [x] 抽出共享 helper（variant options / interaction policy / effective value / rotation）。
- [x] 執行型別/編譯驗證。
- [x] 回填 Validation checkpoint 並更新狀態。

## 4. Debug Checkpoints

### Baseline（修改前）

- 症狀：TUI footer 的強度顯示依賴 `local.model.variant.current()`，當使用者未顯式設定 variant 時不顯示切換控制。
- 影響：OpenAI 實際上落在預設 medium，但使用者無法在 TUI 直接切換 low/medium/high/extra。
- 重現：進入 TUI Session，選擇 OpenAI 模型，footer 無可見的 intensity 切換入口。

### Execution（修正中）

- 調整 `visibleVariants()` 的 OpenAI 順序優先為 `low/medium/high/extra/xhigh`。
- 新增 `effectiveVariantValue()`：OpenAI 在未顯式設定時視為 `medium`。
- `handleVariantClick()` 統一走既有 `DialogSelect` picker，不做 provider 特殊 UX 分支。
- 調整顯示條件 `showVariant()`：OpenAI 即使未設定 current variant 也顯示切換 UI。
- 新增共享 helper：`packages/opencode/src/cli/cmd/tui/util/model-variant.ts`。
  - `buildVariantOptions()`：provider/model 可用變體清單正規化。
  - `shouldShowVariantControl()`：是否顯示切換入口。
  - `getEffectiveVariantValue()`：有效顯示值（含 OpenAI medium fallback）。

### Validation（修正後）

- `bun run typecheck`：失敗（非本次變更造成）。
  - 失敗點：`@opencode-ai/desktop#typecheck`。
  - 結論：屬 monorepo 其他 package 的既有問題，與本次 TUI prompt 變更無直接關聯。
- `bun turbo typecheck --filter=opencode`：通過。
  - 驗證本次修改所在 package（`opencode`）型別檢查正常。
