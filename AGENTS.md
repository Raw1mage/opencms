# OpenCode 專案開發指引

本檔案僅定義 opencode 專案**特有**的規範。通用規則（Plan / Fallback / Continuation / Autonomous Agent 核心紀律 / Mandatory Skills / Debug Contract / Infrastructure）由 Global `~/.config/opencode/AGENTS.md` 提供，本檔不重複。

---

## XDG Config 備份規則（opencode-specific）

**每次 plan 開跑前（或 beta-workflow admission 通過後、第一個程式碼編輯/測試指令前），必須備份 XDG 下的關鍵設定檔**。**只備份關鍵設定檔，不備份整個目錄** — 流水帳（log、checkpoint、snapshot、history、cache、node_modules、lock 檔、runtime state）會把備份撐到 GB 級、還原時也無意義。

- **備份範圍（白名單；只備這些檔，存在才備）**：
  - `~/.config/opencode/accounts.json` **（必備；歷史事故即來自此檔被抹）**
  - `~/.config/opencode/opencode.json`
  - `~/.config/opencode/managed-apps.json`
  - `~/.config/opencode/gauth.json`
  - `~/.config/opencode/mcp.json`
  - `~/.config/opencode/mcp-auth.json`
  - `~/.config/opencode/openai-codex-accounts.json`
  - `~/.config/opencode/models.json`
  - `~/.config/opencode/providers.json`
  - `~/.config/opencode/AGENTS.md`（global 規範本身）
  - `~/.local/share/opencode/accounts.json`（legacy 路徑，若存在）
- **明確不備份**（流水帳；備了只是浪費）：
  - `~/.config/opencode/node_modules/`、`bun.lock`、`package.json`（reproducible）
  - `~/.config/opencode/daemon.lock`、`usage-stats.json`、`AGENTS.md.bak*`、`*.bak*`（舊快照）
  - `~/.local/state/opencode/` 整個（`rebind-checkpoint-*`、`frecency.jsonl`、`prompt-history.jsonl`、`kv.json`、`rotation-state.json`、`log-level`、`ignored-models.json`、`model.json`、`__tasks__/`、`cyclebin/`）
  - `~/.local/share/opencode/` 下的 `log/`、`snapshot/`、`storage/`、`node_modules/`、`opencode.db`、`running-tasks.json`、`bun.lock`
- **備份位置**：`~/.config/opencode.bak-<YYYYMMDD-HHMM>-<plan-slug>/`（保留目錄形式以維持相對路徑，但裡頭只放白名單檔案）。時戳 + plan slug 方便事後追溯。
- **例外觸發擴大備份**：若該 plan 明確會動 state/data 層（例如改 `rotation-state.json` 結構、migration script 重寫 storage），才把對應目錄整個納入本次備份，並在 proposal.md / design.md 註明原因。預設不擴大。
- **還原政策**：**備份 ≠ 還原目標**。使用者在 AI 工作期間也會主動更新 XDG（新增帳號、改 config 等），AI **絕不可**自行用舊備份覆蓋現行 XDG。
  - plan 結束（無論 success / abort）後，**列出備份目錄位置**給使用者，並明確說「這是 plan 起跑前的白名單快照，僅供需要時手動還原」。
  - **只有在使用者明確要求「還原」時才執行 restore**；否則留著備份直到使用者說可以刪。
  - 除非使用者指示，不得主動 `cp` / `rsync` / `mv` 備份回 `~/.config/opencode/`。
- **Why**：beta 與 main 在同一 uid 下共用 `~/.config/opencode/`；任何 test / migration / `Account.normalizeIdentities` 路徑都可能透過 `Global.Path.user` 直寫真實檔案。2026-04-18 codex-rotation-hotfix 的測試跑過 `family-normalization.test.ts`，把 14 個 family 壓成 1 個，永久失去 5 個 codex 帳號 token（log 不記 refreshToken，rsync NAS 自 3/3 壞掉）。白名單只保留**不可重建**的認證 / 設定，流水帳被測試污染沒差、可再生。
- **唯一例外**：純 read-only inspection（`git log` / `grep` / `cat`）不動任何 state，可略過；但只要進入 plan 實作階段就**不可跳過**。
- **違規判定**：沒有 `opencode.bak-*-<plan-slug>/accounts.json` 存在的狀態下跑 `bun test` / `bun run ...` / 重啟 daemon，視為違規。

> 本規則 opencode-specific：因為 opencode 的測試會直接修改本機 `~/.config/opencode/`，其他專案一般不會有這風險。

---

## Daemon Lifecycle Authority（opencode-specific）

**AI 禁止自行 spawn / kill / restart opencode daemon 或 gateway 行程。** 唯一合法的自重啟路徑是呼叫 `system-manager:restart_self` MCP tool（內部 POST `/api/v2/global/web/restart`，由 gateway + `webctl.sh` 負責 rebuild + install + restart 的 orchestration）。

- **禁止指令範圍**（由 `packages/opencode/src/tool/bash.ts` 的 `DAEMON_SPAWN_DENYLIST` 擋下；實際規則以原始碼為準）：
  - `bun ... serve --unix-socket ...`
  - `opencode serve` / `opencode web`
  - 針對 daemon pid 的 `kill`（透過 `cat daemon.lock` 或 `pgrep opencode` 取得 pid）
  - `systemctl restart opencode-gateway`
- **違規後果**：Bash tool 直接拋 `FORBIDDEN_DAEMON_SPAWN`，不執行；gateway log 同步寫 `denylist-block rule=...`。
- **Why**：2026-04-20 事件——AI 透過 Bash 跑 `webctl.sh dev-start` 留下 orphan daemon 霸佔 gateway lock，使用者被踢登入 3+ 次直到人工清除。Daemon 生命週期的唯一權威是 gateway；daemon 自己 spawn / kill 兄弟 = 脫軌。
- **需要改 code 後讓它生效？** 呼叫 `restart_self`；webctl.sh 會 smart-detect dirty 層（daemon / frontend / gateway）並只 rebuild 變動部分。`targets: ["gateway"]` 會附 `--force-gateway` 讓 systemd respawn gateway 本體（期間所有使用者斷線 3-5s）。
- **rebuild 失敗怎麼辦？** `restart_self` 回 5xx 並帶 `errorLogPath`；系統維持舊版本可用。AI 讀 log、修正、再呼叫。絕不嘗試繞過。

---

## 專案背景

本專案源自 `origin/dev` 分支，現已衍生為 `main` 分支作為主要產品線。

### main 分支主要特色

- **全域多帳號管理系統** — 支援多個 provider 帳號的統一管理
- **rotation3d 多模型輪替系統** — 動態模型切換與負載平衡
- **Admin Panel (`/admin`)** — 三合一管理界面
- **Provider 細分化** — `gemini-cli`、`google-api` 獨立 canonical providers

---

## 整合規範

### 從 origin/dev 引進更新

任何從 GitHub pull 的 `origin/dev` 新 commits，都必須經過分析後再到 `main` 中重構，**不可直接 merge**。

### 外部 Plugin 管理

引進的外部 plugin 都集中放在 `/refs` 目錄。若有更新，也必須逐一分析後再到 `main` 中重構，**不可直接 merge**。

### Pull Request 預設策略

- 本 repo 已作為獨立產品線維護，**預設不需要建立 PR**。
- 除非使用者明確要求，否則預設流程停在 local commit / branch push 即可。

---

## Enablement Registry（能力總表）

- Runtime 單一真相來源：`packages/opencode/src/session/prompt/enablement.json`
- Template 對應來源：`templates/prompts/enablement.json`
- 凡透過 `mcp-finder` 或 `skill-finder` 擴充能力後，必須同步更新兩處。

---

## 部署架構

預計安裝到使用者端的設定檔都集中在 `templates/` 目錄，以 XDG 架構部署。

### Web Runtime 單一啟動入口（Fail-Fast）

- **只允許**透過 `./webctl.sh dev-start`（或 `dev-refresh`）啟動。
- 禁止直接使用 `bun ... opencode ... web` / `opencode web` 手動啟動。
- 所有 server runtime 參數集中定義於 `/etc/opencode/opencode.cfg`。

---

## Prompt/Agent 維護邊界

當任務是「開發 opencode 本身」時：

- **Global**: `~/.config/opencode/AGENTS.md` — 通用規範主體（所有專案共用）
- **Project**: `<repo>/AGENTS.md` — 專案特有補充（本檔；**不得重複 global 內容**）
- **Template**: `<repo>/templates/AGENTS.md` — release 後供使用者初始化

### 維護原則

1. **Template 與 Runtime 需同步**：規範變更需同時更新 `templates/**` 與 runtime 對應檔案。
2. **通用規則進 Global，opencode-specific 規則進 Project**：若發現新規則兩個地方都適用，放 Global；若僅 opencode 有意義（如 XDG 備份、webctl.sh 規則、rotation3d 細節），才進 Project。
3. **Template 的 AGENTS.md 應鏡像 Global + 其 release 必要的 opencode 補充**，而非鏡像 Project。
4. **變更留痕**：記錄於 `docs/events/`。
5. **Beta/Test 分支用後即刪**：`beta/*`、`test/*` 分支與其 worktree 僅作一次性實作/驗證面。測試完成且 merge/fetch-back 回 `main` 後，必須立即刪除；禁止長留已完成任務的 beta/test 分支，避免 stale branch 在後續被誤認為主線或被 branch-pointer 操作拉回。

### Release 前檢查清單

- [ ] `templates/**` 與 `runtime` 已同步
- [ ] `templates/AGENTS.md` 與 `templates/prompts/SYSTEM.md` 一致
- [ ] `docs/events/` 已記錄
- [ ] `specs/architecture.md` 已同步
