# Event: Provider List Shows llmgateway RCA

**Date**: 2026-03-27

## Requirement

使用者回報 provider 列表出現 `llmgateway`，判定為 bug，要求做 RCA。

## Scope

### IN
- 追查 `llmgateway` 如何進入 provider list
- 釐清 provider list 的資料來源、正規化/過濾邊界與使用者可見 surface
- 形成有檔案/行號證據的 root cause

### OUT
- 本輪先不修 bug
- 不做 UI 重構
- 不新增 fallback 或暫時性隱藏邏輯

## Task List

1. 讀取 architecture 與既有 event，建立 RCA baseline
2. 追查 provider list 資料流與 `llmgateway` 注入點
3. 整理 root cause、影響面與後續修復方向

## Debug Checkpoints

### Baseline
- 使用者觀察到 provider 列表出現 `llmgateway`
- 依產品語意，`llmgateway` 不應是使用者可見 provider 項目

### Instrumentation Plan
- 檢查 provider registry / account/provider API / app provider list UI 的資料流
- 搜尋 repo 中所有 `llmgateway` 出現位置，確認是否為 legacy alias、canonical provider、測試 fixture 或 fallback 遺留
- 對照 UI 消費點，確認是否直接渲染後端列舉結果而無額外過濾

### Execution
- 全 repo 搜尋 `llmgateway`，僅命中本次 event 檔，未命中 runtime / app / template 原始碼；證明它不是 repo 內建 hardcode provider。
- 檢查 `/provider` route，確認 provider universe 來自三路 union：`ModelsDev.get()`、`Provider.list()`、`Account.listAll()`，再經 `buildCanonicalProviderRows()` 組成回應：`packages/opencode/src/server/routes/provider.ts:48-68`。
- 檢查 canonical normalization，確認 `normalizeCanonicalProviderKey()` 的 blocklist 只有 `google`；未知 provider key 不會被排除：`packages/opencode/src/provider/canonical-family-source.ts:38-49`。
- 檢查 runtime provider database，確認 config provider 會直接以 `providerId` 併入 database，來源標為 `config`：`packages/opencode/src/provider/provider.ts:1022-1103`。
- 檢查前端 bootstrap 與 hook，確認 provider list 只去除 deprecated models 與 legacy `google`，沒有 product-level provider allowlist/filter：`packages/app/src/context/global-sync/utils.ts:5-12`、`packages/app/src/hooks/use-providers.ts:29-35`。

### Root Cause
- `llmgateway` 不是 repo 內建 provider，而是**外部資料源帶入的 provider key**。目前靜態證據顯示兩條可行注入路徑：
  1. 使用者/環境 config 中的 custom provider（`config.provider.<id>`）經 `Provider.list()` 併入 runtime provider database；
  2. `ModelsDev.get()` 載入的外部 models 資料（cache / snapshot / remote source）含有 `llmgateway`。
- `/provider` route 目前採「union all observed provider ids」策略，只要 provider key 出現在 `ModelsDev.get()`、`Provider.list()` 或 `Account.listAll()` 任一路徑，就會進入 canonical provider universe：`packages/opencode/src/server/routes/provider.ts:48-68`。
- canonical normalization 只排除 `google`，不驗證 provider 是否屬於產品允許顯示的 canonical 集，因此 `llmgateway` 這類外部 key 會被保留下來：`packages/opencode/src/provider/canonical-family-source.ts:38-49`。
- 前端 `normalizeProviderList()` 與 `useProviders()` 幾乎直接渲染 `/provider` 回應，只額外去掉 deprecated models 與 `google`，因此後端漏出的 `llmgateway` 會直接出現在 UI：`packages/app/src/context/global-sync/utils.ts:5-12`、`packages/app/src/hooks/use-providers.ts:29-35`。
- **真正 root cause**：provider list 的 authority boundary 定義錯誤。系統把「外部觀測到的 provider key」直接當成「產品可見 canonical provider」，缺少 product-level allowlist / exclusion gate，導致外部資料污染 UI。

## Validation
- `grep "llmgateway" /repo`
  - 僅命中 `docs/events/event_20260327_provider_list_llmgateway_rca.md`，未命中 runtime/app code；支持「非 hardcode、由外部資料注入」結論。
- 代碼證據鏈：
  - provider universe 組合：`packages/opencode/src/server/routes/provider.ts:48-68`
  - canonical normalization 無 llmgateway 過濾：`packages/opencode/src/provider/canonical-family-source.ts:38-49`
  - config provider 注入 runtime database：`packages/opencode/src/provider/provider.ts:1022-1103`
  - 前端直接消費 provider list：`packages/app/src/context/global-sync/utils.ts:5-12`、`packages/app/src/hooks/use-providers.ts:29-35`
- 尚未在本輪靜態分析中定點證明 `llmgateway` 來自 config 或 models.dev 的哪一個實際 runtime source；若要 final confirmation，需檢查實際使用者 config、models cache 或 `/provider` live payload。

## Follow-up Plan
- 已建立 active plan package：`plans/20260327_provider-llmgateway-bug/`
- 規劃方向：新增 repo-owned canonical provider registry 作為 provider SSOT，固定目前 cms 正式支援清單，並讓 `models.dev` 只負責 registry 內 provider 的模型/metadata 更新值。
- 初版計畫中的正式支援 provider list：`openai`、`claude-cli`、`google-api`、`gemini-cli`、`github-copilot`、`gmicloud`、`openrouter`、`vercel`、`gitlab`、`opencode`。

## Architecture Sync
Architecture Sync: Verified (No doc changes yet; follow-up implementation planned)

Basis:
- 本次 RCA 階段先確認 authority boundary 問題，尚未實作新的 registry module 或改動資料流。
- 後續若依 plan 導入 canonical provider registry，收尾時需更新 `specs/architecture.md`，把 provider universe authority 改寫為 registry-first。