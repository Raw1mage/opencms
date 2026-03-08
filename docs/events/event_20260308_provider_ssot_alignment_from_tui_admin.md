# Event: Provider SSOT Alignment From TUI Admin

Date: 2026-03-08
Status: In Progress

## 1. 需求

- 從 TUI admin panel 開始整治 provider/account/model 的單一事實來源問題。
- 後續要同時對齊 TUI 與 webapp。
- 硬性要求：`google` 不得再回流成 family，canonical split 必須固定為 `gemini-cli` 與 `google-api`。
- 要檢討並修正 provider list 混入 account-scoped provider、legacy alias、非 canonical family 的問題。

## 2. 範圍

### IN

- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- `packages/opencode/src/account/index.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/server/routes/provider.ts`
- 後續對應 webapp provider/model selector consuming path

### OUT

- 本階段先完成 TUI admin panel data-flow RCA 與 canonical refactor 切入點，不直接做全 repo 大掃除。

## 3. 任務清單

- [x] 盤點 TUI admin panel provider/account/model 資料組裝路徑
- [x] 確認目前非 SSOT 的拼裝點與特例分支
- [x] 定義 canonical provider family runtime view
- [x] 從 TUI admin panel 改為只吃 canonical family source
- [ ] 再把同一份 canonical source 對接到 webapp
- [ ] 更新 architecture 文件與驗證紀錄

## 4. Debug Checkpoints

### Baseline

- provider list 混入非 family 名稱（如帳號名）
- `Anthropic` / `anthropic` / `claude-cli` canonical 邊界混亂
- `google` 拆分規則未被系統性鎖死
- `antigravity` 仍在多處被主動注入

### Execution

- `dialog-admin.tsx` root/provider list 現在用 `coreAll()`、`groupedProviders()`、`modelsDevData()`、`effectiveDisabledProviders()` 多來源 union 組 family universe。
- `dialog-admin.tsx` account/model select 仍依 family 特例分支（尤其 `antigravity`、`anthropic`、`github-copilot`）手動決定 selected provider id。
- `provider.ts` runtime provider state 目前同時承載 family provider 與 account-scoped provider；這對執行時有用，但不能直接當 UI family list source。
- `server/routes/provider.ts` 又把 `ModelsDev.get()` 與 `Provider.list()` 混合回傳，導致 legacy / account-scoped provider 洩漏到前端。
- 新增 `packages/opencode/src/provider/canonical-family-source.ts`，明確把 UI provider list source 壓成 family-level runtime view：
  - family normalization 走 `Account.parseProvider()`
  - legacy `google` 直接阻擋，不允許回流成 family
  - TUI root list 先排除 `antigravity`
  - account-scoped provider id 只允許留在 runtime/account/model path，不再直接參與 TUI family universe 組裝
- `dialog-admin.tsx` root/provider list 已改為只吃 `canonicalFamilies()`，不再在現場用 `coreAll + groupedProviders + modelsDevData + disabledProviders` 手工 union family universe。
- `dialog-admin.tsx` 新增 family → runtime provider 映射 helper 消費路徑：
  - `selectedRuntimeProvider()` 會依 canonical family、active account、sync provider inventory 決定 model_select 實際使用的 runtime provider
  - `handleSetActive()` 不再保留 `anthropic` / `github-copilot` 專屬 hardcode 分支，改為走 `resolveCanonicalRuntimeProviderId()`
  - `model_select` 與 title 顯示也改成吃同一份 resolved runtime provider，而非各自再做 direct/byFamily/byPrefix 搜尋
- `server/routes/provider.ts` 的 `/provider` 已改為吃同一份 canonical family source：
  - 先以 `buildCanonicalProviderFamilyRows()` 建 family universe
  - `all` 回傳改為 family-level provider rows，而非 account-scoped provider ids
  - `openai` family 保持 canonical 原樣，不變更 family key / account semantics
  - `google` 與 `antigravity` 目前在 canonical family list 層直接排除，不再讓 legacy/raw provider id 洩漏到 web provider list
  - `accounts.json` 未改 schema、未改寫入語義，只改 provider view assembly
- web consumers 開始對齊 canonical family：
  - `packages/app/src/hooks/use-providers.ts` popular list 改為 `claude-cli`，並排除 `antigravity`
  - `packages/app/src/context/models.tsx` 與 `packages/app/src/components/model-selector-state.ts` 移除前端 `google -> google-api` 與 `anthropic` canonical 保留，改為 `anthropic -> claude-cli` alias、排除 `google` / `antigravity`
  - web model/favorite visibility key 現在以 canonical family（含 `openai` 原樣）為準，不再依賴 legacy family 名稱
  - 順手修正 `buildAccountRows()` 排序，使 active account 優先顯示，與既有測試意圖一致
- UI 顯示層持續清理 legacy family 參照：
  - web provider selector/settings/unpaid dialog 的 `anthropic` 判斷改為 `claude-cli`
  - session header 移除 `antigravity` open-with 選項
  - prompt input / model tooltip / TUI dialog model/provider 的 provider label 與排序不再把 `antigravity` / `anthropic` 當 canonical UI family
  - antigravity 仍存在於 runtime/TUI quota/account 特例路徑，但已不再作為一般 UI canonical provider 顯示
- 另建立 antigravity runtime 拔除專屬 event：`docs/events/event_20260308_antigravity_runtime_removal_plan.md`
  - 先把 route / TUI prompt-admin / provider builder 的 special-case 拔除順序拆開，避免一次砍爆。

### Validation

- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` ✅
- `bunx eslint packages/opencode/src/provider/canonical-family-source.ts packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` ✅
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json`（含 `/provider` route 更新後） ✅
- `bunx eslint packages/opencode/src/server/routes/provider.ts packages/opencode/src/provider/canonical-family-source.ts` ✅
- `bunx tsc --noEmit -p packages/app/tsconfig.json` ✅
- `bunx eslint packages/app/src/hooks/use-providers.ts packages/app/src/context/models.tsx packages/app/src/components/model-selector-state.ts packages/app/src/components/model-selector-state.test.ts` ✅
- `bun test packages/app/src/components/model-selector-state.test.ts` ✅
- `bunx tsc --noEmit -p packages/app/tsconfig.json && bunx tsc --noEmit -p packages/opencode/tsconfig.json`（UI cleanup 後） ✅
- `bunx eslint packages/app/src/components/dialog-select-provider.tsx packages/app/src/components/dialog-connect-provider.tsx packages/app/src/components/dialog-select-model-unpaid.tsx packages/app/src/components/settings-providers.tsx packages/app/src/components/prompt-input.tsx packages/app/src/components/model-tooltip.tsx packages/app/src/components/session/session-header.tsx packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` ✅
- Architecture Sync: Updated
  - 比對依據：TUI `/admin` provider root list 已新增 canonical family runtime source，需在 architecture 文件註明 family-level UI source 與 runtime account-scoped provider 的分層。
