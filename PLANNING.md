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

| 項目 | 決策 |
|------|------|
| Provider 設計 | antigravity、gemini-cli 維持獨立 provider |
| Auth 系統 | Patch origin/dev 採用 cms 的 Account 模組 |
| 跨模型相容 | 以最大相容 origin/dev 的方式處理 |
| Rate Limit 處理 | Toast 通知 + 依 Favorites 順序自動切換 |
| TUI 設計 | `/admin` 完全獨立，origin/dev 導向至 cms 版 |
| 儲存格式 | 統一使用 `accounts.json` |

---

## 一、模組架構

### 1.1 核心模組：Account System

**職責**：統一管理所有 provider 的認證資訊

```
src/account/
├── index.ts          # Account namespace (list, add, remove, setActive, getActiveInfo)
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

| 項目 | origin/dev | cms |
|------|------------|-----|
| Auth 儲存 | `auth.json` (扁平) | `accounts.json` (結構化) |
| 多帳號 | ❌ 單帳號 | ✅ 每 provider 多帳號 |
| 認證 API | `Auth.get/set/remove` | `Account.*` + Auth wrapper |
| TUI | `/provider` (新增認證) | `/admin` (完整管理) |
| 遷移邏輯 | 無 | 自動遷移 auth.json |

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
import { sanitizeCrossModelPayloadInPlace, getModelFamily } from "../plugin/antigravity/plugin/transform/cross-model-sanitizer"

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
    acc => acc.type === "subscription" &&
           (!acc.coolingDownUntil || acc.coolingDownUntil < Date.now())
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
  const currentIndex = favorites.findIndex(f => f.modelId === currentModel)

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

| 檔案 | 修改內容 |
|------|----------|
| `src/auth/index.ts` | 導向至 Account 模組 |
| `src/project/bootstrap.ts` | 加入遷移呼叫 |
| `src/session/llm.ts` | 加入 cross-model sanitization |
| `src/cli/cmd/model.ts` | 導向至 `/admin` |

### 5.3 新增的 cms 專屬檔案

| 檔案 | 說明 |
|------|------|
| `src/account/index.ts` | 多帳號管理核心 |
| `src/account/types.ts` | 型別定義 |
| `src/cli/cmd/admin.ts` | /admin 指令註冊 |
| `src/cli/cmd/tui/component/dialog-admin.tsx` | Admin TUI |
| `src/plugin/gemini-cli/*` | Gemini CLI OAuth plugin |
| `src/plugin/antigravity/*` | Antigravity OAuth plugin |

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

### Phase 1：Auth 統一 (高優先)
1. ✅ Account 模組實作
2. ⬜ forceFullMigration() 實作
3. ⬜ Bootstrap 整合
4. ⬜ Auth.get() 簡化

### Phase 2：跨模型相容 (高優先)
1. ✅ cross-model-sanitizer 實作
2. ⬜ LLM.stream() 整合

### Phase 3：Rate Limit Fallback (中優先)
1. ⬜ Favorites 順序讀取
2. ⬜ 自動切換邏輯
3. ⬜ Toast 通知

### Phase 4：TUI 完善 (中優先)
1. ✅ Level 1 (Root) 實作
2. ✅ Level 2 (Accounts) 實作
3. ⬜ Level 3 (Models) 實作
4. ⬜ origin/dev `/model` 導向

---

## 八、風險與緩解

| 風險 | 緩解措施 |
|------|----------|
| 遷移失敗導致無法登入 | 保留 auth.json.migrated 備份 |
| origin/dev 大幅變動 | 模組盡量獨立，減少耦合 |
| Cross-model sanitization 不完整 | 增加單元測試覆蓋 |
| Rate limit 偵測不準確 | 依 HTTP status code 判斷 (429) |
