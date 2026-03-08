# Event: Provider List RCA

Date: 2026-03-08
Status: In Progress

## 1. 需求

- 分析 provider list 為何混入非 provider family 項目（如 `ncucode`）。
- 分析 `Anthropic` / `anthropic` 雙胞問題。
- 分析 `antigravity` 為何仍持續出現在 repo / UI 中。

## 2. 範圍

### IN

- `packages/app/src/components/model-selector-state.ts`
- `packages/app/src/hooks/use-providers.ts`
- `packages/app/src/components/dialog-select-provider.tsx`
- `packages/opencode/src/server/routes/provider.ts`
- `packages/opencode/src/provider/provider.ts`

### OUT

- 本 event 僅做 RCA，不直接實作修正。

## 3. Debug Checkpoints

### Baseline

- 使用者回報 provider list 出現不是 provider family 的項目（例：`ncucode`）。
- 使用者回報 `Anthropic` / `anthropic` 雙胞。
- 使用者要求 `antigravity` 永久移出 repo，不要再出現。

### Execution

- RCA 1：`packages/opencode/src/server/routes/provider.ts` 的 `/provider` 回傳 `all` 時，除了 `ModelsDev.get()` 的 provider，也會把 `Provider.list()` 裡所有 `connected` provider 直接補進去。
- RCA 2：`Provider.list()` 在 `packages/opencode/src/provider/provider.ts` 內，會把 account-based provider（例如 `google-api-api-ncucode` / `gemini-cli-api-ncucode`）也註冊成獨立 provider entry。
- RCA 3：`packages/app/src/components/dialog-select-provider.tsx` 使用 `useProviders().all()` 的 raw provider list，未做 family normalization / dedupe，所以 account-scoped provider 會直接洩漏到 provider connect list。
- RCA 4：`packages/app/src/components/model-selector-state.ts` 雖有 family normalization，但 `buildProviderRows()` 在找不到 base family provider 時，會拿 family 內第一個 account-based provider 的 `name` 當顯示名；因此 family row 可能顯示成 `ncucode` 之類帳號名稱，而不是 `Google-API` / `Gemini CLI`。
- RCA 5：`packages/opencode/src/provider/provider.ts` 雖已在 connected provider state 中 `delete database["anthropic"]`，但 `packages/opencode/src/server/routes/provider.ts` 仍直接使用未清洗的 `ModelsDev.get()`，所以 legacy `anthropic` 仍可從 `/provider` API 回到前端。
- RCA 6：前端仍把 `anthropic` 視為 canonical family（如 `model-selector-state.ts`, `context/models.ts`, `hooks/use-providers.ts`, `dialog-select-provider.tsx`），但 backend canonical replacement 已偏向 `claude-cli`。這種前後端 canonical family 不一致，會導致 Anthropic 類 provider 在不同 UI 路徑被重複呈現或命名不一致。
- RCA 7：`antigravity` 並非單點殘留，而是 repo 內多處主動注入：
  - `packages/opencode/src/provider/provider.ts` 明確建立 `database["antigravity"]`
  - 同檔還會載入 antigravity legacy accounts 並 merge provider
  - `packages/opencode/src/server/routes/account.ts` 有 antigravity-specific status / toggle route
  - app / TUI 仍有 `antigravity` family label、排序、session header、quota、admin 邏輯

### Validation

- 透過靜態搜尋確認 `ncucode` 只出現在帳號資料 `config/data/accounts.json`，並非真正 provider family。✅
- 透過程式閱讀確認 `/provider` raw list 與 `Provider.list()` canonical list 的來源不一致。✅
- 透過程式閱讀確認 `antigravity` 仍是 backend provider builder 與 app/TUI UI 的一級公民。✅

## 4. 初步結論

- `ncucode` 問題本質上是 **account-scoped provider 洩漏 + family display name fallback 選錯來源**。
- `Anthropic` / `anthropic` 雙胞本質上是 **legacy `ModelsDev` anthropic 未從 `/provider` list 清掉 + 前端仍把 anthropic 當 canonical family**。
- `antigravity` 若要「永久移出」，不能只改 UI；必須同時移除 backend provider injection、account route 特例、以及 app/TUI 的 family registry 與顯示邏輯。
