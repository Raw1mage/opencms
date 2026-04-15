# Event: Provider menu realtime config refresh

## 需求

- 修復 daemon UI / web UI 在重新開啟 provider 選單時仍顯示舊 config/provider 狀態的問題。
- 讓使用者每次打開 provider 選單時，都能看到當前 daemon 最新設定，而不必整頁 reload。
- 清掉 `packages/app` 既有 typecheck 與 unit test 紅燈，讓本次修復可在綠燈基線上驗證。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-provider.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sync.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/hooks/use-providers.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-manage-models.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/prompt-input/submit.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/context/layout.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/layout.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/file-tabs.tsx`
- `/home/pkcs12/projects/opencode/packages/ui/src/components/message-part.tsx`

### OUT

- 不修改 provider server route contract。
- 不引入新的 fallback 機制。
- 不重構整個 global-sync/child-store 架構。

## 任務清單

- [x] 釐清 provider menu 開啟時使用的 store 與 refresh 流程
- [x] 補上 menu-open 時的即時 refresh 路徑
- [x] 驗證目前 workspace child store 與 global provider/config 皆同步更新

## Debug Checkpoints

### Baseline

- `DialogSelectProvider` 開啟時讀取 `useProviders()`。
- 有 `dir` route 時，`useProviders()` 優先讀 child store 的 `projectStore.provider`。
- config/connect 更新後，重新打開選單不一定會觸發 global + child store refresh，因此 UI 會看到 stale provider/config。

### Root Cause

- `DialogSelectProvider` 重新開啟時只重讀既有 store，沒有主動 refresh。
- `useProviders()` 在有 `dir` route 時會優先讀 child store 的 `projectStore.provider`，因此即使 global store 更新，當前 workspace provider 清單仍可能停留在舊值。
- connect/config mutation 後雖然 runtime 可能已更新，但 provider 選單 reopen 沒有同步刷新 `config/provider/provider_auth/account_families` 與目前 directory child store，造成 daemon UI 顯示 stale config。

### Implementation

- `packages/app/src/context/global-sync.tsx`
  - 新增 `refreshProviderState(directory?)`，集中刷新 `config`、`provider`、`provider_auth`、`account_families`，並在有 directory 時再執行 `bootstrapInstance(directory)`。
- `packages/app/src/components/dialog-select-provider.tsx`
  - 在 dialog mount 時解析目前 `dir` route，主動呼叫 `globalSync.refreshProviderState(currentDirectory())`。
  - 讓每次 reopen provider menu 時都重新對齊 global 與 workspace provider/config 狀態。
- `packages/app/src/pages/session/helpers.test.ts`
  - 移除過時的 `Model auto` workflow chip 期待，與目前 `getSessionWorkflowChips()` 實作對齊。
- `packages/app/src/components/dialog-manage-models.tsx`
  - 將 `billingModeOptions` 改成可變陣列型別，符合 `Select` 的 `options` 參數要求。
- `packages/app/src/components/prompt-input/submit.ts`、`packages/app/src/pages/layout.tsx`
  - `worktree.create(...)` 改傳 `{ worktreeCreateInput: {} }`，對齊 SDK 新簽名。
- `packages/app/src/context/layout.tsx`
  - 抽出 `STATUS_SIDEBAR_ORDER_DEFAULT` / `StatusSidebarKey`，收斂 status sidebar order 的型別。
- `packages/app/src/pages/session/file-tabs.tsx`
  - `iframe` 屬性改用 `srcdoc`，符合 Solid DOM 型別。
- `packages/ui/src/components/message-part.tsx`
  - 將不存在的 `file-text` icon 改為現有 `folder` icon。

### Validation

- `bun run typecheck`（`/home/pkcs12/projects/opencode/packages/app`）✅
- `bun run test:unit`（`/home/pkcs12/projects/opencode/packages/app`）✅ 354 pass / 3 skip / 0 fail
- 目標驗證
  - provider 選單 mount 時會主動刷新 `config/provider/provider_auth/account_families`，並在 workspace 路由下同步刷新目前 directory child store。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次變更限於前端 refresh 路徑、測試期待同步與若干 app/ui 型別對齊，未改變長期模組邊界、server contract、全域資料流主幹或 runtime state machine。
