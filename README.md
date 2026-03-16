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

- 同一個 canonical provider key 可以管理多個帳號（legacy 文件中的 `family` 僅作相容用語）
- 同一個模型群可以按策略 fallback
- TUI 與 Web App 共用同一組後端資料與 API

結果是：你不需要在「CLI 真實狀態」和「Web 顯示狀態」之間來回猜測。

### ② 它是雙平台架構：TUI + Web App

`cms` 的關鍵不是二選一，而是 **兩個介面各司其職**：

- **TUI**：高速操作、快速切換、權威管理入口（canonical control plane）
- **Web App**：可視化管理、瀏覽器操作、較低學習門檻

如果你是重度使用者，TUI 會是主控台；如果你需要可視化與瀏覽器管理，Web App 會是最佳入口。

### ③ 它是多模型、多帳號環境的穩定化版本

- 用 canonical provider key 統一管理身份（legacy `family` 用語仍可能在相容層出現）
- 用 Rotation3D 管理 provider/account/model 三維 fallback
- 用 shared config/state 避免前端顯示與後端真相脫節

---

## 2) cms 核心特色

### ① 全域多帳號管理（Global Multi-Account）

- 以 canonical provider key 為單位管理帳號（如 `openai`, `claude-cli`, `gemini-cli`, `google-api`）。
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

目前 canonical Google provider keys 只保留 `gemini-cli` 與 `google-api`；legacy `family` 文字若仍存在，應視為相容敘述而非新的正式命名。

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
│ - Provider-keyed accounts + active account         │
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

### 4.1 自主執行架構（Autonomous Execution Stack）

`cms` 的自主執行能力分為三層：**Smart Runner → Workflow Runner → Autorunner Daemon（規劃中）**。

#### Smart Runner Governor（已落地）

Smart Runner 是 session 級的決策引擎，在每個 autonomous turn 之間判斷下一步動作。它以結構化方式評估當前狀態，輸出以下決策之一：

- `continue` / `replan` / `ask_user` / `request_approval` / `pause_for_risk` / `pause` / `complete` / `docs_sync_first` / `debug_preflight_first`

核心特性：

- **bounded adoption**：host prompt loop 不盲目接受所有建議，而是依 adoption policy 判定是否生效
- **risk pause**：偵測到高風險操作時主動暫停，要求 operator 確認
- **replan**：當 todo 與實際進度偏離時，主動提出 replan 建議
- **narration**：每個 decision 附帶可供 UI 顯示的自然語言解釋

實作路徑：`packages/opencode/src/session/smart-runner-governor.ts`

#### Workflow Runner（已落地）

Workflow Runner 是 orchestration 中心，管理 session 的整體自主執行流程：

- 根據 todo、mission approval、blocker gate、subagent 狀態與 recent anomalies，判斷下一步是繼續、排隊待續，還是停在 `waiting_user` / `blocked`
- continuation queue 作為 trigger 吸收層：把「繼續跑下一步」視為可持久化、可觀測的事件
- supervisor 提供 lease / retry / anomaly evidence，確保 Web / TUI / API 看到的是同一份健康狀態

執行路徑：

```text
User / API / Operator action
          │
          ▼
 mission + todos + approval gates
          │
          ▼
 Smart Runner evaluates → decision + narration
          │
          ▼
 workflow-runner decides continue / pause / block
          │
          ▼
 session prompt loop executes one serialized turn
          │
          ▼
 supervisor records lease / retry / anomalies
          │
          ▼
 Web / TUI read the same workflow + queue health
```

#### Autorunner Daemon（規劃中，尚未落地）

目標是把 session 從 conversation-turn-centric 提升為 **daemon-owned long-lived job**：

- session 作為 durable actor，由 daemon control plane 管理 lifecycle、lease、heartbeat、checkpoint
- prompt loop 降級為 execution adapter（不再是 orchestration owner）
- event-sourced runtime model：所有 lifecycle/worker/todo 變更通過 journal 記錄
- worker supervisor 獨立管理 subagent 生命週期，task tool 表面只是 presentation layer

目標拓撲：

```text
API Gateway / Session Query Surface
      ↓
Autorunner Control Plane Daemon
      ├─ Session Coordinator + Workflow State Reducer
      ├─ Durable Queue / Lease Manager
      ├─ Worker Supervisor Registry
      └─ Health / Anomaly Deriver
             ↓
      Execution Adapters
      ├─ Prompt Loop Adapter
      ├─ Subagent Task Adapter
      └─ Question / Approval Adapter
```

這個方向繼承了 OpenClaw 帶來的啟發：queue-first、orchestration-first、observable-state-first，但目前只落地了 session-scoped 的 workflow runner + smart runner，daemon substrate 尚在規劃階段。

詳見：`docs/specs/autorunner_daemon_architecture.md`

### 4.2 Planning Agent（已落地）

非平凡任務進入自主執行前，系統會優先導向 **planning mode**：

1. 偵測 request 為 planning-worthy（多檔案、架構敏感、scope 不明確）
2. 自動或建議進入 plan mode（`plan_enter` tool）
3. 以 question-driven clarification 釐清需求
4. 產出 plan file + 結構化 todo/action metadata
5. `plan_exit` 後自然過渡到 build/continuous execution

Planning mode 不只是文件撰寫，而是 autorunner 的前置 substrate：plan output 直接餵入 workflow runner 作為 todo 與 stop gate 的來源。

詳見：`docs/specs/planning_agent_runtime_reactivation.md`

### 4.3 Provider-Key 統一遷移（已完成）

`cms` 已完成從 legacy `family` 欄位到 canonical **provider-key** 語義的全面遷移：

- 所有 account 操作、API route、SDK response 統一使用 `providerKey` 作為 primary key
- legacy `family` 欄位透過 compatibility alias 保留向後相容，但不再是 primary
- quota helper、selector path、state store 均已對齊 provider-key 語義
- 新的 account activation payload 以 provider-key 為主鍵

這個遷移讓 provider 身分解析從字串猜測升級為 canonical resolver 驅動，消除了 family/providerId 混用的隱性錯誤。

---

## 5) 核心設計原則

### A. 身分解析必須 canonical

- 所有 provider 身分以 canonical `providerKey` 為準（legacy `family` 僅作 compatibility alias）。
- 使用 canonical resolver（如 `Account.resolveProviderKey(...)`）維持一致性。

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
- `packages/opencode/src/session/smart-runner-governor.ts`：Smart Runner 決策引擎
- `packages/opencode/src/session/prompt/`：plan mode reminders、smart runner prompts
- `packages/opencode/src/tool/plan.ts`：plan_enter / plan_exit 工具
- `packages/opencode/src/server/routes/`：`/provider`、`/account`、`/session` 等 API
- `packages/opencode/src/cli/cmd/tui/`：TUI 與 `/admin` 互動流程
- `packages/opencode/src/plugin/`：provider 擴充插件
- `docs/specs/autorunner_daemon_architecture.md`：Autorunner Daemon 架構規劃
- `docs/specs/planning_agent_runtime_reactivation.md`：Planning Agent 啟動規格
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
