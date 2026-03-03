# Event log: 2026-03-03 Account Loading Performance Refactor Plan

## Context

Users have reported that the web application takes nearly one minute to load account and usage information. This delay significantly impacts the User Experience (UX) and prevents the application from feeling responsive.

## 0) Takeover Requirement (2026-03-03 Round B)

### Requirement

- google-api 與 antigravity 必須是「完全分離」provider。
- 系統不得再把 google-api 帳號導入 antigravity compatibility 路徑。
- 明確禁止任何「未經使用者同意」的 legacy fallback（尤其是 google-api → antigravity）。

### Scope

- **IN**
  - `plugin/antigravity/constants.ts` provider identity
  - `auth/index.ts` antigravity legacy account listing source
  - `provider/provider.ts` legacy loader 與 base provider fallback
  - `account/rotation3d.ts` antigravity quota probing gate
  - `server/routes/account.ts` account list antigravity status probing gate
- **OUT**
  - 完整移除 antigravity plugin 模組（本輪不做 destructive removal）
  - UI 文案/測試重寫（本輪先保 API 行為穩定）

### Task List

- [x] 找出 google-api 被誤導入 antigravity 的 runtime 路徑
- [x] 切斷 google-api -> antigravity fallback mapping
- [x] 加入 antigravity quota/status probing guard（僅在 antigravity 帳號存在時觸發）
- [ ] 跑 targeted typecheck/lint 驗證

## Structural Analysis Results

### 1. Thundering Herd in `Account.state()`

The current implementation of `Account.state()` lacks an in-flight locking mechanism. When the frontend performs a parallel bootstrap (15+ concurrent requests), each request that hits an account-related route triggers its own synchronous `load()` call. This leads to redundant disk I/O, regex migrations, and ID normalization passes.

### 2. Blocking Network Dependency in `ModelsDev`

`Account.load()` depends on `ModelsDev.get()`, which in turn performs a blocking `fetch` to `https://models.dev` if the local `models.json` is missing or slow. If the network is restricted or the server is slow, the entire account listing blocks until the timeout.

### 3. $O(N)$ Async Waterfall in `Provider.load()`

The `Provider.load()` sequence iterates through every configured provider and performs an `await Account.resolveFamily()`. This creates a sequential async chain where each link might hit the metadata registry, leading to cumulative delays.

### 4. Redundant Frontend Requests

The frontend bootstrap sequence (in `bootstrapGlobal` and `bootstrapDirectory`) sends multiple requests that independently hit the same slow backend paths (`/account`, `/rotation/status`, `/provider/list`).

## Proposed Refactor Plan

### Phase 1: Singleton Locking & SWR

- **Singleton Promise**: Implement an `_inflight` promise pattern in both `Account` and `ModelsDev` to ensure only one load operation happens concurrently.
- **Stale-While-Revalidate (SWR)**: Modify `checkAccountsQuota` and OpenAI quota logic to return cached results immediately and refresh in the background.

### Phase 2: Decoupling Metadata

- **Lazy Metadata**: Decouple the account ID normalization from the network fetch. Use a bundled snapshot as the primary source of truth for family resolution during listing.
- **Background Refresh**: Move the remote metadata fetch to a non-blocking background routine.

### Phase 3: Background Storage Refresher

- **File Watcher**: Implement a file watcher on `accounts.json` in the main process to update the in-memory singleton. This allows all API requests to read from cache without disk mtime checks.

### Phase 4: Frontend Batching

- **Bootstrap Consolidation**: Investigate consolidating the 15+ bootstrap requests into a single `/api/v2/bootstrap` payload or using a shared frontend cache for account families.

## Success Metrics

- **Initial Account Response**: Reduce from ~45s-60s to <100ms.
- **UI Ready Time**: Significant reduction in total bootstrap duration.
- **Redundancy**: 0 redundant disk loads for the same state version.

---

## Debug Checkpoints

### Baseline (Takeover)

- `git status` shows 13 modified files + 1 new event draft, scope spans frontend bootstrap, quota pipeline, session/storage listing, installer/deploy paths.
- Existing `build.log` indicates frontend build failure due to permission issue in `packages/app/dist` (`EACCES unlink ...woff2`), non-functional noise for this optimization round.
- Risk identified in current refactor draft:
  - `bootstrapGlobal` introduces an unused binding (`serverWorktree`) and obsolete param (`getGlobalProjects`).
  - Antigravity quota SWR path can return sparse result array (`filter(Boolean)`), potentially misaligning account index mapping.
  - OpenAI quota SWR first-read shape may omit subscription keys when cache is cold.

### Execution (Takeover Round A)

- Frontend bootstrap cleanup:
  - Removed unused `getGlobalProjects` from `bootstrapGlobal` interface and call site.
  - Removed unused `serverWorktree` binding from bootstrap parallelization path.
- Quota stability hardening:
  - OpenAI quota now guarantees stable first-read key shape (`null` fallback) while preserving SWR background refresh.
  - Antigravity quota now uses explicit in-flight promise dedupe and returns full ordered result array (no `filter(Boolean)` compaction).

### Validation (Round A)

- ✅ `bunx tsc -p packages/app/tsconfig.json --noEmit`
- ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
- ✅ `bunx eslint packages/app/src/context/global-sync.tsx packages/app/src/context/global-sync/bootstrap.ts packages/opencode/src/account/quota/openai.ts packages/opencode/src/plugin/antigravity/plugin/quota.ts packages/opencode/src/config/config.ts`
- ℹ️ `build.log` 仍有既有環境權限噪音（`packages/app/dist` unlink EACCES），本輪未改動該權限路徑，列為 non-blocking。

### Execution (Takeover Round B: Provider Boundary Cleanup)

- `ANTIGRAVITY_PROVIDER_ID` 由 `google-api` 改為 `antigravity`，解除 provider identity 綁定。
- `Auth.listAntigravityAccounts()` 改為只讀 `Account.list("antigravity")`，不再讀 `google-api`。
- `Provider.load()` 清理 legacy fallback：
  - antigravity compatibility provider 不再 fallback 到 `database["google-api"]`
  - legacy antigravity loader 不再對 `family === "google-api"` 執行
- `rotation3d.buildFallbackCandidates()` 僅在 core `antigravity` 帳號存在時才做 antigravity quota 探測。
- `/account` list route 僅在 `families.antigravity.accounts` 非空時才載入 antigravity rich status。

### Validation (Round B)

- ✅ `bunx tsc -p packages/opencode/tsconfig.json --noEmit`
- ✅ `bunx eslint packages/opencode/src/plugin/antigravity/constants.ts packages/opencode/src/auth/index.ts packages/opencode/src/provider/provider.ts packages/opencode/src/account/rotation3d.ts packages/opencode/src/server/routes/account.ts`

---

**Status**: In Progress (Takeover active).
**Next Step**: Continue hot-path optimization (Account.state/ModelsDev in-flight lock + Provider.load async waterfall flattening).
