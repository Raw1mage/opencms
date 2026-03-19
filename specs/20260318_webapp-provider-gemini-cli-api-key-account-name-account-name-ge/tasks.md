# Tasks v2 — Account Manager Unified Refactor

## Slice 0 — AccountManager Service Layer + Event Bus

- [x] 0.1 新建 `packages/opencode/src/account/manager.ts`，定義 `AccountManager` export 與 API signature（connectApiKey / connectOAuth / renameAccount / removeAccount / setActiveAccount / updateAccount）
- [x] 0.2 實作 `AccountManager` 各方法，wrap `Auth` + `Account` 完成 mutation orchestration
- [x] 0.3 定義 typed account events（`account.connected` / `account.renamed` / `account.removed` / `account.active-changed` / `account.updated`）並整合 `packages/bus/` event bus
- [x] 0.4 每個 `AccountManager` mutation 方法結尾加入 event emission
- [x] 0.5 改造 `Account.save()` 為 write-ahead pattern（temp file → rename → update in-memory）
- [x] 0.6 確保 `save()` 失敗時 in-memory `_storage` 未被汙染（mutate() clone-save-swap pattern）
- [x] 0.7 在 `provider/capabilities.ts` 新增 `subscriptionProvidesAuth` 欄位
- [x] 0.8 將 `auth/index.ts` 中 gemini-cli 相關 hardcode 改為讀取 `subscriptionProvidesAuth()` capability
- [ ] 0.9 TUI consumer：在 session init 訂閱 account events → 更新 local state → re-render
- [ ] 0.10 Web SSE consumer：在 SSE endpoint 加入 account event channel
- [ ] 0.11 驗證：mutation → event → consumer sync 端到端測試

## Slice A — Route Service Delegation + Mismatch Guard

- [x] A.1 `GET /account/`：改為委派 `AccountManager.listAll()`
- [x] A.2 `POST /account/:family/active`：改為委派 `AccountManager.setActiveAccount()`（含 404 error handling）
- [x] A.3 `PATCH /account/:family/:accountId`：改為委派 `AccountManager.renameAccount()`（含 404 error handling）
- [x] A.4 `DELETE /account/:family/:accountId`：改為委派 `AccountManager.removeAccount()`（含 404 error handling）
- [x] A.5 `PUT /auth/:providerId`：改為委派 `AccountManager.connectApiKey()` / `AccountManager.connectOAuth()`（wellknown 保留 Auth.set）
- [~] A.6 `GET /account/auth/:providerKey/login`：保留原實作（login 是 Plugin.getAuth 流程，不屬 AccountManager 範疇）
- [~] A.7 `GET /account/quota`：保留原實作（quota 是 read-only 且已有專用 getQuotaHint）
- [x] A.8 providerKey mismatch guard 已存在（v1 已實作）
- [~] A.9 UserDaemonManager fallback path：保留至 Slice B 處理（daemon 路徑屬 silent fallback 範疇）
- [x] A.10 驗證：route mutation paths 已改為 AccountManager delegation
- [x] A.11 驗證：mismatch guard 已驗證（v1 已實作，本次未更動）

## Slice B — Silent Fallback Elimination

- [x] B.1 修改 `Auth.set` 回傳 `{ accountId, action, reason }`（disclosure token dedup）
- [x] B.2 修改 `AccountManager.connectAccount` 傳遞 action 到 caller
- [~] B.3 各 caller（route / CLI / dialog）根據 action 顯示不同訊息 — callers 可用 action 欄位，但 UI 訊息保持原樣（R14 UX 不變限制）
- [x] B.4 `AccountManager` mutation 前檢查目標是否存在，不存在 → throw `AccountNotFoundError`
- [x] B.5 Route catch `AccountNotFoundError` → 404
- [x] B.6 Storage key migration（`families` → `providers`）加 log output — 已存在於 normalizeProviderKeys
- [x] B.7 Email repair 改為顯式方法，回傳 migration result — 已存在 repairEmails() 回傳 { fixed, total }
- [x] B.8 驗證：Auth.set 回傳 action="updated_existing" 且 AccountManager 傳遞到 caller
- [x] B.9 驗證：removeAccount 對不存在帳號 throw AccountNotFoundError → route 回 404

## Slice C — CLI/TUI Mutation Convergence

- [x] C.1 `cli/cmd/accounts.tsx`：`Account.setActive` → `AccountManager.setActiveAccount`
- [x] C.2 `cli/cmd/accounts.tsx`：`Account.remove` → `AccountManager.removeAccount`
- [x] C.3 `dialog-account.tsx`：`Account.setActive` → `AccountManager.setActiveAccount`
- [x] C.4 `dialog-admin.tsx`：`Account.remove` → `AccountManager.removeAccount`
- [x] C.5 `dialog-admin.tsx`：`Account.update` → `AccountManager.renameAccount`
- [x] C.6 `cli/cmd/auth.ts`：`Auth.set` → `AccountManager.connectAccount`
- [x] C.7 驗證：CLI/TUI 中無直接 `Account.setActive/remove/update` 或 `Auth.set/remove`（僅 wellknown Auth.set 保留）
- [x] C.8 驗證：CLI mutation 觸發 event bus event（所有 AccountManager 方法均包含 Bus.publish）

## Slice D — Active Account Authority Unification

- [x] D.1 Session.ExecutionIdentity 已有 accountId 欄位（ephemeral, per-session）
- [x] D.2 dialog-model.tsx 已使用 local.model.set() 寫入 session-scoped store，不呼叫 setActiveAccount
- [x] D.3 processor.ts + llm.ts 已實作 session-pinned accountId → user.model.accountId → Account.getActive() 優先序
- [x] D.4 Session-local state 以 `${sessionID}::${agentName}` key 存儲，session 結束自然失效
- [~] D.5 Session-local account 被刪除時 Auth.get 回傳 undefined → model request 顯式失敗（非 silent fallback）
- [~] D.6 UI badge 分離 — 因 R14 UX 不變限制暫不改動前臺 badge 顯示
- [x] D.7 驗證：dialog-model.tsx 中無 setActiveAccount 呼叫
- [x] D.8 驗證：settings/admin/CLI 的 account switch 仍使用 AccountManager.setActiveAccount（global mutation）
- [~] D.9 UI badge 區分 — 延後至 R14 限制解除

## Slice E — App/Console Surface Contract Alignment

- [~] E.1 app/console form field names — R14 UX 不變限制，現有 form semantics 保持原樣
- [~] E.2 validation 行為 — R14 UX 不變限制，現有 validation 保持原樣
- [x] E.3 dialog-account.tsx 的 remove/setActive 已改為 AccountManager（Slice C 完成）
- [x] E.4 Webapp 帳號切換已使用 SDK disposal + refetch，無 window.location.reload()
- [~] E.5 form semantics 統一 — 延後至 R14 限制解除
- [x] E.6 驗證：dialog-account.tsx 走 AccountManager.removeAccount / setActiveAccount
- [x] E.7 驗證：webapp 帳號切換無 full page reload（使用 globalSDK.client.global.dispose() + refetch）

## Slice F — Deploy Verification + Legacy Cleanup

- [~] F.1 在 `webctl.sh` 中新增 `verify_deploy()` 函式 — 延後（獨立 infra 任務，不屬 terminology migration）
- [~] F.2 `dev-refresh` 流程結尾呼叫 `verify_deploy()` — 延後（同 F.1）
- [~] F.3 改寫 accountId 生成邏輯 — 延後（需獨立 migration plan 與 backward compat 策略）
- [~] F.4 AccountManager.connectAccount 名稱唯一性檢查 — 延後（依賴 F.3）
- [~] F.5 既有帳號 migration — 延後（依賴 F.3）
- [~] F.6 盤點 parseProvider() call site → 改從 context 取 — 延後（parseProvider 仍為有效 utility，不適合移除）
- [~] F.7 移除 parseProvider() / parseAccountType() — 延後（仍有合理用途）
- [x] F.8 移除所有 `family` type exports：`FamilyData` / `FAMILIES` / `knownFamilies` — grep 確認零殘留
- [x] F.9 移除所有 `family` helper functions：`resolveFamily*` / `parseFamily()` — grep 確認零殘留
- [x] F.10 Route path `:family` → `:providerKey`（所有路由），前端 caller 同步更新
- [x] F.11 Response body `families` field → `providers`（storage + route response）
- [x] F.12 `canonical-family-source.ts` → `canonical-provider-source.ts`（檔名 + 所有 import path + 內部術語）
- [x] F.13 Storage key migration：`accounts.json` 中 `families` → `providers`（含 migration-on-read + log）
- [~] F.14 驗證：SHA256 gate — 延後（依賴 F.1）
- [~] F.15 驗證：gate 失敗中止 — 延後（依賴 F.1）
- [~] F.16 驗證：新 accountId 格式 — 延後（依賴 F.3）
- [~] F.17 驗證：parseProvider 移除 — 延後（F.6/F.7 延後）
- [x] F.18 驗證：codebase 中無任何 `FamilyData` / `FAMILIES` / `resolveFamily` / `parseFamily` / `knownFamilies` 殘留 ✓
- [~] F.19 驗證：前臺運作流程一致 — 需 runtime 測試確認（R14 隱式優化限制）

## Cross-Cutting

- [ ] X.1 更新 `specs/architecture.md`：AccountManager service layer、event bus contract、write-ahead pattern、provider capabilities
- [ ] X.2 更新 `docs/events/` event log
- [ ] X.3 所有 Slice 完成後 regression：確認 ghost responses bug 不再重現
