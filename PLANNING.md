# CMS 模組化重構計畫

> 本計畫將 cms 分支的認證系統與管理介面做成獨立模組，以便日後 patch 到 origin/dev。

## 模組依賴圖

```
                    ┌─────────────────────────┐
                    │       /admin TUI        │
                    │   (dialog-admin.tsx)    │
                    └───────────┬─────────────┘
                                │ depends on
                    ┌───────────┴─────────────┐
                    │                         │
        ┌───────────▼───────────┐   ┌────────▼────────────────┐
        │    Account Module     │   │  Google Provider Suite  │
        │  (src/account/*.ts)   │   │  (gemini-cli+antigrav)  │
        │   多帳號管理核心       │   │   OAuth + Rate Limit    │
        └───────────┬───────────┘   └────────┬────────────────┘
                    │                        │
                    └──────────┬─────────────┘
                               │ patch
                    ┌──────────▼──────────────┐
                    │   origin/dev Auth       │
                    │   (src/auth/index.ts)   │
                    └─────────────────────────┘
```

---

## 設計決策摘要

| 項目            | 決策                                        |
| --------------- | ------------------------------------------- |
| Provider 設計   | antigravity、gemini-cli 維持獨立 provider   |
| Auth 系統       | Patch origin/dev 採用 cms 的 Account 模組   |
| 跨模型相容      | 以最大相容 origin/dev 的方式處理            |
| Rate Limit 處理 | Toast 通知 + 依 Favorites 順序自動切換      |
| TUI 設計        | `/admin` 完全獨立，origin/dev 導向至 cms 版 |
| 儲存格式        | 統一使用 `accounts.json`                    |

---

## 一、模組架構

### 1.1 核心模組：Account System

**職責**：統一管理所有 provider 的認證資訊

```
src/account/
├── index.ts          # Account namespace (list, add, remove, setActive, getActiveInfo)
├── rotation.ts       # 全域帳號輪替系統 (HealthScore, RateLimit, Selection)
├── types.ts          # AccountInfo, AccountFamily 型別定義
└── migration.ts      # auth.json → accounts.json 遷移邏輯
```

**關鍵 API**：

- `Account.list(family)` - 列出該 family 所有帳號
- `Account.add(family, info)` - 新增帳號
- `Account.remove(family, accountId)` - 移除帳號
- `Account.setActive(family, accountId)` - 設定使用中帳號
- `Account.getActiveInfo(family)` - 取得目前使用中帳號資訊
- `Account.forceFullMigration()` - 強制遷移 auth.json

**輪替 API**（從 antigravity 抽取後的全域版本）：

- `Account.getNextAvailable(family, provider, model)` - 取得下一個可用帳號
- `Account.recordSuccess(accountId)` - 記錄成功請求，提升健康度
- `Account.recordRateLimit(accountId, provider, reason, backoffMs)` - 記錄 rate limit
- `Account.recordFailure(accountId)` - 記錄失敗，降低健康度
- `Account.isRateLimited(accountId, provider, model)` - 檢查是否被限速
- `Account.getMinWaitTime(family, provider, model)` - 取得最短等待時間
- `Account.getRotationStatus(family, provider)` - 取得輪替狀態（用於 Admin UI）

### 1.2 Google Provider Suite

三個獨立 provider，各自模擬不同 Google client 以獲得獨立配額：

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Google Provider Suite                              │
├───────────────┬──────────────────┬───────────────────────────────────────┤
│  google-api   │   gemini-cli     │          antigravity                  │
├───────────────┼──────────────────┼───────────────────────────────────────┤
│ Auth: API Key │ Auth: OAuth PKCE │ Auth: OAuth PKCE                      │
│               │                  │                                        │
│ Client ID:    │ Client ID:       │ Client ID:                            │
│ (none)        │ 681255809395-... │ 1071006060591-...                     │
│               │                  │                                        │
│ Redirect:     │ Redirect:        │ Redirect:                             │
│ (none)        │ :8085            │ :51121                                │
│               │                  │                                        │
│ Endpoint:     │ Endpoint:        │ Endpoints (fallback):                 │
│ ai.googleapis │ cloudcode-pa     │ daily-sandbox → autopush → prod       │
│               │                  │                                        │
│ Headers:      │ Headers:         │ Headers:                              │
│ minimal       │ nodejs-client    │ antigravity/vscode                    │
│               │                  │                                        │
│ Multi-account:│ Multi-account:   │ Multi-account:                        │
│ ❌            │ ❌               │ ✅ (rotation + cooldown)              │
└───────────────┴──────────────────┴───────────────────────────────────────┘
```

**設計目的**：每個 client identity 在 Google 端有獨立的 rate limit 配額，分開使用可獲得額外的免費資源。

**檔案結構**：

```
src/plugin/
├── google-api/           # API Key 認證
│   └── plugin/
│       ├── index.ts
│       └── token.ts
├── gemini-cli/           # OAuth 認證 (gemini CLI client)
│   ├── constants.ts      # CLIENT_ID, REDIRECT_URI
│   ├── gemini/
│   │   └── oauth.ts      # authorizeGemini(), exchangeGemini()
│   └── plugin/
│       ├── index.ts
│       ├── token.ts
│       └── types.ts
└── antigravity/          # OAuth 認證 (antigravity client)
    ├── constants.ts      # CLIENT_ID, REDIRECT_URI
    └── plugin/
        ├── index.ts
        ├── token.ts
        └── transform/
            ├── gemini.ts
            ├── claude.ts
            └── cross-model-sanitizer.ts
```

### 1.3 Admin TUI

**職責**：統一的帳號管理與模型選擇介面

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TUI Command Mapping                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  origin/dev 原生:                                                        │
│  ┌──────────────┐    ┌──────────────┐                                   │
│  │  /models     │    │  /provider   │                                   │
│  │ (model選擇)  │    │ (認證新增)   │                                   │
│  └──────────────┘    └──────────────┘                                   │
│         │                   │                                            │
│         └───────┬───────────┘                                            │
│                 │ 整合                                                   │
│                 ▼                                                        │
│  cms 新增:                                                              │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                        /admin                                   │     │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │     │
│  │  │ Favorites  │  │ Recents    │  │ Providers  │  │ Models   │ │     │
│  │  │ (快捷模型) │  │ (最近使用) │  │ (多帳號)   │  │ (完整列) │ │     │
│  │  └────────────┘  └────────────┘  └────────────┘  └──────────┘ │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  遺留/刪除:                                                             │
│  ┌──────────────┐                                                       │
│  │  /accounts   │  ← 刪除 (功能已整合到 /admin)                         │
│  └──────────────┘                                                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**設計原則**：

- `/models` - origin/dev 原生，保持不變
- `/provider` - origin/dev 原生，保持不變
- `/admin` - cms 新增，整合所有管理功能
- `/accounts` - 刪除（遺留產物，已整合到 /admin）

```
src/cli/cmd/tui/component/
└── dialog-admin.tsx      # 三層導航 TUI
```

**三層架構**：

1. **Root** - Favorites / Recents / Provider Families
2. **Accounts** - 該 family 的帳號列表與管理
3. **Models** - 該帳號可用的模型列表

**UI 預覽**：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Admin Control Panel                          │
├─────────────────────────────────────────────────────────────────┤
│ ⭐ Favorites                                                    │
│ 🕐 Recents                                                      │
├─────────────────────────────────────────────────────────────────┤
│ 📂 Anthropic          1 account                              ● │
│ 📂 OpenAI             2 accounts                             ● │
│ 📂 Google (API Key)   1 account                              ● │
│ 📂 Gemini CLI         1 account                              ● │
│ 📂 Antigravity        2 accounts                             ● │
│    ├── account-1@gmail.com                                   ● │
│    └── account-2@gmail.com                           ⏳ 5m     │
└─────────────────────────────────────────────────────────────────┘
  [a] Add  [d] Delete  [Space] Toggle Active  [Enter] Select Model
```

---

## 二、Auth 系統統一

### 2.0 分支差異對照

| 項目      | origin/dev             | cms                        |
| --------- | ---------------------- | -------------------------- |
| Auth 儲存 | `auth.json` (扁平)     | `accounts.json` (結構化)   |
| 多帳號    | ❌ 單帳號              | ✅ 每 provider 多帳號      |
| 認證 API  | `Auth.get/set/remove`  | `Account.*` + Auth wrapper |
| TUI       | `/provider` (新增認證) | `/admin` (完整管理)        |
| 遷移邏輯  | 無                     | 自動遷移 auth.json         |

### 2.1 問題根源

目前存在雙重儲存：

- `auth.json` (舊版) - 扁平格式
- `accounts.json` (新版) - 結構化多帳號格式

`Auth.get()` 會先查 accounts.json，找不到時 fallback 到 auth.json，造成認證混亂。

### 2.2 解決方案：單一來源原則

**accounts.json 是唯一的 credential 儲存**，完全移除 auth.json 的讀取邏輯。

### 2.3 實作步驟

#### Step 1：新增強制遷移函數

**檔案**：`src/account/index.ts`

```typescript
export async function forceFullMigration(): Promise<boolean> {
  const { Global } = await import("../global")
  const authPath = path.join(Global.Path.data, "auth.json")
  const file = Bun.file(authPath)

  if (!(await file.exists())) {
    return false
  }

  try {
    const authData = await file.json()
    const storage = await state()
    let migrated = false

    for (const [providerID, auth] of Object.entries(authData as Record<string, any>)) {
      const family = parseFamily(providerID)

      if (!storage.families[family]) {
        storage.families[family] = { accounts: {} }
      }

      // 若該 family 已有帳號則跳過
      if (Object.keys(storage.families[family].accounts).length > 0) continue

      if (auth.type === "api") {
        const accountId = generateId(family, "api", "default")
        storage.families[family].accounts[accountId] = {
          type: "api",
          name: "Default",
          apiKey: auth.key,
          addedAt: Date.now(),
        }
        storage.families[family].activeAccount = accountId
        migrated = true
      } else if (auth.type === "oauth") {
        const slug = auth.email || auth.accountId || "default"
        const accountId = generateId(family, "subscription", slug)
        storage.families[family].accounts[accountId] = {
          type: "subscription",
          name: slug,
          email: auth.email,
          refreshToken: auth.refresh,
          accessToken: auth.access,
          expiresAt: auth.expires,
          accountId: auth.accountId,
          addedAt: Date.now(),
        }
        storage.families[family].activeAccount = accountId
        migrated = true
      }
    }

    if (migrated) {
      await save(storage)
    }

    // 備份並刪除 auth.json
    const backupPath = path.join(Global.Path.data, "auth.json.migrated")
    await Bun.write(backupPath, await file.text())
    await unlink(authPath)

    log.info("auth.json migrated to accounts.json", { backup: backupPath })
    return true
  } catch (e) {
    log.error("Failed to migrate auth.json", { error: e })
    return false
  }
}
```

#### Step 2：啟動時執行遷移

**檔案**：`src/project/bootstrap.ts`

```typescript
export async function InstanceBootstrap() {
  // 在所有初始化之前強制遷移
  const { Account } = await import("../account")
  await Account.forceFullMigration()

  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  // ... 其餘不變
}
```

#### Step 3：移除 Auth.get() 的 legacy fallback

**檔案**：`src/auth/index.ts`

簡化 `get()` 函數，移除 auth.json fallback：

```typescript
export async function get(providerID: string): Promise<Info | undefined> {
  const { Account } = await import("../account")

  // 精確匹配
  const exactMatch = await Account.getById(providerID)
  if (exactMatch) {
    return accountToAuth(exactMatch.info)
  }

  // Antigravity 簡化 ID 匹配
  if (providerID.startsWith("antigravity-") && !providerID.includes("subscription")) {
    const antigravityAccounts = await Account.list("antigravity")
    for (const [id, info] of Object.entries(antigravityAccounts)) {
      if (info.type === "subscription" && info.email) {
        const username = info.email.split("@")[0]
        if (`antigravity-${username}` === providerID) {
          return accountToAuth(info)
        }
      }
    }
  }

  // 取得該 family 的 active account
  const family = parseFamily(providerID)
  const activeInfo = await Account.getActiveInfo(family)
  if (activeInfo) {
    return accountToAuth(activeInfo)
  }

  return undefined
}
```

---

## 三、跨模型相容性處理

### 3.1 問題：Thinking Signature 污染

- Gemini 使用 `thoughtSignature`、`thinkingMetadata` 存於 `metadata.google`
- Claude 使用 `signature` 存於 thinking block 頂層
- 切換模型時，外來 signature 會造成驗證失敗

### 3.2 解決方案

在 `LLM.stream()` 入口點套用 cross-model sanitization，最大程度相容 origin/dev：

**檔案**：`src/session/llm.ts`

```typescript
import {
  sanitizeCrossModelPayloadInPlace,
  getModelFamily,
} from "../plugin/antigravity/plugin/transform/cross-model-sanitizer"

// 在建構 request payload 後、送出前
const targetFamily = getModelFamily(input.model.id)
if (targetFamily !== "unknown") {
  sanitizeCrossModelPayloadInPlace(requestPayload, { targetModel: input.model.id })
}
```

此方案的優點：

- 不修改 origin/dev 的 SDK 核心邏輯
- 在統一入口點處理，覆蓋所有 subagent 請求
- cross-model-sanitizer 已存在於 antigravity plugin，只需重用

---

## 四、Rate Limit 處理策略

### 4.1 行為設計

當偵測到 rate limit 時：

1. **Toast 通知使用者**：顯示目前模型已達上限
2. **自動切換模型**：依照 Favorites 順序嘗試下一個可用模型
3. **若所有 Favorites 皆不可用**：提示使用者手動選擇

### 4.2 Google Provider 內部 Fallback

對於 Gemini 模型，優先在 Google Provider Suite 內部輪替：

```typescript
// Google Provider 智慧選擇器
async function selectBestGoogleProvider(): Promise<string> {
  const accounts = await Account.listAll()

  // 1. 優先 Antigravity（多帳號、自動輪替）
  const agAccounts = accounts.families["antigravity"]?.accounts || {}
  const agAvailable = Object.values(agAccounts).find(
    (acc) => acc.type === "subscription" && (!acc.coolingDownUntil || acc.coolingDownUntil < Date.now()),
  )
  if (agAvailable) return "antigravity"

  // 2. Fallback 到 Gemini CLI
  const gcAccounts = accounts.families["gemini-cli"]?.accounts || {}
  if (Object.keys(gcAccounts).length > 0) return "gemini-cli"

  // 3. 最後使用 API Key
  const apiAccounts = accounts.families["google"]?.accounts || {}
  if (Object.keys(apiAccounts).length > 0) return "google"

  throw new Error("No available Google provider")
}
```

### 4.3 跨 Provider Fallback（Favorites 順序）

**檔案**：`src/session/llm.ts` (或 rate-limit handler)

```typescript
async function handleRateLimit(currentModel: string): Promise<string | null> {
  const favorites = await Favorites.list()
  const currentIndex = favorites.findIndex((f) => f.modelId === currentModel)

  // 嘗試 Favorites 中的下一個模型
  for (let i = currentIndex + 1; i < favorites.length; i++) {
    const candidate = favorites[i]
    if (await isModelAvailable(candidate.modelId)) {
      toast.info(`Rate limited. Switching to ${candidate.name}`)
      return candidate.modelId
    }
  }

  // 從頭嘗試
  for (let i = 0; i < currentIndex; i++) {
    const candidate = favorites[i]
    if (await isModelAvailable(candidate.modelId)) {
      toast.info(`Rate limited. Switching to ${candidate.name}`)
      return candidate.modelId
    }
  }

  toast.error("All favorite models rate limited")
  return null
}
```

---

## 五、Patch 策略

### 5.1 原則

由於 origin/dev 持續變動，cms 模組需盡可能獨立，patch 時將 origin/dev 關鍵程式碼導向至 cms 版。

### 5.2 需要 Patch 的 origin/dev 檔案

| 檔案                       | 修改內容                      |
| -------------------------- | ----------------------------- |
| `src/auth/index.ts`        | 導向至 Account 模組           |
| `src/project/bootstrap.ts` | 加入遷移呼叫                  |
| `src/session/llm.ts`       | 加入 cross-model sanitization |
| `src/cli/cmd/model.ts`     | 導向至 `/admin`               |

### 5.3 新增的 cms 專屬檔案

| 檔案                                         | 說明                     |
| -------------------------------------------- | ------------------------ |
| `src/account/index.ts`                       | 多帳號管理核心           |
| `src/account/types.ts`                       | 型別定義                 |
| `src/cli/cmd/admin.ts`                       | /admin 指令註冊          |
| `src/cli/cmd/tui/component/dialog-admin.tsx` | Admin TUI                |
| `src/plugin/gemini-cli/*`                    | Gemini CLI OAuth plugin  |
| `src/plugin/antigravity/*`                   | Antigravity OAuth plugin |

---

## 六、驗證清單

### 6.1 遷移測試

```bash
# 確認 auth.json 存在
ls ~/.local/share/opencode/auth.json

# 執行 opencode
opencode

# 確認已遷移
ls ~/.local/share/opencode/auth.json.migrated  # 應存在
ls ~/.local/share/opencode/auth.json           # 應不存在
```

### 6.2 功能測試

- [ ] `/admin` 顯示所有 provider families
- [ ] 各 provider 帳號新增/刪除/切換正常
- [ ] anthropic、openai、google-api 認證正常
- [ ] gemini-cli OAuth 流程完整
- [ ] antigravity OAuth 流程完整
- [ ] 跨模型切換無 signature 錯誤
- [ ] Rate limit 時自動切換 Favorites

### 6.3 Subagent 測試

- [ ] 父 session 使用 Claude，子 session 使用 Gemini：無格式錯誤
- [ ] 父 session 使用 Gemini，子 session 使用 Claude：無格式錯誤
- [ ] 認證資訊在 parent/child session 間一致

---

## 七、時程與優先序

### Phase 1：Auth 統一 (高優先) ✅ 已完成

1. ✅ Account 模組實作
2. ✅ forceFullMigration() 實作
3. ✅ Bootstrap 整合
4. ✅ Auth.get() 簡化 (移除 legacy fallback)

### Phase 2：跨模型相容 (高優先) ✅ 已完成

1. ✅ cross-model-sanitizer 實作
2. ✅ LLM.stream() 整合 (在 antigravity request 層)

### Phase 3：全域帳號輪替機制 (高優先) ✅ 已完成

> 目標：將 Antigravity 的輪替邏輯抽象為全域 Account 層級功能

1. ✅ 從 antigravity/plugin/rotation.ts 抽取核心邏輯
   - 新增 `src/account/rotation.ts`
   - `HealthScoreTracker` - 帳號健康度追蹤（ID-based）
   - `RateLimitTracker` - Rate limit 狀態追蹤
   - `selectBestAccount()` - 混合策略選擇演算法
2. ✅ 在 Account 模組新增輪替 API
   - `Account.getNextAvailable(family, provider, model)`
   - `Account.recordRateLimit(accountId, provider, reason, backoffMs)`
   - `Account.recordSuccess(accountId)`
   - `Account.recordFailure(accountId)`
   - `Account.isRateLimited(accountId, provider, model)`
   - `Account.getMinWaitTime(family, provider, model)`
   - `Account.getRotationStatus(family, provider)`
3. ✅ 在 LLM.stream() 整合 Rate Limit 偵測與自動切換
   - `onError` callback 自動偵測 429 錯誤
   - 自動記錄 health score 與 rate limit 狀態
   - `LLM.recordSuccess()` 供成功請求呼叫
   - `LLM.handleRateLimitFallback()` 供 session 層呼叫
4. ✅ Favorites 順序優先
   - 從 `model.json` 讀取 favorites 列表
   - 依序嘗試 favorites 中的可用模型
5. ✅ Toast 通知
   - 在 `LLM.stream()` 的 `onError` 中發布 `TuiEvent.ToastShow`
   - 顯示 rate limit 原因與等待時間

### Phase 4：TUI 完善 (中優先) ✅ 完成

1. ✅ Level 1 (Root) 實作
2. ✅ Level 2 (Accounts) 實作
3. ✅ Level 3 (Models) 實作
4. ✅ origin/dev `/models` 導向至 `/admin`
   - 在 `app.tsx` 中將 `/models` 指令的 `onSelect` 改為開啟 `<DialogAdmin />`

---

## 八、風險與緩解

| 風險                            | 緩解措施                       |
| ------------------------------- | ------------------------------ |
| 遷移失敗導致無法登入            | 保留 auth.json.migrated 備份   |
| origin/dev 大幅變動             | 模組盡量獨立，減少耦合         |
| Cross-model sanitization 不完整 | 增加單元測試覆蓋               |
| Rate limit 偵測不準確           | 依 HTTP status code 判斷 (429) |

---

## 九、origin/dev 合併計畫 (2026-02-01)

### 9.1 分支差異總覽

| 區域                 | origin/dev                         | cms                                            | 合併策略                                |
| -------------------- | ---------------------------------- | ---------------------------------------------- | --------------------------------------- |
| plugin/index.ts      | `Instance.state()` 快取, port 4096 | `_loading` Promise, port 1080, 額外函數        | 採用 origin/dev 結構，保留 cms 內部插件 |
| plugin/ 目錄         | 只有 codex, copilot                | 額外有 antigravity/, gemini-cli/, anthropic.ts | 保留 cms 獨有模組                       |
| auth/index.ts        | 簡單 auth.json 讀寫                | 複雜 Account 模組整合                          | **保留 cms 版本**                       |
| account/index.ts     | ❌ 不存在                          | ✅ 多帳號管理                                  | **保留 cms 版本**                       |
| provider/provider.ts | 無 ANTIGRAVITY 相關                | ANTIGRAVITY_WHITELIST, IGNORED_MODELS          | 合併 origin/dev 更新，保留 cms 獨有邏輯 |
| TUI 元件             | 標準版                             | dialog-admin, dialog-account 等                | **保留 cms 版本**                       |

### 9.2 關鍵檔案合併計畫

#### A. plugin/index.ts

```
origin/dev 變更：
- Instance.state() 取代手動 Promise 快取
- baseUrl: "http://localhost:4096"

cms 需保留：
- AntigravityOAuthPlugin, AntigravityLegacyOAuthPlugin, GeminiCLIOAuthPlugin 導入
- discoverModels(), getAuth() 函數

合併方式：
1. 採用 origin/dev 的 Instance.state() 結構
2. 修改 INTERNAL_PLUGINS 加入 cms 插件
3. 保留 discoverModels(), getAuth() 函數
```

#### B. provider/provider.ts

```
origin/dev 變更：
- SDK 路徑: "./sdk/copilot" 取代 "./sdk/openai-compatible/src"
- process.env 直接存取 (AWS_BEARER_TOKEN_BEDROCK, AICORE_SERVICE_KEY)
- getModel() 加入 languageModel fallback
- 移除 npm 動態解析 (github-copilot -> @ai-sdk/github-copilot)

cms 需保留：
- ANTIGRAVITY_WHITELIST
- IGNORED_MODELS, IGNORED_DYNAMIC
- loadIgnoredDynamic(), isModelIgnored() 函數
- gemini-cli CUSTOM_LOADER
- Account import

合併方式：
1. 採用 origin/dev 的新 SDK 路徑
2. 保留 cms 的 ANTIGRAVITY 相關邏輯
3. 合併 process.env 變更
4. 保留 gemini-cli CUSTOM_LOADER
```

#### C. auth/index.ts

```
保留 cms 版本 - 不合併 origin/dev 變更
原因：cms 的 Account 模組是核心功能，origin/dev 簡化版不適用
```

### 9.3 Anthropic OAuth 問題分析

**問題**：「This credential is only authorized for use with Claude Code」

**根本原因**：
npm 套件 `opencode-anthropic-auth@0.0.13` 的 user-agent 設定錯誤：

- 套件設定：`user-agent: claude-cli/2.1.2 (external, cli)`
- 正確設定：`user-agent: anthropic-claude-code/0.5.1`

**注意**：origin/dev 也使用相同 npm 套件版本，**同樣會有此問題**

**解決方案選項**：

| 方案               | 優點     | 缺點                         |
| ------------------ | -------- | ---------------------------- |
| A. Patch npm cache | 立即生效 | 非持久性，bun install 會覆蓋 |
| B. Fork npm 套件   | 長期解決 | 需要維護自己的 fork          |
| C. 內部插件覆寫    | cms 可控 | 需確保不與 npm 衝突          |
| D. 回報上游修復    | 根本解決 | 等待時間不確定               |

**建議方案**：C - 建立 cms 內部 anthropic 插件，完全覆寫 npm 套件行為

### 9.4 合併執行步驟

```bash
# Step 1: 建立合併分支
git checkout cms
git checkout -b cms-merge-dev

# Step 2: Cherry-pick 或手動合併 origin/dev 變更
# 針對每個檔案個別處理，避免覆蓋 cms 獨有功能

# Step 3: 測試
bun run build
bun run test

# Step 4: 合併回 cms
git checkout cms
git merge cms-merge-dev
```

### 9.5 優先順序

1. **高優先**：修復 Anthropic OAuth (方案 C)
2. **中優先**：合併 provider.ts 的 SDK 路徑修正
3. **低優先**：合併 plugin/index.ts 結構優化

---

# Feature: Production binary build and Docker deployment

## Requirements

- Build the latest opencode binary artifacts for the linux/amd64 and linux/arm64 musl baselines.
- Regenerate any dependent SDK outputs so clients stay in sync with the new API surface.
- Run the required automated tests to validate the release candidate before packaging.
- Package the binaries into the provided production Docker image(s) and verify the runtime behavior locally.

## Scope

- IN: `bun test`, SDK regeneration via `packages/sdk/js/script/build.ts`, `bun run build`, Docker image builds for amd64 and arm64, and local verification of the resulting images.
- OUT: pushing images to any external registry, deploying to an orchestrator, or modifying unrelated services.

## Approach

- Regenerate the SDK client artifacts from the current `opencode` OpenAPI spec so they reflect the latest interfaces.
- Run the existing test suite to ensure no regressions before creating new binaries.
- Execute `bun run build` to create the linux/x64 and linux/arm64 musl binaries required by the Dockerfile.
- Build the Docker images twice (one per target arch) using the multi-stage `Dockerfile`, tagging them for local verification.
- Run the newly built image(s) with `--version` to confirm the bundled binary starts correctly.

## Tasks

1. [ ] Run `bun test` (and any other pre-build validation) to confirm the codebase is stable.
2. [ ] Execute `packages/sdk/js/script/build.ts` from the sdk package to regenerate the client SDK outputs.
3. [ ] Run `bun run build` inside `packages/opencode` to compile the linux/amd64 and linux/arm64 binaries, ensuring the `dist/.../bin/opencode` files exist.
4. [ ] Build the Docker images for `linux/amd64` and `linux/arm64` using `docker build` with the `TARGETARCH` build arg, tagging them (e.g., `opencode:prod-amd64` and `opencode:prod-arm64`).
5. [ ] Validate the images by running each container with `opencode --version` to ensure the binary launches.

## Open Questions

- None at this time; proceeding with the above steps unless new blockers emerge.

---

# 十、Provider 架構改進計畫

> 根據 upstream commits 的設計分析，提出以下架構改進方向，減少硬編碼判斷、提升可維護性。

## 10.1 問題現況

### A. Provider 特殊處理散落各處

目前 `llm.ts` 中有大量 provider-specific 的條件判斷：

```typescript
// 第 86-89 行
const isCodex = provider.id.includes("openai") && auth?.type === "oauth"
const isAnthropicOAuth = provider.id.includes("anthropic") && auth?.type === "oauth"
const isAntigravity = provider.id.includes("antigravity")
const isGeminiCli = provider.id.includes("gemini-cli")

// 第 96, 138, 175, 207 行都有使用
if (isCodex || isAnthropicOAuth || isAntigravity || isGeminiCli) { ... }
```

**問題**：

- 新增 provider 需要修改多處
- 邏輯分散難以追蹤
- 字串匹配容易出錯

### B. Model ID 嗅探 (Sniffing)

`transform.ts` 中用字串匹配判斷 model 類型：

```typescript
// 第 395-410 行
if (
  model.providerID === "anthropic" ||
  model.api.id.includes("anthropic") ||
  model.api.id.includes("claude") ||
  model.id.includes("anthropic") ||
  model.id.includes("claude")
) { ... }
```

**問題**：

- 非 Claude 但 ID 包含 "claude" 的 model 會誤判
- LiteLLM/proxy 的 model ID 格式不統一
- 難以處理新 model family

### C. 參數格式不一致

不同 SDK/API 對相同概念使用不同參數名：

| 概念            | @ai-sdk/anthropic   | @ai-sdk/openai-compatible | Bedrock           |
| --------------- | ------------------- | ------------------------- | ----------------- |
| Thinking budget | `budgetTokens`      | `budget_tokens`           | `budgetTokens`    |
| Cache point     | `cacheControl.type` | `cache_control.type`      | `cachePoint.type` |

---

## 10.2 改進方案

### 方案 A：Provider Capability 抽象化

建立統一的 Provider 能力描述介面：

```typescript
// src/provider/capabilities.ts
export interface ProviderCapabilities {
  // 訊息處理
  systemMessageRole: "system" | "user" | "developer"
  useInstructionsOption: boolean

  // 參數格式
  parameterCase: "camelCase" | "snake_case"
  thinkingParamName: "budgetTokens" | "budget_tokens"

  // Cache 策略
  cacheLevel: "message" | "content"
  cacheType: "ephemeral" | "default"

  // 認證類型
  authTypes: ("api" | "oauth" | "subscription")[]

  // 特殊行為
  supportsStreaming: boolean
  supportsToolCalling: boolean
  requiresMaxTokens: boolean
}

export function getCapabilities(provider: Provider.Info, auth?: Auth.Info): ProviderCapabilities {
  // 根據 provider.id 和 auth.type 返回對應能力描述
  // 集中管理，不再散落各處
}
```

**優點**：

- 集中管理 provider 特性
- 新增 provider 只需擴展 capabilities
- 減少條件判斷分散

### 方案 B：Model Family 標籤系統

在 model 定義時明確標記 family，而非 ID 嗅探：

```typescript
// models.dev 或 config 中的 model 定義
{
  id: "claude-sonnet-4-20250514",
  family: "claude",           // 明確標記
  capabilities: {
    thinkingFormat: "budgetTokens",
    reasoning: true,
  }
}
```

**優點**：

- 不依賴字串匹配
- 支援 proxy/LiteLLM 的自定義 model
- 可在 config 中覆寫

### 方案 C：Options Transformer Pipeline

建立統一的參數轉換管道：

```typescript
// src/provider/options-transformer.ts
export class OptionsTransformer {
  private transformers: OptionTransformFn[] = []

  register(fn: OptionTransformFn) {
    this.transformers.push(fn)
  }

  transform(options: Record<string, any>, context: TransformContext) {
    return this.transformers.reduce((opts, fn) => fn(opts, context), options)
  }
}

// 各 provider 註冊自己的轉換器
transformer.register(anthropicThinkingTransformer)
transformer.register(bedrockCacheTransformer)
transformer.register(openaiCompatibleCaseTransformer)
```

**優點**：

- 轉換邏輯可組合
- 每個 provider 獨立維護
- 易於測試

---

## 10.3 實作計畫

### Phase 1：Provider Capabilities 抽象化 (高優先)

- [ ] 建立 `src/provider/capabilities.ts` 介面定義
- [ ] 實作 `getCapabilities()` 函數，覆蓋現有 provider
- [ ] 重構 `llm.ts` 使用 capabilities 取代硬編碼判斷
- [ ] 移除 `isCodex`, `isAnthropicOAuth`, `isAntigravity`, `isGeminiCli` 變數
- [ ] 更新相關測試

### Phase 2：Model Family 標籤系統 (中優先)

- [ ] 在 `Provider.Model` 介面新增 `family` 欄位
- [ ] 更新 models.dev 解析邏輯，自動推斷 family
- [ ] 允許 config 中覆寫 model family
- [ ] 重構 `transform.ts` 使用 family 取代 ID 嗅探
- [ ] 移除 `model.id.includes("claude")` 等判斷
- [ ] 更新相關測試

### Phase 3：Options Transformer Pipeline (低優先)

- [ ] 建立 `src/provider/options-transformer.ts` 框架
- [ ] 將 `transform.ts` 中的邏輯遷移至 transformer
- [ ] 為每個 SDK 建立獨立的 transformer 模組
- [ ] 支援 plugin 註冊自定義 transformer
- [ ] 更新相關測試

---

## 10.4 預期效益

| 改進項目      | 現況                | 改進後                                 |
| ------------- | ------------------- | -------------------------------------- |
| 新增 provider | 修改 5+ 個檔案      | 只需新增 capabilities 定義             |
| Model 誤判    | 字串匹配可能誤判    | 明確 family 標籤                       |
| 參數轉換      | 散落在 transform.ts | 集中於 transformer pipeline            |
| 測試覆蓋      | 難以單獨測試        | 每個 capability/transformer 可獨立測試 |

---

## 10.5 風險與緩解

| 風險                     | 緩解措施                         |
| ------------------------ | -------------------------------- |
| 重構範圍大，可能引入 bug | 分階段進行，每階段完整測試       |
| 與 origin/dev 分歧加大   | 設計為可選層，不強制依賴         |
| 現有 provider 行為改變   | 保持向後相容，先驗證再移除舊邏輯 |
