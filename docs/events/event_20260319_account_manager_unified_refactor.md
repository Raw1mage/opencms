# Event: Account Manager Unified Refactor

**Date**: 2026-03-18 ~ 2026-03-19
**Branch**: `account-manager-refactor` (opencode-beta)

## Scope

全面重構 Account / Auth / Provider 的 mutation 路徑與術語體系。

### IN
- AccountManager service layer（單一 mutation 入口）
- Auth.set disclosure（回傳 SetResult）
- CLI / TUI / Route mutation convergence
- Storage schema migration（families → providers）
- Canonical provider source 術語統一（family → providerKey）
- 移除所有 deprecated family aliases

### OUT
- F.1/F.2 webctl.sh verify_deploy（獨立 infra 任務）
- F.3/F.4/F.5 accountId 生成邏輯改寫（需獨立 migration plan）
- F.6/F.7 parseProvider 移除（仍為有效 utility）
- 0.9/0.10/0.11 Event bus consumer 整合（TUI/SSE/E2E test）
- SDK regeneration（待 route 穩定後處理）

## Task Checklist

### Slice 0 — AccountManager Service Layer
- [x] AccountManager with 6 mutation methods + connectAccount convenience
- [x] AccountNotFoundError typed error class
- [x] Auth.set returns SetResult { accountId, action, reason }

### Slice A — Route Service Delegation
- [x] All account routes delegate to AccountManager
- [x] Route paths: `:family` → `:providerKey`
- [x] AccountNotFoundError → 404 responses

### Slice B — Silent Fallback Elimination
- [x] Auth.set disclosure (created vs updated_existing)
- [x] Storage key migration (families → providers with auto-migrate)

### Slice C — CLI/TUI Mutation Convergence
- [x] accounts.tsx: Account.setActive/remove → AccountManager
- [x] dialog-admin.tsx: Account.remove/update → AccountManager
- [x] auth.ts: Auth.set → AccountManager.connectAccount/connectOAuth
- [x] dialog-account.tsx: Account.setActive/remove → AccountManager

### Slice D — Active Account Authority
- [x] Already satisfied via Session.ExecutionIdentity.accountId

### Slice E — App/Console Surface Alignment
- [x] Webapp account switch uses SDK disposal + refetch (no reload)
- [~] Form semantics: R14 UX 不變限制，延後

### Slice F — Legacy Cleanup
- [x] canonical-family-source.ts → canonical-provider-source.ts
- [x] Input fields: accountFamilies → accountProviders, excludedFamilies → excludedProviderKeys
- [x] Function params: family → providerKey (resolve functions)
- [x] GENERIC_RUNTIME_FAMILIES → GENERIC_RUNTIME_PROVIDERS
- [x] Remove all deprecated aliases (FAMILIES, knownFamilies, resolveFamily*, parseFamily, etc.)
- [x] Remove (Account as any) fallback casts in llm.ts, model-orchestration.ts, provider.ts
- [x] Update test mocks to use new names
- [x] F.18 verification: grep confirms zero residual family terminology

## Key Decisions

1. **parseProvider 保留**: parseProvider / parseProviderKey 仍是合理的 utility function（從 providerId 推斷 canonical providerKey），不屬於需移除的 "family" 術語。
2. **Deprecated aliases 直接刪除**: Codebase-wide grep 確認零 caller 後直接移除，不保留過渡期。
3. **`(Account as any)` 消除**: 三處 runtime fallback cast (`resolveProvider ?? resolveFamily`) 簡化為直接呼叫 `Account.resolveProvider`。
4. **accountFamilies local var in local.tsx**: TUI context 內部的 `accountFamilies` createResource 名稱保留為 local implementation detail，不影響 API surface。

## Verification

- TypeScript compilation: `tsc --noEmit` EXIT 0 (all 9 commits)
- Grep verification: `\bFamilyData\b|\bFAMILIES\b|\bresolveFamily\b|\bparseFamily\b|\bknownFamilies\b` → No matches found
- Route params: All account routes use `:providerKey`
- Storage: Auto-migration on read (families → providers)

### Architecture Sync
Architecture Sync: Pending — AccountManager service layer, storage migration, canonical-provider-source changes need sync to specs/architecture.md.

## Commits (account-manager-refactor branch)

1. `feat(account): add AccountManager service layer`
2. `refactor(routes): delegate account mutations to AccountManager`
3. `refactor(auth): Auth.set returns SetResult disclosure`
4. `refactor(cli): converge CLI/TUI mutations to AccountManager`
5. `refactor(account): storage schema families → providers`
6. `refactor(account): rename family terminology across call sites`
7. `refactor(provider): complete canonical-provider-source terminology migration`
8. `refactor(account): remove all deprecated family aliases`
9. `refactor: remove (Account as any) fallback casts and family local vars`
