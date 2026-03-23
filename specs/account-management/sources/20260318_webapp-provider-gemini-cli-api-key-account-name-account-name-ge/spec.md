# Spec v2 — Account Manager Unified Refactor

## Purpose

將 account management 從「多條歷史路徑 + 無 event bus + silent fallback 常態化」升級為可說清楚、可追蹤、可驗證的單一標準，並消除所有已知的 silent mutation、storage 不安全、provider hardcode 與跨 session 同步缺口。

---

## Requirements

### R1: AccountManager Service Layer

系統 SHALL 建立新的 `AccountManager` service 作為所有帳號 mutation 的單一入口。

- `AccountManager` wraps `Auth` + `Account`，對外提供統一 API
- 所有 mutation（connect / rename / remove / setActive / login）必須經過 `AccountManager`
- `Account` module 降為 pure repository（只有 CRUD primitive）
- `Auth` module 降為 identity resolution utility（只做 token parsing / dedup detection / provider resolve）

#### Scenario: Any Mutation Must Go Through AccountManager

- **GIVEN** 任何 surface（route / CLI / TUI / console）需要對帳號做寫入操作
- **WHEN** 發起 mutation
- **THEN** 必須呼叫 `AccountManager.*` 方法，不得直接呼叫 `Account.update/remove/setActive` 或 `Auth.set/remove`

---

### R2: Event Bus Contract

系統 SHALL 在每次帳號 mutation 後發出 typed event，供所有 consumer 同步。

- Mutation events：`account:connected`, `account:renamed`, `account:removed`, `account:active-changed`
- Event payload 必須包含：`providerKey`, `accountId`, `source`（哪個 surface 觸發）, `timestamp`
- Consumer 端（TUI / web SSE / daemon）必須訂閱並同步 UI / cache / state

#### Scenario: Account Switched In Admin Panel

- **GIVEN** 使用者在 admin panel 切換 active account
- **WHEN** `AccountManager.setActiveAccount` 完成
- **THEN** event bus 發出 `account:active-changed`，TUI session 必須在 < 1s 內更新 active account 顯示；若 TUI 未收到 event，不得靜默繼續使用舊 account

#### Scenario: Account Removed In CLI

- **GIVEN** 使用者在 CLI 刪除帳號
- **WHEN** `AccountManager.removeAccount` 完成
- **THEN** event bus 發出 `account:removed`，web console 必須收到 event 並從列表移除，不得要求 full page reload

---

### R3: Silent Fallback Elimination

系統 SHALL 消除所有 silent fallback / silent mutation 行為。

#### R3a: Auth.set Token Dedup Disclosure

- **GIVEN** `Auth.set` 偵測到相同 API key 或 OAuth token 已存在
- **WHEN** 決定更新既有帳號而非新增
- **THEN** 必須回傳 `{ action: "updated_existing", accountId, reason }` 而非靜默回傳舊 accountId
- **AND** caller 端必須向使用者顯示「已更新既有帳號」而非「已新增帳號」

#### R3b: UserDaemonManager Single Path

- **GIVEN** mutation 路徑啟用 UserDaemonManager
- **WHEN** daemon call 失敗
- **THEN** 必須回傳明確錯誤（503 + error detail），不得 fallback 到 direct Account mutation
- **AND** 若 daemon 功能不可用，系統啟動時就應 disable daemon path，不在 runtime 混合兩條路徑

#### R3c: Mutation Target Validation

- **GIVEN** `AccountManager.remove/setActive/rename` 收到不存在的 accountId
- **WHEN** 查詢 storage 找不到目標
- **THEN** 必須回傳 404 error，不得靜默 noop

---

### R4: Storage Write Safety

系統 SHALL 確保 in-memory state 與 disk state 的一致性。

- 寫入策略改為 write-ahead：先寫 temp file → rename → 更新 `_storage` in-memory
- 若 disk write 失敗，in-memory 不得已被汙染
- `save()` 失敗時必須 throw，不得靜默吞錯

#### Scenario: Disk Write Failure

- **GIVEN** `Account.save()` 因 permission 或 disk full 失敗
- **WHEN** 寫入 `accounts.json` 時拋出 error
- **THEN** in-memory `_storage` 必須保持 mutation 前的狀態，且 error 必須向上拋給 caller

---

### R5: Canonical Account Terminology

（延續 v1，無變更）

系統 SHALL 使用單一 canonical 帳號管理名詞：

- `providerKey`：provider-scoped identity 的唯一主語言
- `accountId`：持久化與程式內部識別子
- `accountName`：面向使用者的可編輯顯示名稱
- ~~`family`~~：已完全消除，不再存在於 codebase 中（原為 `provider` 的 naming drift）

---

### R6: Route Layer Must Be Transport-Only

（延續 v1，強化 mismatch guard 定義）

`server/routes/account.ts` SHALL 只負責 request parsing、validation、mismatch guard 與 response shaping。

#### Mismatch Guard Specification

- **GIVEN** route 收到 path `:family` 與 body `providerKey`
- **WHEN** 兩者均存在且不一致（例如 path `google` + body `gemini-cli`）
- **THEN** route 必須回傳 `400 Bad Request { error: "providerKey_mismatch", path_family, body_providerKey }`
- **AND** 不得 silent normalize、不得用其中一方覆蓋另一方

---

### R7: CLI/TUI Must Not Bypass Canonical Mutation Contract

（延續 v1，無變更）

CLI/TUI SHALL 不再直接以 `Account.*` mutation 作為主要帳號管理實作。

---

### R8: Session-Local vs Global Active Account Must Be Separate

（延續 v1，補齊持久化決策）

#### Session-Local Persistence Decision

- Session-local selection 存在 **session execution context**（記憶體），不做 disk persistence
- Session 結束時自動清除，不影響 global active
- Session-local selection 生效期間，該 session 的 model request 使用 session-local account，不使用 global active

#### Model-Manager Authority Decision

- `dialog-select-model` 中的 account actions（rename / remove / connect）是 **global mutation**，必須經過 `AccountManager`
- `dialog-select-model` 中的 account **selection**（選哪個帳號執行當前 session）是 **session-local**，不改 global active

---

### R9: App/Console Surface Boundaries

（延續 v1，無變更）

---

### R10: Deploy Verification Gate

（延續 v1，補齊 observable 定義）

#### Observable Specification

- **Bundle freshness check**：比較 source dist 與 runtime path 下的 `index.html` SHA256 hash
- **具體指令**：`sha256sum $BUILD_DIST/index.html` vs `sha256sum $OPENCODE_FRONTEND_PATH/index.html`
- **Pass condition**：兩個 hash 完全一致
- **Implementation**：自動化寫入 `webctl.sh`，而非人工檢查清單

---

### R11: Provider-Specific Logic Consolidation

系統 SHALL 將散落在各層的 provider-specific hardcode 收斂為 provider capability declaration。

- 目前 hardcode 位置：
  - `auth/index.ts`：gemini-cli subscription → return undefined
  - `auth/index.ts`：gemini-cli projectId parsing
  - `dialog-account.tsx`：gemini-cli auto-switch subscription → API key
  - `dialog-account.tsx`：google-api subscription filtering
- Target state：每個 provider 在 canonical-family-source 或 provider config 中聲明自己的 capabilities（如 `supportsSubscription`, `requiresProjectId`, `autoSwitchOnConnect`）
- `AccountManager` 依據 capability declaration 決定行為，不在各層 hardcode

---

### R12: `family` 完全消除

系統 SHALL 在本次重構中完全消除 `family` 概念。

- **不做漸進淘汰**：已確認 `family` 只是 `provider` 的 naming drift（`FamilyData = ProviderData`），無外部依賴
- **完全移除**：所有 `FamilyData` / `FAMILIES` / `knownFamilies` type exports、`resolveFamily*` / `parseFamily()` helpers
- **Route 更新**：路由 path `:family` → `:providerKey`
- **Storage 遷移**：`accounts.json` 中 `families` key → `providers`
- **檔案改名**：`canonical-family-source.ts` → `canonical-provider-source.ts`

### R13: 簡化 Account ID 設計

系統 SHALL 徹底簡化 accountId 設計：

1. **停止生成編碼式超長 ID**：不再用 `{provider}-{type}-{slug}` 格式生成 accountId
2. **accountId = 使用者輸入的 accountName**：accountId 直接採用使用者提供的名稱（經 normalize：trim + lowercase + 空格轉連字號等基本處理）
3. **消除反解析**：`parseProvider(accountId)` / `parseFamily(accountId)` 是錯誤設計，必須移除
4. **Caller 必須攜帶完整 context**：任何使用 account 的場合，caller 必須同時攜帶 `providerKey`（及 `authType` 等相關參數），不得只靠 accountId 反推
5. **唯一性範圍**：accountId 在同一個 `providerKey` 下唯一即可，不需全域唯一

#### Scenario: 使用者新增帳號

- **GIVEN** 使用者輸入 accountName = "My Work Key"
- **WHEN** 系統建立帳號
- **THEN** accountId = "my-work-key"（或使用者輸入的原始值），不是 `gemini-cli-api-a1b2c3d4`

#### Scenario: 同 provider 下名稱衝突

- **GIVEN** 使用者在 gemini-cli 下已有 accountId = "my-key"
- **WHEN** 使用者再新增同名帳號
- **THEN** 系統回報名稱衝突，要求使用者換名，不是自動加後綴

- **遷移策略**：
  - 盤點所有 `parseProvider()` / `parseFamily()` call site → 改為從 context 取 providerKey
  - 盤點所有 accountId 生成邏輯 → 改為基於 accountName
  - 最終移除 `parseProvider()` / `parseFamily()` 函式
  - 既有帳號的長 ID 透過 migration 轉換為短 ID（基於現有 name 欄位）
- Silent migration（family key normalize、email repair）改為 explicit migration with log output

### R14: 前臺 UX 不變（隱式優化）

本次重構對使用者而言是**隱式優化**。

- TUI admin panel 的帳號管理操作流程（list / switch / rename / remove）不得改變使用者體驗
- Webapp model manager 的操作流程（select model / switch account / rename / remove / connect）不得改變使用者體驗
- 使用者不應需要學習新的操作方式或注意到任何界面差異
- 內部 API path 變更（`:family` → `:providerKey`）必須在前端 caller 同步完成，不影響使用者可見行為

---

## Acceptance Checks

- [ ] AccountManager service 有明確的 API signature 與 event emission contract
- [ ] Event bus event types 與 payload schema 已定義
- [ ] 所有已知 silent fallback 都有對應的 elimination 策略
- [ ] Storage write safety pattern 已定義
- [ ] Mismatch guard 回傳 400 的具體格式已定義
- [ ] Session-local 持久化機制已決定（ephemeral in session context）
- [ ] Model-manager authority 已決定（global mutation + session-local selection）
- [ ] Deploy observable 已決定（SHA256 hash comparison）
- [ ] Provider-specific logic consolidation 策略已定義
- [ ] `family` 完全消除策略已定義（立即移除，無漸進淘汰）
- [ ] Account ID format hardening 策略已定義
- [ ] Build agent 可依 spec + tasks 直接執行，不需臨場判斷
