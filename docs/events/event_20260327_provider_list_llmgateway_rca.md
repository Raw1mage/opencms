# Event: Provider List Shows llmgateway RCA

**Date**: 2026-03-27

## Requirement

使用者回報 provider 列表出現 `llmgateway`，判定為 bug，要求做 RCA，後續決定直接落地 provider SSOT 修復。

## Scope

### IN
- 追查 `llmgateway` 如何進入 provider list
- 釐清 provider list 的資料來源、正規化/過濾邊界與使用者可見 surface
- 形成有檔案/行號證據的 root cause
- 落地 provider SSOT 修復：建立正式支援 provider registry，改寫 backend/provider UI authority boundary

### OUT
- 不重寫整個 provider runtime builder
- 不移除 runtime custom provider 能力
- 不新增 fallback 或暫時性隱藏邏輯

## Task List

1. 讀取 architecture 與既有 event，建立 RCA baseline
2. 追查 provider list 資料流與 `llmgateway` 注入點
3. 整理 root cause、影響面與後續修復方向
4. 建立 repo-owned supported provider registry
5. 改寫 backend provider universe 為 registry-first
6. 對齊主要 UI provider consuming path 與 label authority
7. 執行驗證並同步 architecture 文件

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
- 檢查 `/provider` route，確認 provider universe 原先來自三路 union：`ModelsDev.get()`、`Provider.list()`、`Account.listAll()`，再經 `buildCanonicalProviderRows()` 組成回應：`packages/opencode/src/server/routes/provider.ts:48-68`。
- 檢查 canonical normalization，確認舊邏輯的 blocklist 只有 `google`；未知 provider key 不會被排除：`packages/opencode/src/provider/canonical-family-source.ts:38-49`。
- 檢查 runtime provider database，確認 config provider 會直接以 `providerId` 併入 database，來源標為 `config`：`packages/opencode/src/provider/provider.ts:1022-1103`。
- 建立 `packages/opencode/src/provider/supported-provider-registry.ts`，把 provider universe 收斂為 repo-owned supported provider registry。
- 改寫 `packages/opencode/src/provider/canonical-family-source.ts` 與 `packages/opencode/src/server/routes/provider.ts`，使 canonical rows 與 `/provider.connected` 都改為 registry-first。
- 新增 `packages/app/src/utils/provider-registry.ts`，並把 `packages/app/src/hooks/use-providers.ts`、`packages/app/src/components/prompt-input.tsx`、`packages/app/src/pages/task-list/task-detail.tsx` 對齊到 shared supported-provider helper。

### Root Cause
- `llmgateway` 不是 repo 內建 provider，而是**外部資料源帶入的 provider key**。目前靜態證據顯示兩條可行注入路徑：
  1. 使用者/環境 config 中的 custom provider（`config.provider.<id>`）經 `Provider.list()` 併入 runtime provider database；
  2. `ModelsDev.get()` 載入的外部 models 資料（cache / snapshot / remote source）含有 `llmgateway`。
- 舊 `/provider` route 採「union all observed provider ids」策略，只要 provider key 出現在 `ModelsDev.get()`、`Provider.list()` 或 `Account.listAll()` 任一路徑，就會進入 canonical provider universe。
- canonical normalization 只做 key 正規化，未實作 product-level allowlist，因此 `llmgateway` 這類外部 key 會被保留下來。
- 前端 provider consuming path 又幾乎直接渲染 `/provider` 回應，因此後端漏出的 unsupported provider 會直接出現在 UI。
- **真正 root cause**：provider list 的 authority boundary 定義錯誤。系統把「外部觀測到的 provider key」直接當成「產品可見 canonical provider」，缺少 repo-owned supported-provider SSOT。

## Changes
- `packages/opencode/src/provider/supported-provider-registry.ts`
  - 新增 repo-owned canonical supported provider registry，正式支援清單固定為：`openai`、`claude-cli`、`google-api`、`gemini-cli`、`github-copilot`、`gmicloud`、`openrouter`、`vercel`、`gitlab`、`opencode`
  - 提供 supported key / meta / label helpers
- `packages/opencode/src/provider/canonical-family-source.ts`
  - canonical provider rows 改為 registry-first，provider universe 由 supported provider registry 決定
  - accounts / connected / models.dev 只作為 overlay，不再擴張 universe
- `packages/opencode/src/server/routes/provider.ts`
  - `/provider` 的 `connected` 改為 canonical provider keys，而非 raw runtime provider ids
  - unsupported provider 不再透過 raw connected state 洩漏到 API list
- `packages/app/src/utils/provider-registry.ts`
  - 新增 app 端 shared supported provider label/key helper
- `packages/app/src/hooks/use-providers.ts`
  - `all()` 改為只保留正式支援集 provider
- `packages/app/src/components/prompt-input.tsx`
  - provider label 改走 shared helper
- `packages/app/src/pages/task-list/task-detail.tsx`
  - provider label 改走 shared helper

## Validation
- `bun x tsc --noEmit -p packages/app/tsconfig.json` ✅
- `bun x tsc --noEmit -p packages/opencode/tsconfig.json` ⚠️
  - 仍被 repo 既有錯誤阻擋，但本次修改檔案未出現在錯誤清單
  - 既有錯誤位置：
    - `packages/opencode/src/cli/cmd/tui/context/local.tsx`
    - `packages/opencode/src/mcp/apps/gauth.ts`
    - `packages/opencode/src/server/routes/mcp.ts`
    - `packages/opencode/src/session/prompt.ts`
    - `packages/opencode/src/tool/cron.ts`
- Runtime contract outcome
  - unsupported provider key（例如 `llmgateway`）即使存在於 config / runtime / models.dev，也不再能自動進入 canonical provider list
  - provider universe 現在由 repo-owned supported provider registry 決定；`models.dev` 僅能 enrich 已支援 provider

## Architecture Sync
Architecture Sync: Updated

Basis:
- provider universe authority 已從 observed-provider union 改為 registry-first，屬於 architecture boundary 修正。
- 已更新 `specs/architecture.md`，補上 supported provider registry 與 `/provider` route 的新 authority contract。
