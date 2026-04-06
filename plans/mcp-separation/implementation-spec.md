# Implementation Spec

## Goal

建立 MCP App 標準化擴充介面，從硬編碼拆離（L0）到對話驅動供應鏈（L3），分六個 Step 逐步交付。

## Scope

### IN

- mcp.json Zod schema 定義與驗證函式
- BUILTIN_CATALOG 硬編碼拆離為 manifest.ts（Phase A）
- mcp-apps.json 讀取/寫入層 + runtime stdio 載入整合
- Admin UI 應用市場 App 卡片 CRUD
- system-manager install_mcp_app / list_mcp_apps / remove_mcp_app tool
- GitHub clone + 依賴安裝 + probe 驗證 pipeline

### OUT

- Gmail/Calendar 獨立行程化（Phase B，獨立計畫）
- OAuth 核心機制改動
- 網路市集
- MCP server 沙箱隔離

## Assumptions

- `/etc/opencode/` 目錄的寫入權限已透過 webctl.sh 或 daemon 身份解決
- 外部 MCP server 遵循 MCP 協議標準（stdio transport + tools/list）
- GitHub 公開 repo 可透過 git clone 取得

## Stop Gates

- SG-1: 任何 Step 導致現有 Gmail/Calendar 功能中斷，必須立即修復再繼續
- SG-2: mcp.json 載入失敗時出現靜默 fallback → 違反 AGENTS.md 第一條，阻斷
- SG-3: 路徑穿越（path traversal）未被阻擋 → 安全性阻斷
- SG-4: bun test 失敗不允許 commit

## Critical Files

### Foundation — 系統帳號與安裝權限
- `install.sh` — 建立 opencode 帳號 + `/opt/opencode-apps/` 目錄 + `/etc/opencode/mcp-apps.json` 初始化
- `/usr/local/bin/opencode-app-install` — 新建 sudo wrapper（clone + chown + register）
- sudoers 設定 — 授權 wrapper 無密碼執行

### Layer 0 — 硬編碼拆離
- `packages/opencode/src/mcp/app-registry.ts` — 移除 BUILTIN_CATALOG
- `packages/opencode/src/mcp/apps/gmail/manifest.ts` — 新建
- `packages/opencode/src/mcp/apps/google-calendar/manifest.ts` — 新建

### Layer 1 — 檔案包規格
- `packages/opencode/src/mcp/manifest-schema.ts` — 新建：McpAppManifest Zod schema
- `packages/opencode/src/mcp/manifest-loader.ts` — 新建：讀取/驗證/推斷邏輯

### Layer 2 — Registry & Lifecycle
- `packages/opencode/src/mcp/app-store.ts` — 新建：mcp-apps.json 讀寫 + stdio 啟動
- `packages/opencode/src/mcp/index.ts` — 整合 app-store 到 tool pool
- `packages/opencode/src/server/routes/mcp.ts` — 新增 CRUD API
- Frontend Admin Panel — 新增 MCP Apps 管理分頁

### Layer 3 — 對話驅動
- `packages/mcp/system-manager/src/index.ts` — 新增 install/list/remove tool
- `packages/mcp/system-manager/src/app-provisioner.ts` — 新建：clone + 安裝 + probe pipeline

## Structured Execution Phases

### Step 0 (Foundation): 系統帳號與安裝權限
建立 opencode nologin 帳號（檔案歸屬隔離）、/opt/opencode-apps/ 目錄（opencode:opencode 755）、初始化 /etc/opencode/mcp-apps.json、部署 sudo wrapper 供 per-user daemon 寫入 system-level。

### Step 1 (Layer 1): mcp.json Schema
定義 Zod schema + 讀取/驗證函式 + 推斷邏輯。無 runtime 副作用，純 library。

### Step 2 (Layer 0): 硬編碼拆離
Gmail/Calendar 的 CatalogEntry 移至各自 manifest.ts。app-registry.ts 從 import 取得，不再硬編碼。managedAppExecutors 暫時保留。

### Step 3 (Layer 2): mcp-apps.json + Runtime 整合
建立兩層 mcp-apps.json 讀寫層（系統優先）。Runtime 啟動時載入 enabled Apps → stdio spawn → MCP Client → tools/list → tool pool。Disabled App 清單注入系統提示詞供 AI 按需啟動。與現有 opencode.json.mcp 的 server 並存。

### Step 4 (Layer 2): Admin UI
後端 CRUD API + 前端 App 卡片管理頁面。Preview API 供新增時預覽。

### Step 5 (Layer 3): system-manager Tool
install_mcp_app（GitHub clone 到 /opt/opencode-apps/ + 推斷 + 安裝 + probe + 註冊）、list_mcp_apps、remove_mcp_app。enablement.json 更新。

### Step 6 (Layer 0): 內建 App 統一化
Gmail/Calendar 用 `bun build --compile` 編譯為零依賴 binary，部署到 /opt/opencode-apps/，移除 managedAppExecutors 和 convertManagedAppTool 舊路徑。

## Validation

- Step 0: 手動驗證 — opencode 帳號存在、/opt/opencode-apps/ 歸屬正確、sudo wrapper 可執行、per-user daemon 可讀取
- Step 1: 單元測試 — schema parse/reject、推斷邏輯
- Step 2: 整合測試 — Gmail/Calendar 功能不變
- Step 3: 整合測試 — drawmiat 透過 mcp-apps.json 掛載，tool 可用
- Step 4: E2E 測試 — UI 新增/移除 App
- Step 5: E2E 測試 — 對話安裝 GitHub MCP server
- Step 6: 整合測試 — Gmail/Calendar 走 bun compile binary 後功能不變

## Handoff

- Build agent must read this spec first
- Build agent must read design.md for architectural decisions (DD-1 through DD-6)
- Build agent must materialize runtime todo from tasks.md
- Each Step 可獨立 commit/交付，但 Step 0 必須先完成
