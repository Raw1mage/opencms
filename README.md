# OpenCode CMS Branch

`cms` 是 OpenCode 的產品化主線分支，重點在「多帳號、多 Provider、多模型」的可控調度與穩定運行。

本 README 以 **cms 架構與特色** 為主，作為快速理解系統的入口。

---

## 1) cms 核心特色

### ① 全域多帳號管理（Global Multi-Account）

- 以 provider family 為單位管理帳號（如 `openai`, `claude-cli`, `gemini-cli`, `google-api`）。
- 帳號資料集中於統一帳務模組與 `accounts.json`，支援 active account 切換與狀態追蹤。
- 前後端一致使用 `/account` API 與同步流程，避免「UI 顯示」與「實際路由」脫鉤。

### ② Rotation3D 多維輪替

- 以 **Provider / Account / Model** 三維座標執行 fallback 與選路。
- 在 rate limit、配額不足、模型不可用時，進行可預測的降級與切換。
- 關鍵路徑集中在 `packages/opencode/src/account/rotation3d.ts` 與 session 路由鏈。

### ③ `/admin` 控制平面（TUI Canonical Control Plane）

- TUI `/admin` 為權威管理入口，負責 provider/account/model 的操作與診斷。
- 支援 provider 顯示/停用切換、帳號啟用切換、模型可用性觀測。
- Web 端目前提供 admin-lite 能力，並重用同一組後端 API。

### ④ Provider 模組化與分流

cms 將 provider 管理從單體模式改為模組化分流，常見路徑如：

- `gemini-cli`：偏長任務/批量處理
- `google-api`：偏輕量、快速 API key 路徑

此設計讓配額治理、故障隔離、策略路由更精準，且能依場景調整家族策略。

---

## 2) 系統架構總覽

cms 採 Monorepo 架構（Bun + TurboRepo），核心分層如下：

```text
┌────────────────────────────────────────────────────┐
│ Interface Layer                                    │
│ - TUI (/admin)  - Web (admin-lite)  - Desktop      │
└────────────────────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────┐
│ Runtime & API Layer (packages/opencode/src/server)│
│ - /provider  /account  /session  /auth             │
│ - WebAuth / CSRF / PTY lifecycle                   │
└────────────────────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────┐
│ Provider & Account Layer                           │
│ - Provider graph assembly (models + config + auth) │
│ - Account families + active account                │
│ - Rotation3D fallback                              │
└────────────────────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────┐
│ Plugin & Capability Layer                          │
│ - Built-in plugins (e.g., gemini-cli)               │
│ - MCP / Tools / Skills enablement registry         │
└────────────────────────────────────────────────────┘
```

---

## 3) 核心設計原則

### A. 身分解析必須 canonical

- 不依賴字串猜測 provider family。
- 使用 canonical resolver（如 `Account.resolveFamily(...)`）維持一致性。

### B. Provider 組裝順序固定

1. 載入 models（models.dev + snapshot）
2. 合併 config provider
3. 合併 env/auth
4. 合併 account overlays
5. 套用 plugin/custom loaders
6. 過濾並輸出最終 provider/model 視圖

固定順序可避免「先後覆寫」導致的隱性錯誤。

### C. `disabled_providers` 為唯一可見性來源

- provider 顯示/隱藏（含停用）由同一配置欄位控制。
- `/admin` 的 Show All / Filtered 僅是視圖模式差異，不改變資料真相來源。

---

## 4) 關鍵目錄

- `packages/opencode/src/account/`：帳號管理、rotation3d、限流判斷
- `packages/opencode/src/provider/`：provider 組裝、模型/健康度、橋接邏輯
- `packages/opencode/src/server/routes/`：`/provider`、`/account`、`/session` 等 API
- `packages/opencode/src/cli/cmd/tui/`：TUI 與 `/admin` 互動流程
- `packages/opencode/src/plugin/`：provider 擴充插件
- `docs/ARCHITECTURE.md`：完整架構細節（本 README 的延伸）

---

## 5) 分支與整合策略（重要）

- `cms` 是本環境主要產品線。
- 來自 `origin/dev` 或 `refs/*` 外部來源的變更，採 **分析後重構移植**。
- 為保留 cms 架構，不採直接 merge 作法。

---

## 6) 開發與驗證（簡版）

```bash
bun install
bun run typecheck
bun test
```

如需完整架構、路由與模組說明，請讀：

- `docs/ARCHITECTURE.md`
- `docs/specs/`
- `docs/events/`

---

## 7) 使用前準備（Prerequisites）

至少需要：

- `git`
- `curl`
- `bun`（本專案主要 runtime / package manager）

若要跑 Desktop（Tauri）另外需要：

- Rust toolchain（`rustup` / `cargo`）
- 平台對應 Tauri 系統套件（Linux/macOS/Windows 各異）

> Desktop 先決條件請參考：<https://v2.tauri.app/start/prerequisites/>

---

## 8) 一鍵初始化（install.sh）

提供給新進使用者的快速初始化腳本：

```bash
chmod +x ./install.sh
./install.sh
```

常用參數：

```bash
# 連 desktop 開發依賴也一起準備
./install.sh --with-desktop

# 跳過系統套件安裝（只做 Bun + bun install）
./install.sh --skip-system

# 非互動模式
./install.sh --yes
```

此腳本會：

1. 檢查並安裝 Bun（若未安裝）
2. 依作業系統嘗試安裝必要系統套件（可跳過）
3. 執行 `bun install`
4. 預建 `packages/app` 前端資產（讓 Web 模式可直接啟動）

---

## 9) 啟動與使用

### A. TUI（主要控制介面）

```bash
bun run dev
```

啟動後可直接在互動終端操作，常見流程：

- 使用 `/admin` 進入 provider / account / model 管理
- 在主輸入列與 agent 互動

### B. Web App（瀏覽器介面）

建議使用專案內建控制腳本：

```bash
# 第一次或前端有變更後
./webctl.sh build-frontend

# 啟動 web service
./webctl.sh start
```

開啟：`http://localhost:1080`

> `webctl.sh` 啟動的 managed web server 預設不會自動開新瀏覽器分頁（避免重啟時被帶去 localhost）。

常用管理指令：

```bash
./webctl.sh status
./webctl.sh logs
./webctl.sh stop
```

重啟建議（自我進化/自我重啟場景）：

```bash
# 預設：safe restart（detached + graceful，推薦）
./webctl.sh restart

# 明確指定 graceful（與預設相同）
./webctl.sh restart --graceful

# 舊行為：inline 直接 stop -> start（不建議在 web 內殼執行）
# 預設會被安全策略降級為 detached+graceful；如需強制開啟：
# OPENCODE_ALLOW_INLINE_RESTART=1 ./webctl.sh restart --inline
./webctl.sh restart --inline
```

外部網址顯示可設定：

```bash
# .env
OPENCODE_PUBLIC_URL=https://your-domain.example
```

設定後 `webctl.sh start/status` 會顯示外部網址，而非固定 `localhost`。

### C. Desktop（Tauri）

```bash
# 啟動 desktop 開發模式（會開啟原生視窗）
bun run --cwd packages/desktop tauri dev
```

只跑 desktop 前端（不開 native shell）：

```bash
bun run --cwd packages/desktop dev
```

產生 desktop 打包：

```bash
bun run --cwd packages/desktop tauri build
```
