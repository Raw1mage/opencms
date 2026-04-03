# OpenCode CMS Branch

`cms` 是 OpenCode 的產品化主線分支：把原本偏單機/單入口的 agent runtime，整理成一套可持續操作的 **多帳號、多 Provider、多模型控制平面**。

它的核心價值不是「再包一層 UI」，而是把日常最痛的事情產品化：

- 帳號很多，不想手動切來切去
- 模型很多，不想每次失敗都重選
- TUI 想保留操作效率，Web 又想要可視化管理
- 想把 runtime secrets 留在本機/XDG，而不是回寫進 repo

---

## 1) 為什麼是 cms

### ① 可操作的控制平面

`cms` 把 provider / account / model 三者收斂成一套一致的操作模型：

- 同一個 canonical provider key 可以管理多個帳號
- 同一個模型群可以按策略 fallback
- TUI 與 Web App 共用同一組後端資料與 API

結果是：你不需要在「CLI 真實狀態」和「Web 顯示狀態」之間來回猜測。

### ② 雙平台架構：TUI + Web App

- **TUI**：高速操作、快速切換、權威管理入口（canonical control plane）
- **Web App**：可視化管理、瀏覽器操作、較低學習門檻

### ③ 多模型、多帳號環境的穩定化版本

- 用 canonical provider key 統一管理身份
- 用 Rotation3D 管理 provider/account/model 三維 fallback
- 用 shared config/state 避免前端顯示與後端真相脫節

---

## 2) cms 核心特色

### ① 全域多帳號管理（Global Multi-Account）

- 以 canonical provider key 為單位管理帳號（如 `openai`, `claude-cli`, `gemini-cli`, `google-api`）
- 帳號資料集中於 XDG runtime `accounts.json`（預設 `~/.config/opencode/accounts.json`），支援 active account 切換與狀態追蹤
- 三層架構：Storage（`Account` module）→ Service Layer（`Auth` module）→ Presentation（TUI/Web dialogs）
- runtime secrets 保留於 user-home/XDG，repo 不追蹤本機憑證

### ② Rotation3D 多維輪替

- 以 **Provider / Account / Model** 三維座標執行 fallback 與選路
- 在 rate limit、配額不足、模型不可用時，進行可預測的降級與切換
- 關鍵路徑：`packages/opencode/src/account/rotation3d.ts`

### ③ `/admin` 控制平面（TUI Canonical Control Plane）

- TUI `/admin` 為權威管理入口，負責 provider/account/model 的操作與診斷
- 支援 provider 顯示/停用切換、帳號啟用切換、模型可用性觀測
- Web 端提供 admin-lite 能力，重用同一組後端 API

### ④ Provider 模組化與分流

cms 將 provider 管理從單體模式改為模組化分流：

- `gemini-cli`：偏長任務/批量處理
- `google-api`：偏輕量、快速 API key 路徑

canonical Google provider keys 只保留 `gemini-cli` 與 `google-api`，讓配額治理、故障隔離、策略路由更精準。

### ⑤ 多使用者閘道（C Gateway + PAM 認證）

`cms` 提供 production-grade 的多使用者閘道架構：

- C 語言 gateway（`daemon/opencode-gateway.c`）作為特權邊緣代理，監聽 port 1080
- PAM 認證（pthread-based，非阻塞 event loop）作為 primary identity authority
- 每個 Linux user 各自持有獨立的 daemon process，完全隔離
- 閘道透過 `fork+setuid+execvp` 以使用者身份啟動 per-user TypeScript daemon（Unix socket）
- Google OAuth 作為 compatibility path，須先透過 `/etc/opencode/google-bindings.json` binding 到 Linux user

### ⑥ Codex 整合（WebSocket + Incremental Delta）

- AI SDK Responses path 為 Codex provider 資料路徑
- WebSocket transport：持久連線複用、error event 分類、session-scoped HTTP fallback
- Incremental delta：append-only conversation 語義，continuation 有效時 zero replay
- 帳號切換時 reset WS 連線，避免 stale OAuth session 污染
- 詳見：`specs/codex/`

### ⑦ Durable Scheduler（持久化排程）

- 排程 job 狀態持久化於 `~/.config/opencode/cron/jobs.json`
- 開機恢復（`Heartbeat.recoverSchedules()`）：stale 週期任務跳到下一個未來觸發時間，stale 一次性任務自動停用
- 分鐘級心跳節奏，與 `Server.listenUnix()` lifecycle 整合
- 詳見：`specs/scheduler-channels/`

### ⑧ Kill-Switch 執行控制

- Soft-pause：向執行中 worker 送出優雅停止信號
- Hard-kill：soft timeout 後強制終止
- 完整的 trigger / status / cancel API
- 詳見：`specs/daemonization/slices/kill-switch/`

### ⑨ App Market（MCP Marketplace）

- Managed MCP product 整合的 canonical feature root
- Mobile/app-market UX patterns
- 詳見：`specs/app-market/`

---

## 3) 使用方式總覽

角色分工先記住：

- `install.sh`：初始化環境
- `webctl.sh`：Web 啟停/refresh/狀態管理（唯一控制入口）
- `bun run dev`：TUI 互動入口（standalone 模式）
- `bun run dev --attach`：TUI 以 attach 模式連到現有 daemon

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

### A. TUI：高速控制台

TUI 有兩種執行模式：

#### Standalone 模式（預設）

```bash
bun run dev
```

TUI 自己啟動內建 server（Worker thread），TUI 結束時 server 一起結束。適合：
- 獨立開發工作流，不需要持續背景 daemon
- 快速進入 `/admin` 管 provider / account / model
- 保持鍵盤優先的操作效率

#### Attach 模式

```bash
bun run dev --attach
```

TUI 連到已存在的 daemon（透過 Unix socket），TUI 結束時 daemon 繼續跑。適合：
- 已透過 `webctl.sh` 或 gateway 啟動了 daemon
- 希望 TUI 關閉後背景 session 繼續執行
- 多視窗/多使用者共享同一個 daemon

也可以透過 `attach` 子指令連到遠端 server：

```bash
opencode attach http://localhost:4096
```

### B. Web App：瀏覽器控制台

```bash
# 開發模式
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
./webctl.sh flush          # 清理 stale runtime process
./webctl.sh flush --dry-run  # 預覽會被清理的 process
```

### C. Desktop（Tauri）

```bash
./install.sh --with-desktop --yes
bun run --cwd packages/desktop tauri dev
```

---

## 4) 系統架構總覽

cms 採 Monorepo 架構（Bun + TurboRepo），核心分層如下：

```text
┌──────────────────────────────────────────────────────┐
│ Interface Layer                                      │
│  TUI (/admin, standalone/attach)                     │
│  Web App (admin-lite, rich rendering)                │
│  Desktop (Tauri)                                     │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ Gateway Layer                                        │
│  C Gateway (port 1080, PAM auth, JWT, nginx proxy)   │
│  Per-user Unix socket daemon (fork+setuid+execvp)    │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ Runtime & API Layer                                  │
│  /provider  /account  /session  /auth  /cron         │
│  WebAuth / CSRF / PTY lifecycle                      │
│  Kill-switch control plane                           │
│  Durable scheduler (boot recovery)                   │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ Agent Runtime Layer                                  │
│  Smart Runner Governor (decision engine)             │
│  Workflow Runner (orchestration)                     │
│  Dialog Trigger Framework (deterministic triggers)   │
│  Planning Agent (plan_enter / plan_exit)             │
│  Builder Framework (beta admission)                  │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ Provider & Account Layer                             │
│  Canonical provider-key identity resolution         │
│  Rotation3D fallback (Provider/Account/Model)        │
│  Codex (AI SDK + WebSocket + incremental delta)      │
│  Google auth binding (PAM primary, OAuth secondary)  │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ Plugin & Capability Layer                            │
│  Built-in plugins (gemini-cli, codex, etc.)          │
│  MCP / Tools / Skills enablement registry            │
│  App Market (managed MCP products)                   │
└──────────────────────────────────────────────────────┘
```

### 4.1 自主執行架構（Autonomous Execution Stack）

`cms` 的自主執行能力分為三層：

#### Smart Runner Governor（已落地）

Smart Runner 是 session 級的決策引擎，在每個 autonomous turn 之間判斷下一步動作，輸出以下決策之一：

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

#### Autorunner Daemon（規劃中）

目標是把 session 從 conversation-turn-centric 提升為 daemon-owned long-lived job，以 event-sourced runtime model 管理 lifecycle、lease、heartbeat、checkpoint。

詳見：`docs/specs/autorunner_daemon_architecture.md`

### 4.2 Dialog Trigger Framework（已落地）

確定性（deterministic）、rule-first 的觸發偵測系統，非 AI-based governor：

- **三層架構**：Detector → Policy → Action
- **觸發詞彙**：`plan_enter`、`replan`、`approval`
- **Dirty-flag + next-round rebuild**：capability/tool-surface 變更用 dirty flag 推遲到下一輪，避免競態條件
- **Round-boundary 評估**：觸發只在 round 邊界判斷，不在 mid-stream 打斷

整合點：`prompt.ts`, `plan.ts`, `resolve-tools.ts`, `processor.ts`

詳見：`specs/dialog_trigger_framework/`

### 4.3 Planning Agent（已落地）

非平凡任務進入自主執行前，系統會優先導向 planning mode：

1. 偵測 request 為 planning-worthy（多檔案、架構敏感、scope 不明確）
2. 自動或建議進入 plan mode（`plan_enter` tool）
3. 以 question-driven clarification 釐清需求
4. 產出 plan file + 結構化 todo/action metadata（含 IDEF0 + Grafcet JSON companion artifacts）
5. `plan_exit` 後自然過渡到 build/continuous execution

Plan output 直接餵入 workflow runner 作為 todo 與 stop gate 的來源。

詳見：`docs/specs/planning_agent_runtime_reactivation.md`

### 4.4 Builder Framework & Beta Admission（已落地）

用於控制 build-mode 執行的分段 admission 流程：

- 機器可驗證的 quiz guard 作為 beta admission 閘門
- Mission metadata 編譯與持久化
- Continuation-time calibration 驗證
- 一次 reflection-based retry on incorrect answers
- Prompt text 為輔助說明，非主要 enforcement

詳見：`specs/agent_framework/slices/builder_framework/`

### 4.5 Webapp Rich Rendering（已落地）

Web App 支援豐富的內容渲染：

- Markdown file preview + click-to-open-file chat navigation
- Mermaid diagram 渲染
- Line/column 精確 file link
- SVG inline card 渲染（drawmiat MCP 整合）
- File tab focus 管理

詳見：`specs/webapp/rich-rendering/`

### 4.6 Provider-Key 統一遷移（已完成）

`cms` 已完成從 legacy `family` 欄位到 canonical **provider-key** 語義的全面遷移：

- 所有 account 操作、API route、SDK response 統一使用 `providerKey` 作為 primary key
- legacy `family` 欄位透過 compatibility alias 保留向後相容，但不再是 primary
- quota helper、selector path、state store 均已對齊 provider-key 語義

---

## 5) 核心設計原則

### A. 身分解析必須 canonical

- 所有 provider 身分以 canonical `providerKey` 為準（legacy `family` 僅作 compatibility alias）
- 使用 canonical resolver（如 `Account.resolveProviderKey(...)`）維持一致性

### B. 禁止靜默 Fallback

查找、解析、載入失敗時，必須明確報錯（`log.warn` / `throw`），不可悄悄退回備用路徑讓呼叫方以為成功。唯一例外：graceful degradation 是設計需求時（如 WebSocket → HTTP fallback），必須在 log 中記錄 fallback 原因。

### C. Provider 組裝順序固定

1. 載入 models（models.dev + snapshot）
2. 合併 config provider
3. 合併 env/auth
4. 合併 account overlays
5. 套用 plugin/custom loaders
6. 過濾並輸出最終 provider/model 視圖

### D. `disabled_providers` 為唯一可見性來源

provider 顯示/隱藏由同一配置欄位控制；`/admin` 的 Show All / Filtered 僅是視圖模式差異，不改變資料真相來源。

### E. Web Sync 採單一有效狀態（Effective State）

小型 mutation 優先走 partial refresh，而非一律 full bootstrap，避免 stale refresh、scroll reset 與 optimistic rollback 抖動。

### F. 禁止繞過 Bus messaging 自製非同步協調

- 禁止：`setTimeout` / `setInterval` / polling loop 等待另一 component 狀態就緒
- 禁止：隱式全域狀態傳遞跨模組訊號
- 正確做法：`Bus.publish()` / `Bus.subscribeGlobal()` / priority 控制 / `Instance.provide()`

---

## 6) 關鍵目錄

| 路徑 | 說明 |
|------|------|
| `packages/opencode/src/account/` | 帳號管理、rotation3d、限流判斷 |
| `packages/opencode/src/provider/` | provider 組裝、模型/健康度、橋接邏輯 |
| `packages/opencode/src/session/smart-runner-governor.ts` | Smart Runner 決策引擎 |
| `packages/opencode/src/session/workflow-runner.ts` | Workflow Runner orchestration |
| `packages/opencode/src/session/prompt/` | plan mode reminders、smart runner prompts |
| `packages/opencode/src/tool/plan.ts` | plan_enter / plan_exit 工具 |
| `packages/opencode/src/server/routes/` | `/provider`、`/account`、`/session` 等 API |
| `packages/opencode/src/cli/cmd/tui/` | TUI 與 `/admin` 互動流程（含 standalone/attach 雙模式） |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | TUI standalone 模式的 in-process server |
| `packages/opencode/src/plugin/` | provider 擴充插件 |
| `packages/opencode/src/cron/` | Durable scheduler（持久化排程） |
| `packages/opencode/src/plugin/codex*.ts` | Codex WebSocket + delta 整合 |
| `packages/opencode/src/session/dialog-trigger.ts` | Dialog Trigger Framework |
| `daemon/opencode-gateway.c` | C 語言 PAM gateway |
| `specs/` | 所有重大功能的設計規格 |
| `docs/specs/` | 架構規格延伸文件 |
| `docs/events/` | 重大事件與決策記錄 |

---

## 7) 資料持久化路徑

| 路徑 | 用途 |
|------|------|
| `~/.config/opencode/accounts.json` | 帳號與 provider 設定（primary） |
| `~/.config/opencode/cron/jobs.json` | Scheduler job 持久化狀態 |
| `~/.config/opencode/channels/<id>.json` | Per-channel 設定（規劃中） |
| `/etc/opencode/opencode.cfg` | Gateway runtime 設定（systemd） |
| `/etc/opencode/google-bindings.json` | Google OAuth ↔ Linux user binding |
| `/run/opencode-gateway/jwt.key` | JWT secret（file-backed, 0600） |
| `$XDG_RUNTIME_DIR/opencode/daemon.json` | Per-user daemon discovery 檔案 |
| `$XDG_RUNTIME_DIR/opencode/daemon.sock` | Per-user daemon Unix socket |

---

## 8) 分支與整合策略（重要）

- `cms` 是本環境主要產品線。
- 來自 `origin/dev` 或 `refs/*` 外部來源的變更，採 **分析後重構移植**，不可直接 merge。
- 本 repo 已作為獨立產品線維護，**預設不需要建立 PR**。
- `beta/*`、`test/*` 分支與其 worktree 僅作一次性實作/驗證用，完成後必須立即刪除。

---

## 9) 開發與驗證

```bash
bun install
bun run typecheck
bun test
```

如需完整架構、路由與模組說明，請讀：

- `specs/architecture.md`
- `docs/specs/`
- `docs/events/`

如需本機帳號/憑證設定，請放在 XDG runtime 路徑（如 `~/.config/opencode/`）；不要將 runtime secrets 同步回 repo。

---

## 10) 使用前準備（Prerequisites）

至少需要：

- `git`
- `curl`
- `bun`（本專案主要 runtime / package manager）

若要跑 Desktop（Tauri）另外需要：

- Rust toolchain（`rustup` / `cargo`）
- 平台對應 Tauri 系統套件（Linux/macOS/Windows 各異）

> Desktop 先決條件請參考：<https://v2.tauri.app/start/prerequisites/>

---

## 11) 一鍵初始化（install.sh）

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

`--system-init`（Linux）會額外做：

1. 建立專屬 service account（預設 `opencode`，`nologin`）
2. 準備 system runtime 目錄
3. 產生 `/etc/opencode/opencode.cfg`
4. 安裝 `/usr/local/libexec/opencode-run-as-user`
5. 安裝 `/etc/sudoers.d/opencode-run-as-user`
6. 安裝並啟用 `opencode-web.service`

也可以透過 `webctl.sh` 走安裝流程：

```bash
# production 預設（自動帶 --system-init）
./webctl.sh install --yes

# development 模式（不建立 systemd service）
./webctl.sh install --dev --yes
```

---

## 12) Web / TUI 操作建議（避免踩坑）

1. 先 `install.sh`，再做各模式啟動。
2. Web 模式不要手動拼 `opencode web` 命令，改用 `webctl.sh`。
3. 若要直接讓 repo 更新重新套用到目前活躍 web runtime，優先用 `./webctl.sh restart`。
4. 若只想手動拆步，前端改動後可先 `./webctl.sh build-frontend` 再 `dev-start` / `dev-refresh`。
5. 要做系統服務部署時，優先 `./webctl.sh install --yes`（production 預設）。
6. `./webctl.sh flush --dry-run` 會列出目前被判定為 stale interactive runtime 的 process；確認後可用 `./webctl.sh flush` 清理。
7. TUI 預設是 standalone 模式（自己跑 server）；如果已有 daemon 在背景，改用 `bun run dev --attach` 以免重複啟動。
