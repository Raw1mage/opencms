# Design: MCP 管理層重構 — App 擴充性標準化

## 定位

本計畫的本質不是「拆硬編碼」，而是 **建立 MCP App 的標準化擴充介面**。硬編碼拆離只是第一步。

最終目標：使用者透過對話告訴 AI「把某個功能加進來」，系統就能自動完成取得、安裝、驗證、註冊全流程，新 App 即時出現在應用市場 UI 卡片中。

---

## 架構分層

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Conversational Provisioning                   │
│  "把 GitHub 上那個加進來當 MCP server"                    │
│  → system-manager.install_mcp_app tool                  │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Registry & Lifecycle                          │
│  mcp-apps.json + Admin UI + enable/disable/remove       │
│  → 統一管理所有 App 的生命週期                             │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Package Convention                            │
│  mcp.json manifest + stdio command 標準                  │
│  → 定義「什麼是一個合法的 MCP App 檔案包」                  │
├─────────────────────────────────────────────────────────┤
│  Layer 0: Hardcode Extraction                           │
│  BUILTIN_CATALOG + managedAppExecutors 移除              │
│  → 讓內建 App 也遵循 Package Convention                   │
├─────────────────────────────────────────────────────────┤
│  Foundation: System User & Permissions                  │
│  opencode nologin 帳號 + /opt/opencode-apps/ 權限        │
│  → 系統級 App 安裝目錄的前置基礎建設                        │
└─────────────────────────────────────────────────────────┘
```

**設計方向是由上往下**：Layer 3 的使用情境決定 Layer 1 的規格。

---

## 決策總表

| DD | 決策 | 理由 |
|----|------|------|
| DD-1 | App 預設關閉，AI 自行判斷何時需要啟動 | 不靠關鍵字硬配，讓 AI 根據對話情境決定。App 在系統提示詞中列出可用清單即可 |
| DD-2 | 安裝目錄：`/opt/opencode-apps/<id>/` | 系統共用，所有使用者共享安裝成果 |
| DD-3 | mcp-apps.json 兩層：`/etc/opencode/`（系統）+ `~/.config/opencode/`（使用者），系統優先 | 管理員預裝的系統級 App 優先，使用者可自行擴充但不會覆蓋系統設定 |
| DD-4 | 建立 opencode 系統帳號用於**檔案歸屬隔離**，gateway 保持 root 執行 | Gateway 需要 PAM + setuid，必須 root。但系統檔案（/opt/opencode-apps/、/etc/opencode/）歸屬 opencode:opencode，實現部署到客戶系統時的權限邊界。gateway 以 root 身份寫入這些目錄時，設定檔案 owner 為 opencode |
| DD-5 | Step 6 用 TypeScript + `bun build --compile` 產生零依賴單一執行檔 | 避免 dependency hell，現有程式碼只需包 MCP server 外殼，不用重寫 |
| DD-6 | 交付範圍 Step 0-6 全做 | 包含系統帳號建置（Step 0）與 Gmail/Calendar 獨立化（Step 6） |

---

## Foundation: System User & File Ownership Isolation（Step 0）

### 權限模型（DD-4）

**兩個角色，各司其職：**

- **opencode 系統帳號**：不登入、不執行程式，純粹作為**檔案擁有者**。所有 opencode 產品部署到客戶系統的檔案都歸屬這個帳號，跟系統其他 root 檔案有明確的權限邊界。
- **gateway（root）**：繼續以 root 執行（PAM + setuid 需要），但寫入檔案時將 owner 設為 `opencode:opencode`。

**客戶系統上的效果：**
```
$ ls -la /opt/opencode-apps/
drwxr-xr-x  opencode opencode  gmail/
drwxr-xr-x  opencode opencode  drawmiat/

$ ls -la /etc/opencode/
-rw-r--r--  opencode opencode  mcp-apps.json
-rw-r--r--  opencode opencode  opencode.cfg
-rw-rw-r--  opencode opencode  google-bindings.json
```
管理員一眼就能分辨「這些是 opencode 的東西」。

**目錄權限：**

| 路徑 | 擁有者 | 權限 | 用途 |
|------|--------|------|------|
| `/opt/opencode-apps/` | `opencode:opencode` | 755 | App 安裝目錄 |
| `/etc/opencode/` | `opencode:opencode` | 755 | 系統級設定 |
| `/etc/opencode/mcp-apps.json` | `opencode:opencode` | 644 | App 登記清單 |
| `/var/log/opencode/` | `opencode:opencode` | 755 | 系統日誌 |

**寫入流程：**
- **system-level 寫入**：system-manager 呼叫 sudo wrapper（`/usr/local/bin/opencode-app-install`）→ 以 root 執行 clone / 寫入 → chown opencode:opencode。
- **user-level 寫入**：per-user daemon 直接寫入 `~/.config/opencode/mcp-apps.json`（本來就有權限）。

---

## Layer 1: Package Convention（檔案包規格）

### 什麼是一個 MCP App 檔案包

一個目錄，包含一個 `mcp.json` manifest 和可執行的 MCP server。

```
my-app/
  mcp.json          ← 必要：manifest 描述
  (server 實作)      ← 任意語言、任意結構，由 mcp.json.command 指定啟動方式
```

### mcp.json Schema

```json
{
  "id": "my-app",
  "name": "My App",
  "description": "What this app does",
  "version": "1.0.0",
  "icon": "🔧",

  "command": ["python", "-u", "server.py"],
  "env": {
    "SOME_VAR": "value"
  },

  "auth": {
    "type": "none"
  },

  "source": {
    "type": "github",
    "repo": "owner/repo",
    "ref": "main"
  }
}
```

**最小必填**：`id`, `name`, `command`

**工具清單不寫在 manifest 裡** — 由 runtime 透過 MCP 協議的 `tools/list` 動態取得（probe 時存入 mcp-apps.json 的 `entry.tools`）。Manifest 只負責「我是誰、怎麼啟動我」，不負責「我能做什麼」。

### settings schema（統一設定介面）

每個 App 可以在 mcp.json 中宣告自己需要的設定欄位。系統在 App 卡片上顯示齒輪圖示，點開後根據 schema 自動渲染表單。

```json
{
  "settings": {
    "fields": [
      {
        "key": "maxResults",
        "label": "Default max results",
        "type": "number",
        "default": 10,
        "required": false,
        "description": "Maximum items returned per query"
      },
      {
        "key": "timeZone",
        "label": "Time zone",
        "type": "string",
        "default": "Asia/Taipei",
        "required": false
      }
    ]
  }
}
```

**type 支援**：`string`、`number`、`boolean`、`select`（含 `options`）

**設定值儲存**：寫入 mcp-apps.json 的 `entry.config` 欄位，runtime 啟動 App 時以環境變數注入（key 大寫化，如 `maxResults` → `MCP_APP_MAX_RESULTS`）。

**齒輪按鈕行為**：
1. 卡片右上角永遠顯示齒輪圖示（只要 App 有 `auth` 或 `settings` 欄位）
2. 點擊 → 開啟設定面板（Dialog）
3. 面板分區：Auth 區（OAuth connect 按鈕 / API key 輸入）+ Config 區（schema 驅動表單）

### auth 類型

| type | 說明 | token 來源 |
|------|------|-----------|
| `"none"` | 無需認證 | — |
| `"oauth"` | 需要 OAuth token | `accounts.json[provider]`，由 runtime 注入 env |
| `"api-key"` | 需要 API key | `accounts.json[provider]`，由 runtime 注入 env |

```json
{
  "auth": {
    "type": "oauth",
    "provider": "google",
    "tokenEnv": "GOOGLE_ACCESS_TOKEN",
    "scopes": ["https://www.googleapis.com/auth/calendar"]
  }
}
```

Runtime 在啟動 App 時，根據 auth.provider 找到對應的 token 來源，注入到 `tokenEnv` 指定的環境變數。App server 從 env 讀取 token，不需要知道 token 從哪來。

### Auth 流程（以 Google OAuth 為藍本）

**現有基礎**：系統已有完整的 Google OAuth connect/callback 實作（`/api/v2/mcp/apps/{appId}/oauth/connect` 和 `/callback`），token 存於 `~/.config/opencode/gauth.json`。此流程需適配到新的 store app 架構。

**適配方向**：

1. **OAuth connect endpoint 擴充**：現有 endpoint 硬編碼只支援 `google-calendar` 和 `gmail`。需改為讀取 mcp.json 的 `auth` 欄位來判斷 OAuth provider 和 scopes，支援任意 store app。
2. **Token 儲存統一**：目前 Google token 存在 `gauth.json`（provider 專屬）。長期應遷移到 `accounts.json` 的統一結構，但短期先保持 `gauth.json` 相容。
3. **Token refresh**：之前由 `gauth.ts` 在 daemon 內部處理 refresh。現在 App 是獨立行程，兩個選擇：
   - **(A)** daemon 定期 refresh → 重啟 App 注入新 token（需要 App lifecycle 支援 graceful restart）
   - **(B)** App 自己帶 refresh 邏輯（需要把 refresh_token 也注入 env）
   - **建議先走 (B)**：mcp.json 新增 `auth.refreshTokenEnv` 欄位，runtime 同時注入 access_token 和 refresh_token。
4. **UI 流程**：
   - 卡片齒輪 → 設定面板 → Auth 區 → 「Connect Google」按鈕
   - 點擊 → `window.open(oauth/connect)` → Google 授權 → callback → token 存檔 → polling 更新卡片狀態
   - 已認證時顯示認證帳號 email + 「Disconnect」按鈕

### 檔案包偵測（無 mcp.json 時的 fallback 推斷）

當使用者指定一個 GitHub repo 或本機路徑，但目錄中沒有 `mcp.json` 時，系統嘗試 **推斷** 啟動方式：

| 偵測到的檔案 | 推斷的 command |
|-------------|---------------|
| `package.json` 且含 `"bin"` 或 `scripts.start` | `["npx", "."]` 或 `["node", main]` |
| `pyproject.toml` 或 `setup.py` | `["uvx", "."]` 或 `["python", "-m", module]` |
| `requirements.txt` + `server.py` | `["python", "-u", "server.py"]` |
| `Dockerfile` | 提示使用者需要先 build |

推斷成功後，系統自動生成 `mcp.json` 寫入目錄，**並 log.info 告知使用者已自動生成 manifest**。推斷失敗時 **不靜默跳過**，回報明確錯誤讓使用者手動提供 command。

---

## Layer 2: Registry & Lifecycle

### 設定檔：mcp-apps.json（DD-3）

```
/etc/opencode/mcp-apps.json         ← System level（管理員預裝，優先）
~/.config/opencode/mcp-apps.json    ← User level（使用者自行安裝）
```

**合併規則**：Runtime 讀取兩層，系統級優先。同 id 的 App 以系統級為準，使用者級不可覆蓋。

**寫入分流**：
- **system-level**（`/etc/opencode/mcp-apps.json`）：透過 sudo wrapper 寫入。現階段管理者（pkcs12）透過對話安裝的 App 走這條路。
- **user-level**（`~/.config/opencode/mcp-apps.json`）：per-user daemon 直接寫入。未來開放一般使用者自行安裝時走這條路。

```json
{
  "version": 1,
  "apps": {
    "gmail": {
      "path": "/opt/opencode-apps/gmail",
      "enabled": true,
      "installedAt": "2026-04-06T12:00:00Z",
      "source": { "type": "github", "repo": "anthropics/gmail-mcp", "ref": "v1.0.0" }
    },
    "drawmiat": {
      "path": "/home/pkcs12/projects/drawmiat",
      "enabled": false,
      "installedAt": "2026-04-01T08:00:00Z",
      "source": { "type": "local" }
    }
  }
}
```

**每個 entry 只記錄「在哪裡」和「從哪來」。** App 的 metadata（name, description, tools）一律從 `<path>/mcp.json` + stdio `tools/list` 取得。

### 與現有 Config 的關係

```
優先級（高 → 低）：
  mcp-apps.json (System)     ← 新的標準化 App 管理
  mcp-apps.json (User)       ← 未來
  opencode.json.mcp           ← 現有相容層（開發者手動設定的 MCP server）
```

`opencode.json.mcp` 繼續支援，但定位為「開發者手動設定的 raw MCP server」，不進入應用市場 UI。兩者的差異：

| | mcp-apps.json | opencode.json.mcp |
|--|---------------|-------------------|
| 管理方式 | AI tool + UI | 手動編輯 JSON |
| 顯示位置 | 應用市場 App 卡片 | MCP server 列表 |
| Metadata | 從 mcp.json 讀取 | 無 |
| 生命週期 | install → enable → disable → remove | enable / disable |

### App 生命週期狀態機

```
                    install_mcp_app
                         │
                         ▼
  ┌─── [not_installed] ──→ [installed / disabled] ──→ [enabled / connected]
  │                              │     ▲                    │
  │                              │     │ enable              │ disable
  │                              │     └────────────────────┘
  │                              │
  │                              ▼
  │                        [error]  ← 啟動失敗 / command 不存在 / auth 過期
  │                              │
  │                         remove │
  └──────────────────────────────┘
```

### On-Demand 啟動模型（DD-1）

App 預設 **disabled**（安裝後不自動連線）。啟動方式：

1. **AI 自行判斷**：系統提示詞中列出所有已安裝但尚未啟動的 App（id + name + description）。AI 根據對話情境判斷需要哪個 App，透過呼叫 `system-manager.toggle_mcp_app({ id, enabled: true })` 啟動。
2. **使用者手動**：透過 Admin UI 的 enable/disable toggle。
3. **管理員預設**：mcp-apps.json 中可設定 `"enabled": true`，系統啟動時就連線。

不使用關鍵字匹配機制。AI 看得到完整的 App 清單，自己決定什麼時候該叫誰。

### Runtime 啟動流程

```
1. 讀取 mcp-apps.json（兩層合併，系統優先）→ 取得所有已登記 apps
2. 對每個 enabled app:
   a. 讀取 <path>/mcp.json → 驗證 schema
   b. 解析 auth → 從 accounts.json 取 token → 準備 env
   c. spawn command → StdioClientTransport → MCP Client
   d. tools/list → 取得工具清單 → 註冊到 session tool pool
   e. 成功 → status: connected / 失敗 → status: error + log.warn
3. 對每個 disabled app: 只載入 manifest metadata → status: disabled
4. 將所有 app（含 disabled）的清單注入系統提示詞，供 AI 判斷是否需要啟動
5. 合併 opencode.json.mcp 的 server（現有邏輯不變）
```

### Admin UI（應用市場）

**App 卡片元素：**
- icon + name + description（從 mcp.json）
- status badge（connected / disabled / error / pending_auth）
- 工具數量（從 mcp-apps.json 的 `entry.tools`，probe 時存入）
- 來源標示（GitHub repo / local path）
- enable/disable toggle 按鈕
- 齒輪圖示（有 `auth` 或 `settings` 時顯示）→ 開啟設定面板
- remove 按鈕

**齒輪設定面板（Dialog）：**
```
┌─ App Settings: Gmail ──────────────────────┐
│                                             │
│ ── Authentication ──────────────────────── │
│  Provider: Google OAuth                     │
│  Status: ✅ Connected (ivon0829@gmail.com) │
│  [Reconnect]  [Disconnect]                 │
│                                             │
│ ── Configuration ──────────────────────── │
│  Max Results: [10___]                       │
│  Time Zone:   [Asia/Taipei___]              │
│                                             │
│                          [Save]  [Cancel]  │
└─────────────────────────────────────────────┘
```
- Auth 區：根據 mcp.json 的 `auth.type` 渲染
  - `oauth`：顯示 Connect/Reconnect/Disconnect 按鈕 + 認證狀態
  - `api-key`：顯示 API key 輸入框
  - `none`：不顯示此區
- Config 區：根據 mcp.json 的 `settings.fields` 自動渲染表單
- Save：寫入 mcp-apps.json 的 `entry.config`

**新增 App 流程：**
1. 應用市場頂部「+ 新增 App」按鈕
2. Dialog：輸入本機路徑 或 GitHub URL
3. 點擊「Preview」→ POST `/api/v2/mcp/store/apps/preview` → 顯示卡片預覽
4. 確認 → POST `/api/v2/mcp/store/apps` → probe → 寫入 mcp-apps.json
5. 卡片出現在市場中，若有 auth 需求則顯示「需要設定」狀態

---

## Layer 3: Conversational Provisioning

### system-manager 新增 tool

#### `install_mcp_app`

```
使用者: "把 github.com/anthropics/mcp-memory 加進來"
AI calls: system-manager.install_mcp_app({
  source: "https://github.com/anthropics/mcp-memory"
})
```

**Tool 內部 pipeline：**

```
1. 解析 source
   ├─ GitHub URL → git clone → /opt/opencode-apps/<id>/
   └─ 本機路徑   → 驗證存在

2. 讀取 manifest
   ├─ 找到 mcp.json → 驗證 schema
   └─ 未找到        → 嘗試推斷（Layer 1 偵測規則）→ 生成 mcp.json
                       └─ 推斷失敗 → 回報錯誤，要求使用者提供 command

3. 安裝依賴（若需要）
   ├─ package.json  → bun install / npm install
   ├─ requirements.txt → pip install -r
   └─ 無依賴檔     → skip

4. 驗證（Probe）
   → 嘗試 stdio 啟動 → tools/list → 確認能取得工具清單
   → 失敗 → 回報具體錯誤（command not found / timeout / protocol error）

5. 註冊
   → 寫入 mcp-apps.json
   → 通知 runtime 熱載入（Bus event 或 daemon API）

6. 回報
   → 回傳 App 資訊：{ id, name, description, tools: [...], status: "connected" }
```

#### `list_mcp_apps`

回傳所有已安裝 App 的狀態卡片。

#### `remove_mcp_app`

停止 App → 從 mcp-apps.json 移除。不刪除檔案（使用者自行決定）。

#### 現有 `toggle_mcp` 的演進

保留，但重新定位為控制 `opencode.json.mcp` 的 raw server。App 層級的啟停走 `install_mcp_app` / `remove_mcp_app`。

---

## Layer 0: 內建 App 遷移策略

### Gmail / Google Calendar 的路徑

**Phase A（Step 2）：** 內建 App 繼續 in-process 執行，但把 `BUILTIN_CATALOG` 硬編碼抽出為各 App 目錄下的 `manifest.ts`。`managedAppExecutors` 對照表保留。

**Phase B（Step 6，DD-5）：** 將 Gmail/Calendar 改為獨立 stdio MCP server。使用 `bun build --compile` 將現有 TypeScript 程式碼 + MCP server 外殼編譯為**單一零依賴執行檔**，放置於 `/opt/opencode-apps/gmail/gmail-server`、`/opt/opencode-apps/google-calendar/gcal-server`。

```
bun build --compile --target=bun-linux-x64 src/gmail-server.ts --outfile gmail-server
```

**DD-5 的優勢**：
- 現有 API 呼叫邏輯不用重寫（直接 import 現有 client.ts）
- 產出的 binary 不依賴 node_modules，不會跟主程式的依賴衝突
- 部署等同 C binary — 丟一個檔案就能用

### 遷移期的雙軌並存（Step 2 → Step 6 之間）

```
mcp/index.ts:

  外部 App（mcp-apps.json）
    → StdioClientTransport → MCP Client → tools/list → convertMcpTool()
    → 已有完整路徑（現有 MCP server 邏輯）

  內建 App（Step 2 完成 → Step 6 完成之前）
    → manifest.ts import → managedAppExecutors → convertManagedAppTool()
    → Step 6 完成後統一為 stdio，managedAppExecutors 刪除
```

---

## Config 責任分層（完整版）

| 設定檔 | 路徑 | 誰管 | 內容 |
|--------|------|------|------|
| `opencode.json` | `/etc/opencode/` | 系統/開發者 | LLM providers, agents, MCP servers（raw） |
| **`mcp-apps.json`** | `/etc/opencode/` + `~/.config/opencode/` | **system-manager tool / Admin UI** | **MCP App 登記 + 來源追溯（系統級優先）** |
| `accounts.json` | `~/.config/opencode/` | Runtime auto-managed | OAuth tokens, API keys |
| `managed-apps.json` | `~/.config/opencode/` | Runtime auto-managed | App 安裝/啟用狀態（Phase A 保留，Phase B 後由 mcp-apps.json 取代） |

---

## 風險與邊界

| 風險 | 影響 | 緩解 |
|------|------|------|
| **R1: GitHub clone 的安全性** | 使用者可能安裝惡意 MCP server | Probe 階段只做 tools/list，不執行任何 tool；UI 顯示明確警告 |
| **R2: 依賴安裝副作用** | pip/npm install 可能執行 post-install script | 考慮 sandbox 或 dry-run 選項；Phase 1 先只支援已安裝好的本機路徑 |
| **R3: /etc/opencode/ 寫入權限** | per-user daemon 無法直接寫入 system-level 檔案 | DD-4: system-level 寫入透過 sudo wrapper，user-level 由 daemon 直接寫 |
| **R4: OAuth token 注入** | 不同 App 共用同一 provider 的 token | 由 auth.provider 欄位區分，accounts.json 已支援多 provider key |
| **R5: 熱載入 race condition** | 安裝過程中 session 正在使用 tool pool | 新 App 的 tool 只在下次 tool refresh 時出現，不中斷進行中的 session |

---

## 實作順序

```
Step 0: Foundation — opencode 系統帳號 + /opt/opencode-apps/ + sudo wrapper
Step 1: Layer 1  — 定義 mcp.json schema（Zod）+ 讀取/驗證函式
Step 2: Layer 0  — 抽出 BUILTIN_CATALOG 為 manifest.ts（Phase A）
Step 3: Layer 2  — mcp-apps.json 讀取層 + runtime 啟動流程整合
Step 4: Layer 2  — Admin UI App 卡片 + CRUD API
Step 5: Layer 3  — system-manager.install_mcp_app tool
Step 6: Layer 0  — Gmail/Calendar bun compile 獨立行程化（Phase B）
```

Step 0 是前置基礎建設。
Step 1-3 是 MVP：完成後，外部 App 可透過 mcp-apps.json 掛載。
Step 4 加上 UI。
Step 5 實現對話驅動。
Step 6 內建 App 統一化（零依賴 binary）。
