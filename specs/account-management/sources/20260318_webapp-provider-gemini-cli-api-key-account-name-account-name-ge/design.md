# Design v2 — Account Manager Unified Refactor

## Context

v1 正確識別了名詞漂移、presentation drift 與 deploy verification 缺口。但交叉比對原始碼後發現更根本的問題：

1. **沒有 event bus**：帳號 mutation 完全靜默，跨 session / daemon 無法同步
2. **沒有真正的 service layer**：route / CLI / TUI 各自直接碰 storage
3. **Silent fallback 常態化**：Auth.set token dedup、UserDaemonManager fallback、mutation noop
4. **Storage 不安全**：先改 memory 再寫 disk，save 失敗 memory 已髒
5. **Provider-specific logic 散落**：gemini-cli 的特殊行為硬寫在 auth / dialog / account 各層

## Design Goal

建立一個完整的 service layer（AccountManager），所有 mutation 經此入口，每次 mutation 發 event，消除所有 silent fallback，確保 storage 寫入安全。徹底消除 `family` 命名漂移，統一為 `provider`。

## UX 約束

本次重構對使用者而言是**隱式優化**。TUI admin panel 和 webapp model manager 的前臺運作流程必須維持不變。使用者不應感知到內部架構變化。

---

## Architecture Decisions（全部已做決定）

### Decision 1: 新建 AccountManager，不擴展 Auth

**選擇**：新建 `packages/opencode/src/account/manager.ts` 作為 `AccountManager`。

**理由**：
- `Auth` 目前已承擔過多責任（token parsing + provider resolve + dedup + collision resolution + connect）
- 將 Auth 再擴展會讓已肥大的模組更難維護
- 新模組可從一開始就設計正確的 API signature、event emission、error contract

**責任劃分**：
- `AccountManager`：mutation orchestration + event emission + validation + error handling
- `Auth`：identity resolution utility（token parsing / dedup detection / provider resolve）
- `Account`：pure repository（CRUD primitive on accounts.json）

### Decision 2: Event Bus 使用既有 bus 架構

**選擇**：使用 `packages/bus/` 既有的 event bus infrastructure。

**Event Types**：
```typescript
type AccountEvent =
  | { type: "account:connected"; providerKey: string; accountId: string; source: MutationSource }
  | { type: "account:renamed"; providerKey: string; accountId: string; newName: string; source: MutationSource }
  | { type: "account:removed"; providerKey: string; accountId: string; source: MutationSource }
  | { type: "account:active-changed"; providerKey: string; accountId: string; previousAccountId?: string; source: MutationSource }

type MutationSource = "route" | "cli" | "tui" | "console" | "daemon" | "migration"
```

**Consumer 行為**：
- TUI：訂閱 event → 更新 local state → re-render
- Web SSE：event → push SSE message → client reconcile
- Console：event → push SSE message → React state update（取代 full reload）
- Daemon：event → sync daemon-local cache

### Decision 3: Mismatch Guard 回傳 400

**選擇**：route 收到 path `:family` 與 body `providerKey` 不一致時，回傳 `400 Bad Request`。

**格式**：
```json
{
  "error": "providerKey_mismatch",
  "detail": {
    "path_family": "google",
    "body_providerKey": "gemini-cli"
  }
}
```

**理由**：400 而非 409，因為這是 client 端送的 request 本身有矛盾，不是 server 端狀態衝突。

### Decision 4: Session-Local Selection 是 Ephemeral

**選擇**：session-local account/model selection 存在 session execution context（記憶體），session 結束即清除。

**理由**：
- Session-local 是「這次對話用哪個帳號」，不是持久偏好
- 持久化會引入「session-local 選了一個後來被刪除的帳號」的 zombie 問題
- 如果使用者要持久偏好，那是 global active 的語意

### Decision 5: Model-Manager Account Actions 是 Global Mutation

**選擇**：`dialog-select-model` 中的 rename / remove / connect 走 `AccountManager`（global mutation），selection（選哪個帳號執行）是 session-local。

**理由**：
- Rename / remove 是對帳號資料的修改，影響所有 session
- 如果 model-manager 的 rename 只影響當前 session，使用者回到 settings 會看到舊名字，造成混亂
- Selection（選用哪個帳號來跑當前 session）才是 session-local 語意

### Decision 6: Deploy Observable 用 SHA256

**選擇**：比較 source dist 與 runtime path 下 `index.html` 的 SHA256 hash。

**具體指令**：
```bash
SOURCE_HASH=$(sha256sum "$BUILD_DIST/index.html" | cut -d' ' -f1)
RUNTIME_HASH=$(sha256sum "$OPENCODE_FRONTEND_PATH/index.html" | cut -d' ' -f1)
[ "$SOURCE_HASH" = "$RUNTIME_HASH" ] || { echo "DEPLOY GATE FAILED: hash mismatch"; exit 1; }
```

**理由**：mtime 可能因 rsync 行為而不變；version field 需要額外維護；SHA256 是最可靠的 content-level 比較。

### Decision 7: Storage Write-Ahead Pattern

**選擇**：mutation 先寫 temp file → atomic rename → 更新 in-memory。

**流程**：
1. Clone `_storage` → apply mutation on clone
2. Write clone to `accounts.json.tmp`
3. `rename("accounts.json.tmp", "accounts.json")`
4. Update `_storage` = clone, `_mtime` = new mtime
5. 若 step 2-3 失敗，`_storage` 未被汙染

### Decision 8: Provider Capability Declaration

**選擇**：在 provider config / canonical-family-source 中聲明 provider capabilities。

**結構**：
```typescript
interface ProviderCapabilities {
  supportsSubscription: boolean
  requiresProjectId: boolean
  autoSwitchOnConnect?: { from: AccountType; to: AccountType }
  subscriptionBypassInAuth?: boolean
}
```

**受影響 hardcode**：
- `auth/index.ts:108`：gemini-cli subscription → return undefined → 改用 `capabilities.subscriptionBypassInAuth`
- `auth/index.ts:226`：gemini-cli projectId → 改用 `capabilities.requiresProjectId`
- `dialog-account.tsx:38-49`：gemini-cli auto-switch → 改用 `capabilities.autoSwitchOnConnect`

### Decision 9: `family` 立即完全消除

**選擇**：不做漸進淘汰，直接在本次重構中完全消除 `family` 概念。

**理由**（程式碼審計確認）：
- `FamilyData` 是 `ProviderData` 的 literal type alias
- `FAMILIES` 是 `PROVIDERS` 的 literal alias
- 所有 canonical provider 都是 1:1 對應（唯一例外 `google` 已被拆分為 `gemini-cli` + `google-api` 並 blocklisted）
- `family` 從來不是獨立抽象，只是 `provider` 的命名漂移
- 沒有外部 API consumer 依賴 `families` field

**消除範圍**：
1. 移除所有 `FamilyData` / `FAMILIES` / `knownFamilies` type exports
2. 移除所有 `resolveFamily*` / `parseFamily()` / `parseFamilyKey()` helpers
3. Route path `:family` 一律改為 `:providerKey`
4. Response body 中的 `families` field 直接移除（不需 @deprecated 過渡期）
5. Storage key `families` → `providers`（一次性 migration）
6. `canonical-family-source.ts` 改名為 `canonical-provider-source.ts`

### Decision 10: 簡化 Account ID — 直接用使用者輸入的名稱

**選擇**：
- accountId = 使用者輸入的 accountName（經 normalize）
- 停止生成 `{provider}-{type}-{slug}` 格式的超長 ID
- 唯一性範圍：同一 providerKey 下唯一即可，不需全域唯一
- 消除 `parseProvider()` / `parseFamily()` 反解析函式

**理由**（使用者指出）：
- accountId 沒有全域唯一的必要性
- 不應該從 accountId 去反解析 provider — 這是錯誤設計
- 任何用到 account 的場合，一定是連 providerKey 和 authType 相關參數一起帶出
- 不應該只靠 accountId 去判斷任何事
- 超長的系統生成 ID 沒有意義，直接用使用者給的名字

**遷移策略**：
1. 新帳號：accountId = normalize(accountName)，同 provider 下重名則要求使用者換名
2. 既有帳號：透過 migration 將長 ID 轉為短 ID（基於現有 name 欄位）
3. 盤點所有 `parseProvider()` / `parseFamily()` call site → 改從 context 取 providerKey
4. 移除 `parseProvider()` / `parseFamily()` / `parseAccountType()` 函式

---

## Proposed Standard Layers（v2）

- **Layer 0 — Service + Event Bus**
  - AccountManager service + typed event bus
- **Layer 1 — Terminology Contract**
  - canonical nouns / compatibility aliases / mismatch guard
- **Layer 2 — Mutation Safety**
  - write-ahead storage / silent fallback elimination / target validation
- **Layer 3 — Presentation Contract**
  - app / console / CLI / TUI 的角色、authority、event consumer 行為
- **Layer 4 — Delivery Verification**
  - SHA256 gate / webctl.sh automation / family 完全消除 / legacy cleanup

---

## Modeling Boundary

- IDEF0/GRAFCET 用於需求與流程驗證，不是程式結構文件。
- 實作模組邊界以 `specs/architecture.md` 為準。

---

## Risks / Trade-offs

- **Slice 0 投資大但回報高**：建立 service layer + event bus 需要改動最多檔案，但它是解決 ghost responses、cross-session sync、silent fallback 的唯一根本方案
- **Write-ahead pattern 增加 I/O**：每次 mutation 多一次 temp file write，但帳號 mutation 頻率極低（分鐘級），不構成 performance concern
- **Provider capability declaration 增加 config 複雜度**：但消除了散落的 hardcode，新 provider 只需聲明 capabilities 而不需改多處 if/else
- **`family` 一步到位消除**：已確認無外部 caller，不需漸進淘汰。一次性 migration + 移除所有 family 相關 code

---

## Critical Files

- `packages/opencode/src/account/index.ts` — storage repository
- `packages/opencode/src/account/manager.ts` — **新建** AccountManager service
- `packages/opencode/src/auth/index.ts` — identity resolution utility
- `packages/opencode/src/server/routes/account.ts` — route transport layer
- `packages/bus/` — event bus infrastructure
- `packages/opencode/src/provider/canonical-family-source.ts` — provider capabilities
- `packages/app/src/components/dialog-connect-provider.tsx`
- `packages/app/src/components/settings-accounts.tsx`
- `packages/app/src/components/dialog-select-model.tsx`
- `packages/console/app/src/routes/accounts.tsx`
- `packages/console/app/src/routes/workspace/[id]/provider-section.tsx`
- `packages/opencode/src/cli/cmd/accounts.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx`
- `webctl.sh`

---

## Slice Dependency Graph

```
Slice 0 (Service + Event Bus)
  ├── Slice A (Route Delegation)        [depends on: 0]
  ├── Slice B (Silent Fallback Purge)   [depends on: 0]
  ├── Slice C (CLI/TUI Convergence)     [depends on: 0, A]
  ├── Slice D (Authority Unification)   [depends on: 0]
  ├── Slice E (Surface Alignment)       [depends on: 0, C, D]
  └── Slice F (Deploy + Legacy)         [depends on: A, E]
```

A 與 B 可平行；C 依賴 A（route contract 穩定後才收斂 CLI/TUI）；D 與 A/B 可平行；E 依賴 C+D；F 最後。
