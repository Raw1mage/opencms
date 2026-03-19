# Implementation Spec v2 — Account Manager Unified Refactor

## Goal

建立 AccountManager service layer + event bus 作為基礎，再逐層消除 route direct mutation、silent fallback、CLI/TUI bypass、authority 混淆、surface drift 與 deploy verification 缺口，並徹底消除 `family` 命名漂移。7 個 Slice（0 + A-F）全部有明確的前置依賴、target state、validation strategy 與 stop gates。

## UX 約束

本次重構對使用者而言是**隱式優化**。TUI admin panel 和 webapp model manager 的前臺運作流程必須維持不變。使用者不應感知到內部架構變化。

## Scope

### IN

- AccountManager service layer 建立（`account/manager.ts`）
- Event bus integration（typed account events + consumer sync）
- Storage write-ahead safety pattern
- Route service delegation + mismatch guard（400 規格）
- Silent fallback elimination（Auth.set disclosure / UserDaemonManager single-path / mutation target validation）
- CLI/TUI mutation convergence
- Session-local vs global active authority unification
- App/Console surface alignment + model-manager authority
- Provider-specific hardcode consolidation（capability declaration）
- Deploy verification automation（SHA256 hash gate in webctl.sh）
- `family` 完全消除（立即移除，不做漸進淘汰）
- Account ID format hardening

### OUT

- 不直接實作程式碼（本文件是 execution contract）
- 不新增 provider 類型或 auth method
- 不合併 app/console 為單一 UI

## Assumptions

- `packages/bus/` event bus infrastructure 可直接使用
- `accounts.json` 的寫入頻率極低（分鐘級），write-ahead pattern 不構成 performance concern
- 無外部 API consumer 依賴 `families` response field（已確認，可直接移除）

## Stop Gates

1. **Slice 0 完成前**：其他所有 Slice 不得開始（唯一 hard dependency）
2. **Slice A/B 完成前**：Slice C 不得開始（route contract 須先穩定）
3. **Route path 改 `:providerKey`**：在 Slice F 中直接執行（family 已確認無外部依賴）
4. **App/Console 合併**：不在本計畫範圍，若要合併需另開 spec
5. **UserDaemonManager 廢除**：若 daemon 功能整體不穩定，可在 Slice B 中決定是否完全移除

---

## Slice 0 — AccountManager Service Layer + Event Bus

### 目標

建立所有 mutation 的唯一入口，並在每次 mutation 後發 typed event。

### Target State

新建 `packages/opencode/src/account/manager.ts`：

```typescript
// API Signature
export const AccountManager = {
  connectAccount(params: ConnectParams): Promise<ConnectResult>,
  renameAccount(params: RenameParams): Promise<void>,
  removeAccount(params: RemoveParams): Promise<void>,
  setActiveAccount(params: SetActiveParams): Promise<void>,
  beginLogin(params: LoginParams): Promise<LoginResult>,
  getQuotaHint(params: QuotaParams): Promise<QuotaResult>,
}

// ConnectResult 必須包含 action disclosure
interface ConnectResult {
  accountId: string
  action: "created" | "updated_existing"
  reason?: string  // e.g., "same_api_key_found"
}
```

### Event Bus Integration

每個 mutation 方法結尾必須：
1. 完成 storage write（write-ahead pattern）
2. 發出 typed event（`account:connected` / `account:renamed` / `account:removed` / `account:active-changed`）
3. Event payload 包含 `providerKey`, `accountId`, `source`, `timestamp`

### Storage Write-Ahead Pattern

改造 `Account` module 的 `save()` 函式：
1. Serialize `_storage` clone → write to `accounts.json.tmp`
2. `fs.rename("accounts.json.tmp", "accounts.json")`
3. 成功後才更新 `_storage` in-memory + `_mtime`
4. 失敗時 throw，`_storage` 保持 mutation 前狀態

### Provider Capability Declaration

在 provider config 中新增 capabilities 欄位：
```typescript
interface ProviderCapabilities {
  supportsSubscription: boolean
  requiresProjectId: boolean
  autoSwitchOnConnect?: { from: AccountType; to: AccountType }
  subscriptionBypassInAuth?: boolean
}
```

### Consumer Setup

- TUI：在 session init 時訂閱 account events → 更新 local state
- Web SSE：在 SSE endpoint 加入 account event channel
- Console：用 SSE 取代 `window.location.reload()`

### Validation

- [ ] `AccountManager.*` 方法能正確 wrap `Auth` + `Account` 完成 mutation
- [ ] 每次 mutation 後 event bus 收到正確 typed event
- [ ] `save()` 失敗時 in-memory state 未被汙染
- [ ] Consumer（至少 TUI）能在 < 1s 內收到 event 並更新

### Stop Gate

- Provider capability declaration 的具體 field 可在實作時調整，但結構必須是 declarative config 而非散落的 if/else

---

## Slice A — Route Service Delegation + Mismatch Guard

### 目標

`server/routes/account.ts` 所有 mutation 改為委派 `AccountManager`，加入 providerKey mismatch guard。

### Route Contract Table

| Route | Purpose | Delegation Target | Mismatch Guard |
|-------|---------|------------------|----------------|
| `GET /account/` | list inventory | `AccountManager.listAccounts()` | N/A |
| `POST /account/:providerKey/active` | set global active | `AccountManager.setActiveAccount()` | path `:providerKey` vs body `providerKey` → 400 |
| `PATCH /account/:providerKey/:accountId` | rename | `AccountManager.renameAccount()` | path `:providerKey` vs body `providerKey` → 400 |
| `DELETE /account/:providerKey/:accountId` | remove | `AccountManager.removeAccount()` | path `:providerKey` vs query `providerKey` → 400 |
| `PUT /auth/{providerId}` | connect | `AccountManager.connectAccount()` | providerId resolve mismatch → 400 |
| `GET /account/auth/:providerKey/login` | begin login | `AccountManager.beginLogin()` | path `:providerKey` vs query `providerKey` → 400 |
| `GET /account/quota` | quota hint | `AccountManager.getQuotaHint()` | N/A |

### 禁止行為（After Slice A）

Route 內不得出現：
- `Account.update(...)`
- `Account.setActive(...)`
- `Account.remove(...)`
- `Auth.set(...)` / `Auth.remove(...)`

### Mismatch Guard 規格

```typescript
if (bodyProviderKey && bodyProviderKey !== pathProviderKey) {
  return c.json({
    error: "providerKey_mismatch",
    detail: { path_providerKey: pathProviderKey, body_providerKey: bodyProviderKey }
  }, 400)
}
```

### UserDaemonManager 處理

- 若 `UserDaemonManager.routeAccountMutationEnabled()` 為 true：route 委派 daemon
- Daemon 內部也必須走 `AccountManager`
- **刪除 fallback path**：daemon call 失敗 → 503 error，不 fallback 到 direct mutation

### Validation

- [ ] 所有 mutation route 委派 `AccountManager`
- [ ] Mismatch guard 回傳 400 + 正確 detail
- [ ] Route 內無直接 `Account.*` / `Auth.*` mutation call
- [ ] UserDaemonManager fallback path 已移除

---

## Slice B — Silent Fallback Elimination

### 目標

消除所有已知的 silent fallback / silent mutation 行為。

### B1: Auth.set Token Dedup Disclosure

**現況**：`Auth.set` 偵測到相同 key/token 時，靜默更新既有帳號。

**改法**：
- `Auth.set` 回傳 `{ accountId, action: "created" | "updated_existing", reason? }`
- `AccountManager.connectAccount` 將 action 傳遞給 caller
- Caller（route / CLI / dialog）根據 action 向使用者顯示不同訊息

### B2: Mutation Target Validation

**現況**：`Account.remove/setActive` 對不存在的目標靜默 noop。

**改法**：
- `AccountManager` 在 mutation 前檢查目標是否存在
- 不存在 → throw `AccountNotFoundError(providerKey, accountId)`
- Route 層 catch → 404

### B3: Silent Migration Disclosure

**現況**：
- Family key normalize（`nvidia-work` → `nvidia`）靜默執行
- Email repair（JWT decode → 改名）靜默執行

**改法**：
- 遷移後向 console/log 輸出明確訊息：`[AccountManager] Migrated account key: nvidia-work → nvidia`
- Email repair 改為 `AccountManager.repairAccountEmail()`，回傳 `{ accountId, oldEmail, newEmail }` 供 caller 記錄

### Validation

- [ ] `connectAccount` 回傳包含 `action` 欄位
- [ ] remove/setActive 對不存在目標回傳 404
- [ ] Family key migration 有 log output
- [ ] Email repair 有回傳值供記錄

---

## Slice C — CLI/TUI Mutation Convergence

### 目標

CLI/TUI direct `Account.*` mutation 全部改走 `AccountManager`。

### 受影響位置

| 檔案 | 現行 | 改為 |
|------|------|------|
| `cli/cmd/accounts.tsx` | `Account.setActive(...)` | `AccountManager.setActiveAccount(...)` |
| `cli/cmd/accounts.tsx` | `Account.remove(...)` | `AccountManager.removeAccount(...)` |
| `dialog-account.tsx` | `Account.setActive(...)` | `AccountManager.setActiveAccount(...)` |
| `dialog-admin.tsx` | `Account.remove(...)` | `AccountManager.removeAccount(...)` |
| `dialog-admin.tsx` | `Account.update(...)` | `AccountManager.renameAccount(...)` |
| `cli/cmd/auth.ts` | `Auth.set(...)` | `AccountManager.connectAccount(...)` |

### Read-Only Exception

- `Account.list()` / `Account.get()` / `Account.getActive()` 暫時保留 direct call
- 後續視需求決定是否也走 `AccountManager.list()`

### Validation

- [ ] CLI/TUI 中無直接 `Account.setActive/remove/update` 呼叫
- [ ] CLI/TUI 中無直接 `Auth.set/remove` 呼叫
- [ ] mutation 語意與 route 一致（相同 validation、error、event emission）

---

## Slice D — Active Account Authority Unification

### 目標

明確分離 session-local selection 與 global active account。

### Authority 定義

| 概念 | 入口 | 持久化 | 影響範圍 |
|------|------|--------|---------|
| **Global Active** | `AccountManager.setActiveAccount()` | 寫入 `accounts.json` | 所有 session 的預設 |
| **Session-Local Selection** | `session.setLocalAccount(accountId)` | 記憶體（session context） | 僅當前 session |

### UX 規則

- Global active badge：顯示 "Active" 或 ✓
- Session-local override badge：顯示 "Session" 或 "Override"
- 兩者不得共用同一視覺訊號
- 若 session-local 與 global active 相同，只顯示 "Active"

### Session-Local 生命週期

1. 使用者在 `dialog-select-model` 選擇不同帳號 → 設為 session-local
2. Session 期間，所有 model request 使用 session-local account
3. Session 結束（對話關閉）→ session-local 自動清除
4. Session-local 帳號被全域刪除 → session-local 自動 fallback 到 global active，並顯示通知

### Validation

- [ ] `dialog-select-model` 的 selection 不改 global active
- [ ] Settings / console / CLI / TUI 的 switch 改 global active
- [ ] UI 能區分 session-local override vs global active
- [ ] Session-local 帳號被刪除時有 fallback + 通知

---

## Slice E — App/Console Surface Contract Alignment

### 目標

對齊 app / console 的帳號管理欄位語意，明確 model-manager 的 authority。

### Surface Boundary Matrix

| Surface | 角色 | 允許操作 | Authority |
|---------|------|---------|-----------|
| `app` connect dialog | Onboarding/connect | `AccountManager.connectAccount()` | Global |
| `app` settings-accounts | Account inventory + active switch | list, `setActiveAccount()` | Global |
| `app` dialog-select-model | Session execution selection + metadata actions | selection=Session-local, rename/remove/connect=Global | Mixed |
| `console` accounts page | Account inventory + active switch | list, `setActiveAccount()` | Global |
| `console` provider-section | BYOK credential management | `connectAccount()`, workspace-scoped | Global |

### Shared Form Contract

所有 account mutation form 必須使用：
- `providerKey`（canonical）
- `accountName`（UI label 可為 "Name" / "Account name"，但 field name 一致）
- `credentials`（API key / token）
- Validation：name required + trim, credentials required, empty → error

### Console Sync 改善

- 帳號切換後，console 改用 event bus SSE 更新 React state，取代 `window.location.reload()`

### Validation

- [ ] App/console form 欄位語意一致
- [ ] Model-manager 的 rename/remove/connect 走 `AccountManager`（global）
- [ ] Model-manager 的 selection 走 session-local
- [ ] Console 帳號切換不再 full page reload

---

## Slice F — Deploy Verification + Legacy Cleanup

### 目標

自動化 deploy verification gate + 清理 legacy naming + hardening。

### F1: Deploy Gate Automation

在 `webctl.sh` 中加入自動化 gate：

```bash
verify_deploy() {
  local src_hash=$(sha256sum "$BUILD_DIST/index.html" | cut -d' ' -f1)
  local runtime_hash=$(sha256sum "$OPENCODE_FRONTEND_PATH/index.html" | cut -d' ' -f1)
  if [ "$src_hash" != "$runtime_hash" ]; then
    echo "DEPLOY GATE FAILED: frontend hash mismatch"
    echo "  source:  $src_hash"
    echo "  runtime: $runtime_hash"
    return 1
  fi
  echo "DEPLOY GATE PASSED: $src_hash"
}
```

`dev-refresh` 流程結尾必須呼叫 `verify_deploy()`，失敗則中止。

### F2: 簡化 Account ID + 消除反解析

**設計決策**：
- accountId 直接用使用者輸入的 accountName（經 normalize：trim + lowercase + 空格轉連字號）
- 停止生成 `{provider}-{type}-{slug}` 格式的超長 ID
- 唯一性範圍：同一 providerKey 下唯一即可
- 同 provider 下重名 → 回報衝突，要求使用者換名（不自動加後綴）

**遷移步驟**：
1. 改寫 accountId 生成邏輯：新帳號 = `normalize(accountName)`
2. 既有帳號 migration：長 ID → 基於現有 name 欄位的短 ID
3. 盤點所有 `parseProvider()` / `parseFamily()` call site → 改從 context 取 providerKey
4. 移除 `parseProvider()` / `parseFamily()` / `parseAccountType()` 函式
5. AccountManager.connectAccount 在同 provider 下檢查名稱唯一性

### F3: `family` 完全消除

一次性直接移除所有 `family` 相關程式碼與概念（不做漸進淘汰）：

1. 移除所有 type exports：`FamilyData` / `FAMILIES` / `knownFamilies` / `FamilyKey`
2. 移除所有 helper functions：`resolveFamily*` / `parseFamily()` / `parseFamilyKey()`
3. Route path `:family` → `:providerKey`（所有路由）
4. Response body `families` field → `providers`（或直接移除）
5. Storage key migration：`accounts.json` 中 `families` → `providers`
6. `canonical-family-source.ts` → `canonical-provider-source.ts`（檔名 + 所有 import path）
7. 前端 caller（app / console）的 API 呼叫同步更新 route path

### F4: Silent Migration → Explicit Migration

- Storage key migration（`families` → `providers`）：加 log output `[AccountManager] Migrated storage key: families → providers`
- Email repair：改為顯式方法，回傳 migration result

### Validation

- [ ] `dev-refresh` 後 SHA256 gate 自動執行
- [ ] Gate 失敗時 dev-refresh 中止且輸出 hash detail
- [ ] `parseProvider()` / `parseFamily()` 已移除，所有 call site 改從 context 取 providerKey
- [ ] 所有 `FamilyData` / `FAMILIES` / `resolveFamily*` / `parseFamily` / `knownFamilies` exports 已移除
- [ ] Route path 已全部從 `:family` 改為 `:providerKey`
- [ ] Response body 無 `families` field
- [ ] `canonical-family-source.ts` 已改名為 `canonical-provider-source.ts`
- [ ] Storage migration（`families` → `providers`）有 log output

---

## Non-Negotiable Rules（v2 強化）

1. 不新增 silent fallback
2. 不允許 route / CLI / TUI 各自持有不同 mutation semantics
3. 不允許任何 code 使用 `family` 概念（已完全消除，不只是禁止新功能）
4. 不允許 mutation 不發 event
5. 不允許 storage write 失敗後 in-memory 已髒
6. 不允許 mutation 對不存在目標靜默 noop
7. 不允許 daemon fallback 到 direct mutation

---

## Modeling Boundary

IDEF0/GRAFCET 用於需求分解與流程檢核，不代替程式結構文件。實際模組邊界以 `specs/architecture.md` 為準。
