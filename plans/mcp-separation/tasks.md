# Tasks

## Step 0 — Foundation: System User & File Ownership Isolation（A1）

### 0.1 建立 opencode 系統帳號（A11）
- [ ] 0.1.1 在安裝腳本中加入 `useradd --system --no-create-home --shell /usr/sbin/nologin opencode`
- [ ] 0.1.2 建立 `/opt/opencode-apps/` 目錄，opencode:opencode 755
- [ ] 0.1.3 將 `/etc/opencode/` 擁有者改為 opencode:opencode
- [ ] 0.1.4 建立 `/var/log/opencode/` 目錄，opencode:opencode 755
- [ ] 0.1.5 確認 per-user daemon（一般使用者）可讀取以上目錄
- [ ] 0.1.6 確認現有檔案（opencode.cfg, google-bindings.json 等）歸屬一併更新

### 0.2 Sudo Wrapper for App Install（A12）
- [ ] 0.2.1 建立 `/usr/local/bin/opencode-app-install` wrapper script：
  - 接受參數：`install <source> <id>` / `remove <id>` / `register <id> <path>`
  - `install`：git clone 到 `/opt/opencode-apps/<id>/` + chown opencode:opencode
  - `remove`：從 `/opt/opencode-apps/<id>/` 刪除 + 從 mcp-apps.json 移除
  - `register`：將 entry 寫入 `/etc/opencode/mcp-apps.json` + chown opencode:opencode
  - 路徑安全：只允許操作 `/opt/opencode-apps/` 下，拒絕路徑穿越
- [ ] 0.2.2 在 sudoers 中授權所有使用者可無密碼執行此 wrapper：
  - `ALL ALL=(root) NOPASSWD: /usr/local/bin/opencode-app-install`
- [ ] 0.2.3 install.sh 安裝 wrapper + 設定 sudoers

### 0.3 安裝腳本更新（A13）
- [ ] 0.3.1 install.sh 加入 opencode 帳號建立（冪等，已存在則跳過）
- [ ] 0.3.2 install.sh 加入 `/opt/opencode-apps/` 目錄建立 + chown
- [ ] 0.3.3 install.sh 加入 `/etc/opencode/mcp-apps.json` 初始化（空 apps）+ chown
- [ ] 0.3.4 install.sh 將現有 `/etc/opencode/` 下的檔案 chown 為 opencode:opencode

---

## Step 1 — Layer 1: mcp.json Schema（A1）

### 1.1 定義 McpAppManifest Zod Schema（A11）
- [ ] 1.1.1 建立 `manifest-schema.ts`，定義 `McpAppManifest` schema
  - 必填：`id` (string), `name` (string), `command` (string[])
  - 選填：`description`, `icon`, `version`, `env` (Record<string,string>)
  - 選填：`auth: { type: "none" | "oauth" | "api-key", provider?, tokenEnv?, scopes? }`
  - 選填：`source: { type: "github" | "local", repo?, ref? }`
- [ ] 1.1.2 匯出 parse/validate 函式，失敗時回傳結構化錯誤
- [ ] 1.1.3 單元測試：合法/缺欄位/類型錯誤 cases

### 1.2 實作 Manifest Loader（A12）
- [ ] 1.2.1 建立 `manifest-loader.ts`，實作 `loadManifest(dirPath: string): Promise<McpAppManifest>`
  - 讀取 `<dir>/mcp.json` → Zod 驗證
  - 不存在 → 嘗試推斷（1.3）→ 推斷失敗 → throw `McpManifestNotFoundError`
  - Schema 錯誤 → throw `McpManifestInvalidError`
  - 所有錯誤路徑都 log.warn，不靜默
- [ ] 1.2.2 路徑安全：`path.resolve()` + 禁止 `..` 穿越
- [ ] 1.2.3 單元測試：正常/缺檔/schema 錯誤/路徑穿越

### 1.3 實作 Command 推斷引擎（A13）
- [ ] 1.3.1 實作 `inferManifest(dirPath: string): Promise<McpAppManifest | null>`
  - 偵測 package.json（bin/scripts.start） → 推斷 node/bun command
  - 偵測 pyproject.toml / setup.py → 推斷 python/uvx command
  - 偵測 requirements.txt + server.py → 推斷 python command
  - 推斷成功 → 生成 mcp.json 寫入目錄 + log.info
  - 推斷失敗 → 回傳 null（caller 負責 throw）
- [ ] 1.3.2 單元測試：各語言偵測 + 無法推斷

---

## Step 2 — Layer 0: 硬編碼拆離（A2）

### 2.1 建立內建 App Manifest（A21）
- [ ] 2.1.1 建立 `apps/gmail/manifest.ts`，匯出 `export const manifest: CatalogEntry`
  - 內容從 BUILTIN_CATALOG["gmail"] 搬移
- [ ] 2.1.2 建立 `apps/google-calendar/manifest.ts`，同上
- [ ] 2.1.3 確認 manifest 內容與原硬編碼完全一致

### 2.2 重構 app-registry.ts（A22）
- [ ] 2.2.1 BUILTIN_CATALOG 改為從 manifest.ts import 組合
- [ ] 2.2.2 移除所有 inline 硬編碼 CatalogEntry 定義
- [ ] 2.2.3 確認 `catalog()` / `list()` / `get()` 行為不變
- [ ] 2.2.4 現有測試通過（不改測試邏輯，只改 import 來源）

### 2.3 驗證 Gmail/Calendar 功能完整性（A23）
- [ ] 2.3.1 啟動 runtime，確認兩個 App 正常載入
- [ ] 2.3.2 確認 managedAppExecutors 仍正常運作
- [ ] 2.3.3 bun test 全部通過

---

## Step 3 — Layer 2: mcp-apps.json + Runtime 整合（A3）

### 3.1 建立 mcp-apps.json 讀寫層（A31）
- [ ] 3.1.1 定義 `McpAppsConfig` Zod schema（version, apps: Record<id, entry>）
  - entry: `{ path, enabled, installedAt, source }`
- [ ] 3.1.2 實作 `loadAppsConfig()`: 讀取兩層並合併（system 優先）
  - `/etc/opencode/mcp-apps.json`（system-level）
  - `~/.config/opencode/mcp-apps.json`（user-level）
  - 都不存在 → 回傳空 apps（合法的初始狀態）
  - 存在但格式錯 → log.warn + throw
- [ ] 3.1.3 實作 `saveUserAppsConfig()`: 寫入 user-level（daemon 直接寫）
- [ ] 3.1.4 實作 `saveSystemApp()`: 透過 sudo wrapper 寫入 system-level
- [ ] 3.1.5 實作 `addApp()` / `removeApp()` / `setEnabled()` 操作函式（根據目標層級選擇寫入方式）

### 3.2 實作 Stdio App Launcher（A32）
- [ ] 3.2.1 實作 `launchStdioApp(manifest: McpAppManifest, env?: Record<string,string>): Promise<McpAppHandle>`
  - spawn command → StdioClientTransport → new Client → connect
  - tools/list → 取得工具清單
  - auth.type === "oauth" → 從 accounts.json 取 token → 注入 tokenEnv
  - 回傳 handle: { client, tools, manifest, dispose() }
- [ ] 3.2.2 失敗處理：spawn error / timeout / protocol error → log.warn + throw
- [ ] 3.2.3 dispose() 負責 kill process + 斷開 client

### 3.3 整合到 Runtime 啟動流程（A33）
- [ ] 3.3.1 在 MCP namespace 初始化時，讀取 mcp-apps.json → 對每個 enabled app 呼叫 launchStdioApp
- [ ] 3.3.2 載入的 tools 以 `<app-id>_<tool-name>` 格式註冊到 session tool pool
- [ ] 3.3.3 與現有 opencode.json.mcp server 的 tool 並存，無衝突
- [ ] 3.3.4 Bus event: 新 App 載入成功/失敗 → `mcp.app.loaded` / `mcp.app.error`
- [ ] 3.3.5 整合測試：drawmiat 透過 mcp-apps.json 掛載，tool 在 session 中可呼叫

---

## Step 4 — Layer 2: Admin UI 應用市場（A4）

### 4.1 後端 CRUD API（A41）
- [ ] 4.1.1 `GET /api/v2/mcp/apps` — 回傳 mcp-apps.json 的 App 列表 + manifest + status
- [ ] 4.1.2 `POST /api/v2/mcp/apps` — 接受 `{ path }` 或 `{ githubUrl }`，驗證後寫入
- [ ] 4.1.3 `POST /api/v2/mcp/apps/preview` — 只讀取 manifest 回傳預覽，不連線
- [ ] 4.1.4 `PATCH /api/v2/mcp/apps/:id` — 更新 enabled 狀態
- [ ] 4.1.5 `DELETE /api/v2/mcp/apps/:id` — 斷線 + 從 mcp-apps.json 移除
- [ ] 4.1.6 路徑穿越防護：path.resolve + 白名單檢查
- [ ] 4.1.7 寫入權限不足時回傳 403 + 明確錯誤訊息

### 4.2 前端 App 卡片管理頁面（A42）
- [ ] 4.2.1 Admin Panel 新增「MCP Apps」分頁
- [ ] 4.2.2 App 卡片元件：icon, name, description, status badge, tool count, source 標示
- [ ] 4.2.3 新增流程：路徑/URL 輸入 → Preview 按鈕 → 卡片預覽 → Add 確認
- [ ] 4.2.4 已登記 App 列表：enable/disable toggle + remove 按鈕
- [ ] 4.2.5 Error 狀態卡片：顯示具體錯誤訊息 + retry 按鈕

---

## Step 5 — Layer 3: system-manager Conversational Provisioning（A5）

### 5.1 install_mcp_app Tool（A51）
- [ ] 5.1.1 定義 tool schema: `{ source: string, id?: string }`
  - source: GitHub URL (https://github.com/owner/repo) 或本機絕對路徑
  - id: 可省略，從 repo name 或 mcp.json 推斷
- [ ] 5.1.2 實作 GitHub clone pipeline:
  - 解析 URL → git clone → `/opt/opencode-apps/<id>/`（或 XDG 可寫位置）
  - clone 失敗 → 回傳明確錯誤（network / auth / not found）
- [ ] 5.1.3 實作依賴安裝:
  - 偵測 package.json → bun install
  - 偵測 requirements.txt → pip install -r（考慮 venv）
  - 無依賴檔 → skip
- [ ] 5.1.4 實作 probe 驗證:
  - loadManifest → launchStdioApp（只做 tools/list，不執行任何 tool）
  - 成功 → 取得 tool 列表 → dispose
  - 失敗 → 回傳具體診斷（command not found / timeout / protocol error）
- [ ] 5.1.5 註冊: addApp() 寫入 mcp-apps.json → 通知 runtime 熱載入
- [ ] 5.1.6 回報: 回傳 `{ id, name, description, tools: [...], status }`

### 5.2 list_mcp_apps / remove_mcp_app Tool（A52）
- [ ] 5.2.1 `list_mcp_apps`: 讀取 mcp-apps.json + 各 App manifest + status → 回傳列表
- [ ] 5.2.2 `remove_mcp_app({ id })`: 斷線 + removeApp() → 回傳確認（不刪檔案）
- [ ] 5.2.3 更新 enablement.json 加入三個新 tool

### 5.3 E2E 驗證（A53）
- [ ] 5.3.1 測試：對話安裝一個公開的 GitHub MCP server
- [ ] 5.3.2 測試：安裝後 tool 在 session 中可呼叫
- [ ] 5.3.3 測試：remove 後 tool 消失

---

## Step 6 — Layer 0: 內建 App 統一化 — bun compile（A6）

### 6.1 Gmail MCP Server Binary（A61）
- [ ] 6.1.1 建立 `gmail-server.ts`：import 現有 `client.ts` + 包裝 MCP Server 外殼
  - 實作 `tools/list` handler，匯出所有 Gmail 工具
  - 實作 `tools/call` handler，代理到現有 `GmailApp.execute`
  - OAuth token 從 env 變數 `GOOGLE_ACCESS_TOKEN` 讀取
- [ ] 6.1.2 `bun build --compile --target=bun-linux-x64 gmail-server.ts --outfile gmail-server`
  - 驗證產出的 binary 可獨立執行（不依賴 node_modules）
- [ ] 6.1.3 建立 `mcp.json` manifest：`{ "id": "gmail", "command": ["./gmail-server"] }`
- [ ] 6.1.4 部署到 `/opt/opencode-apps/gmail/`
- [ ] 6.1.5 在 mcp-apps.json 中登記，驗證 tools/list 正常

### 6.2 Google Calendar MCP Server Binary（A62）
- [ ] 6.2.1 建立 `gcal-server.ts`：同 Gmail 模式，包裝 `GoogleCalendarApp.execute`
- [ ] 6.2.2 `bun build --compile` 產生 `gcal-server` binary
- [ ] 6.2.3 建立 `mcp.json` manifest
- [ ] 6.2.4 部署到 `/opt/opencode-apps/google-calendar/`
- [ ] 6.2.5 在 mcp-apps.json 中登記，驗證 tools/list 正常

### 6.3 清理舊路徑（A63）
- [ ] 6.3.1 移除 `managedAppExecutors` 對照表（mcp/index.ts）
- [ ] 6.3.2 移除 `convertManagedAppTool` 及相關 schema 轉換碼
- [ ] 6.3.3 移除 `apps/gmail/manifest.ts` 和 `apps/google-calendar/manifest.ts`（Step 2 產物）
- [ ] 6.3.4 統一所有 App 走 `convertMcpTool` 路徑
- [ ] 6.3.5 gauth.json → accounts.json migration + deprecation log
- [ ] 6.3.6 移除 `BUILTIN_CATALOG` 殘留引用
- [ ] 6.3.7 更新 specs/architecture.md
- [ ] 6.3.8 更新 docs/events/

---

## 驗收門檻（Stop Gates）

- [ ] SG-1: mcp.json 不存在且推斷失敗時，log.warn 且不靜默跳過
- [ ] SG-2: 路徑穿越攻擊被 path.resolve + 檢查擋住
- [ ] SG-3: /etc/opencode/mcp-apps.json 無寫入權限時，API 回傳 403 + 明確錯誤
- [ ] SG-4: bun test 全部通過
- [ ] SG-5: 手動測試：對話安裝 GitHub MCP server → tool 可用
- [ ] SG-6: Gmail/Calendar 功能在每個 Step 都不中斷
