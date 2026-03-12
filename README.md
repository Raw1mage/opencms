# OpenCode CMS Branch

`cms` 是 OpenCode 的產品化主線分支：把原本偏單機/單入口的 agent runtime，整理成一套可持續操作的 **多帳號、多 Provider、多模型控制平面**。

它的核心價值不是「再包一層 UI」，而是把日常最痛的事情產品化：

- 帳號很多，不想手動切來切去
- 模型很多，不想每次失敗都重選
- TUI 想保留操作效率，Web 又想要可視化管理
- 想把 runtime secrets 留在本機/XDG，而不是回寫進 repo

本 README 會先用 **產品介紹 + 使用方式** 帶你理解 `cms`，再補充必要架構觀念。

---

## 1) 為什麼是 cms

### ① 它不是單純 UI，而是可操作的控制平面

`cms` 把 provider / account / model 三者收斂成一套一致的操作模型：

- 同一個 family 可以管理多個帳號
- 同一個模型群可以按策略 fallback
- TUI 與 Web App 共用同一組後端資料與 API

結果是：你不需要在「CLI 真實狀態」和「Web 顯示狀態」之間來回猜測。

### ② 它是雙平台架構：TUI + Web App

`cms` 的關鍵不是二選一，而是 **兩個介面各司其職**：

- **TUI**：高速操作、快速切換、權威管理入口（canonical control plane）
- **Web App**：可視化管理、瀏覽器操作、較低學習門檻

如果你是重度使用者，TUI 會是主控台；如果你需要可視化與瀏覽器管理，Web App 會是最佳入口。

### ③ 它是多模型、多帳號環境的穩定化版本

- 用 account family 統一管理身份
- 用 Rotation3D 管理 provider/account/model 三維 fallback
- 用 shared config/state 避免前端顯示與後端真相脫節

---

## 2) cms 核心特色

### ① 全域多帳號管理（Global Multi-Account）

- 以 provider family 為單位管理帳號（如 `openai`, `claude-cli`, `gemini-cli`, `google-api`）。
- 帳號資料集中於統一帳務模組與 XDG runtime `accounts.json`（預設 `~/.config/opencode/accounts.json`），支援 active account 切換與狀態追蹤。
- runtime secrets（如 `accounts.json`, `mcp-auth.json`）保留於 user-home/XDG 或部署端 volume；repo 不追蹤這類本機憑證鏡像。
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

目前 canonical Google family 只保留 `gemini-cli` 與 `google-api`，讓家族邊界、配額治理與路由策略更清晰。

此設計讓配額治理、故障隔離、策略路由更精準，且能依場景調整家族策略。

---

## 3) 使用方式總覽（TUI / Web App / Desktop）

角色分工先記住：

- `install.sh`：初始化環境
- `webctl.sh`：Web 啟停/refresh/狀態管理（唯一控制入口）
- `bun run dev`：TUI 互動入口

### 3.0 推薦快速流程（開發）

```bash
# 1) 初始化
./webctl.sh install --dev --yes

# 2) 前端建置（首次或前端改動後）
./webctl.sh build-frontend

# 3) 啟動 Web App
./webctl.sh dev-start

# 4) 需要 TUI 時
bun run dev
```

> Web runtime 單一啟動入口：請使用 `./webctl.sh dev-start` / `./webctl.sh dev-refresh`，不要手動拼 `opencode web`。

### A. TUI：高速控制台（推薦給重度使用者）

```bash
bun run dev
```

TUI 適合：

- 快速進入 `/admin` 管 provider / account / model
- 在同一個操作環境中完成 session、切換、診斷
- 保持鍵盤優先的操作效率

### B. Web App：瀏覽器控制台（推薦給可視化管理）

Web 的啟動/停止/重啟/檢查，一律透過 `webctl.sh`：

```bash
# 第一次安裝（production）
./webctl.sh install --yes

# 第一次或前端有變更後
./webctl.sh build-frontend

# 開發模式啟動（source）
./webctl.sh dev-start

# production systemd service
./webctl.sh web-start
```

開啟：`http://localhost:1080`（或 `/etc/opencode/opencode.cfg` 設定的 host/port）

常用管理指令：

```bash
./webctl.sh status
./webctl.sh logs
./webctl.sh dev-stop
./webctl.sh web-stop
./webctl.sh restart
./webctl.sh dev-refresh
./webctl.sh web-refresh
```

### C. Desktop（Tauri）

如果你需要原生桌面殼：

```bash
./install.sh --with-desktop --yes
bun run --cwd packages/desktop tauri dev
```

---

## 4) 系統架構總覽

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

## 5) 核心設計原則

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

### D. Web Sync 採單一有效狀態（Effective State）

- Web 端對 `disabled_providers`、model preferences 等高互動資源，使用 shared action/store 與 selector layer 維持一致性。
- 小型 mutation 優先走 partial refresh，而非一律 full bootstrap，避免 stale refresh、scroll reset 與 optimistic rollback 抖動。

---

## 6) 關鍵目錄

- `packages/opencode/src/account/`：帳號管理、rotation3d、限流判斷
- `packages/opencode/src/provider/`：provider 組裝、模型/健康度、橋接邏輯
- `packages/opencode/src/server/routes/`：`/provider`、`/account`、`/session` 等 API
- `packages/opencode/src/cli/cmd/tui/`：TUI 與 `/admin` 互動流程
- `packages/opencode/src/plugin/`：provider 擴充插件
- `docs/ARCHITECTURE.md`：完整架構細節（本 README 的延伸）

---

## 7) 分支與整合策略（重要）

- `cms` 是本環境主要產品線。
- 來自 `origin/dev` 或 `refs/*` 外部來源的變更，採 **分析後重構移植**。
- 為保留 cms 架構，不採直接 merge 作法。

---

## 8) 開發與驗證（簡版）

```bash
bun install
bun run typecheck
bun test
```

如需完整架構、路由與模組說明，請讀：

- `docs/ARCHITECTURE.md`
- `docs/specs/`
- `docs/events/`

如需本機帳號/憑證設定，請放在 XDG runtime 路徑（如 `~/.config/opencode/`）；不要將 runtime secrets 同步回 repo。

---

## 9) 使用前準備（Prerequisites）

至少需要：

- `git`
- `curl`
- `bun`（本專案主要 runtime / package manager）

若要跑 Desktop（Tauri）另外需要：

- Rust toolchain（`rustup` / `cargo`）
- 平台對應 Tauri 系統套件（Linux/macOS/Windows 各異）

> Desktop 先決條件請參考：<https://v2.tauri.app/start/prerequisites/>

---

## 10) 一鍵初始化（install.sh）

`install.sh` 是**環境初始化腳本**，建議第一次進 repo 先跑它。

```bash
chmod +x ./install.sh
./install.sh
```

### 常用參數

```bash
# 連 desktop 開發依賴一起準備
./install.sh --with-desktop

# 跳過系統套件安裝（只做 Bun + bun install + build）
./install.sh --skip-system

# 非互動模式
./install.sh --yes

# Linux 系統級部署初始化（建立 service user + systemd unit）
./install.sh --system-init

# 自訂 service user / unit 名稱
./install.sh --system-init --service-user opencode --service-name opencode-web
```

### install.sh 會做什麼

1. 檢查並安裝 Bun（若未安裝）
2. 依作業系統嘗試安裝必要系統套件（可跳過）
3. 執行 `bun install`
4. 建置必要產物（讓 TUI/Web/Desktop 流程可接續）

若啟用 `--system-init`（Linux）會額外做：

1. 建立專屬 service account（預設 `opencode`，`nologin`）
2. 準備 system runtime 目錄
3. 產生 `/etc/opencode/opencode.cfg`（web runtime 單一設定來源）
4. 安裝 `/usr/local/libexec/opencode-run-as-user`
5. 安裝 `/etc/sudoers.d/opencode-run-as-user`
6. 安裝並啟用 `opencode-web.service`

> 建議：正式環境使用 `--system-init`，將 web control plane 與個人帳號（如 `pkcs12`）脫鉤。

也可以透過 `webctl.sh` 走安裝流程：

```bash
# production 預設（自動帶 --system-init）
./webctl.sh install --yes

# development 模式（不建立 systemd service）
./webctl.sh install --dev --yes
```

---

## 11) Web / TUI 操作建議（避免踩坑）

1. 先 `install.sh`，再做各模式啟動。
2. Web 模式不要手動拼 `opencode web` 命令，改用 `webctl.sh`。
3. 若要直接讓 repo 更新重新套用到目前活躍 web runtime，優先用 `./webctl.sh restart`（dev 會走 `build + stop + flush + start`，prod 會走 `web-refresh`）。
4. 若只想手動拆步，前端改動後可先 `./webctl.sh build-frontend` 再 `dev-start` / `dev-refresh`。
5. 要做系統服務部署時，優先 `./webctl.sh install --yes`（production 預設）。
6. `./webctl.sh flush --dry-run` 會列出目前被判定為 **stale interactive runtime** 的 `opencode` / MCP process tree；確認後可用 `./webctl.sh flush` 清理。
