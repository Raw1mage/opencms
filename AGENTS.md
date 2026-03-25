# OpenCode 專案開發指引

本檔案定義 opencode 專案特有的開發規範。通用工作流程請參閱 `agent-workflow` skill。

## 核心工程技能棧 (Workflow-First)

本專案為 AI Agent 平台，開發時的**唯一預設 workflow skill** 是 `agent-workflow`。

- `agent-workflow`：autorunner / planner / build mode 的共同底盤，負責 plan-building、delegation-first execution、stop gates、validation 與 completion gate。
- 其他 skills（如 `code-thinker`, `webapp-testing`, `doc-coauthoring`, `docker-compose`, `software-architect`, `mcp-finder`, `skill-finder`, `model-selector`）一律視為 **on-demand 裝備**，只有在任務明確命中能力缺口時才載入。
- 規則：不要為了「可能有用」而預設加載 skills；bootstrap 應維持最小必要，直接服務 autorunner execution loop。

## 語言回應規範

- 對使用者的預設回應語言一律使用**繁體中文**。
- 若使用者明確要求其他語言，或任務本身需要保留原文/特定語言格式，再依需求切換。

### 開發任務預設工作流（Mandatory Trigger）

- 只要使用者提出**非瑣碎開發需求**（例如 implement / build / fix / refactor / debug / write tests / continue plan / make it autonomous），Main Agent **必須**以 `skill(name="agent-workflow")` 作為預設 workflow。
- `agent-workflow` 在此不只是通用 SOP，而是 autonomous-ready contract。進入 EXECUTION 前，必須先建立最小可執行計畫骨架：
  - `goal`
  - structured todos（優先使用 `todowrite` + `action` metadata）
  - `dependsOn`
  - approval / decision / blocker gates
  - validation plan
- 若上述骨架尚未成立，**不得**宣稱可安全 autonomous 持續執行；必須先補 plan，再進入 execution。
- 在 planning / clarification 階段，凡屬於**有明確選項的選擇題**（例如 milestone、scope、approval posture、validation target、delegation strategy），**預設必須使用 MCP `question`** 呈現，而不是用自由文字把選項混在 prose 內；只有在使用者需要先用長篇背景補充脈絡時，才先 freeform 再用 `question` 收斂決策。
- 若任務變更模組邊界、資料流、狀態機、debug checkpoints 或沉澱了重要 root cause，Main Agent **必須**自行載入 `doc-coauthoring` + `miatdiagram` skills 並直接更新框架文件。文件工作不委派 subagent。
- 其他技能（如 `code-thinker`, `webapp-testing`, `doc-coauthoring`）屬於按需加值裝備；`agent-workflow` 是所有非瑣碎開發任務的唯一預設底盤。

### 核心文件責任分工（Hard-coded）

- `specs/architecture.md`
  - 記錄全 repo 長期框架知識：模組邊界、資料流、狀態機、runtime flows、核心目錄樹、debug/observability map。
- `docs/events/event_<YYYYMMDD>_<topic>.md`
  - 記錄每次任務的需求、範圍、對話重點摘要、debug checkpoints、決策、驗證與 architecture sync。
- 所有複雜 debug / 開發任務，應優先先讀 `specs/architecture.md` 與相關 `docs/events/`，再進入原始碼偵查。

### 全域 Debug / Syslog 契約（Mandatory）

- 往後所有開發 / debug 工作一律採 **system-first、boundary-first、evidence-first** 思維。
- 遇到複雜 bug（例如 reload blank、state mismatch、跨層 sync、race、multi-component failure）時，不得只憑局部 symptom 判斷；必須先拆：
  - 系統層次
  - component boundaries
  - 資料 / 狀態 / config 傳遞路徑
- 所有 debug 任務都必須遵守 `agent-workflow` 與 `code-thinker` 共用的 syslog-style debug contract。
- 具體 checkpoint schema、instrumentation plan 與 component-boundary 規則，以對應 skill 為單一真實來源。
- 沒有 checkpoint evidence，不得宣稱已找到 root cause。

### Enablement Registry（能力總表）

- Runtime 單一真相來源：`packages/opencode/src/session/prompt/enablement.json`
- Template 對應來源：`templates/prompts/enablement.json`
- 用途：集中維護 tools / skills / MCP 的能力說明、路由建議、on-demand 啟停策略。
- 規範：凡透過 `mcp-finder` 或 `skill-finder` 擴充能力後，必須同步更新 `enablement.json`（runtime + template）。

---

## 專案背景

本專案源自 `origin/dev` 分支，現已衍生為 `cms` 分支作為主要產品線。

### cms 分支主要特色

- **全域多帳號管理系統** - 支援多個 provider 帳號的統一管理
- **rotation3d 多模型輪替系統** - 動態模型切換與負載平衡
- **Admin Panel (`/admin`)** - 三合一管理界面
- **Provider 細分化** - 將原本的 `google` provider 拆分為獨立的 canonical providers：
  - `gemini-cli`
  - `google-api`

  以便充分利用每一 provider 提供的資源

---

## 整合規範

### 從 origin/dev 引進更新

任何從 GitHub pull 的 `origin/dev` 新 commits，都必須經過分析後再到 `cms` 中重構，**不可直接 merge**。

### 外部 Plugin 管理

引進的外部 plugin 都集中放在 `/refs` 目錄。若有更新，也必須逐一分析後再到 `cms` 中重構，**不可直接 merge**。

### Pull Request 預設策略

- 本 repo 已作為獨立產品線維護，**預設不需要建立 PR**。
- 除非使用者明確要求，否則完成本 repo 內部開發工作後，預設流程停在 local commit / branch push（若有需要）即可，不主動提議或執行 PR 建立。
- 若任務是要回提交上游、外部 fork、或團隊審查流程明確要求 PR，才進入 PR workflow。

---

## 部署架構

預計安裝到使用者端的設定檔都集中在 `templates/` 目錄，以 XDG 架構部署。

### Web Runtime 單一啟動入口（Fail-Fast）

- 本 repo 的 web runtime **只允許**透過 `./webctl.sh dev-start`（或 `dev-refresh`）啟動。
- 禁止直接使用 `bun ... opencode ... web` / `opencode web` 手動啟動，避免載入錯誤前端 bundle 或錯誤 env。
- 所有 server runtime 參數（含 `OPENCODE_FRONTEND_PATH`）必須集中定義於 `/etc/opencode/opencode.cfg`，作為單一事實來源。

---

## 開發 opencode 本專案時的 Prompt/Agent 維護邊界

當任務是「開發 opencode 本身」時，請遵循以下分層與同步原則：

- **Global**: `~/.config/opencode/AGENTS.md`
- **Project**: `<repo>/AGENTS.md`
- **Template**: `<repo>/templates/AGENTS.md`（release 後供使用者初始化 global 設定）

### 維護原則

1. **Project AGENTS 由專案維護者規劃**：本檔作為專案內規範主體，重大策略先在此定義。
2. **Template 與 Runtime 需同步**：凡影響預設行為的流程/規範變更，需同時更新：
   - `templates/**`（發布到使用者端的來源）
   - `runtime` 對應檔案（例如 `$XDG_CONFIG_HOME/opencode/skills/**`）
3. **避免僅改 Global**：`~/.config/opencode/*` 屬本機執行環境，不作為 repo 交付依據。
4. **變更留痕**：所有重大決策與同步範圍需記錄於 `docs/events/`。
5. **Session 啟動必讀 Architecture**：每次開啟新 session（Main Agent）處理本專案前，必須先讀取 `specs/architecture.md`，再進行分析與規劃。
6. **文件同步門檻**：凡任務影響模組邊界、資料流、狀態機、觀測點或關鍵 root cause 沉澱，Orchestrator 必須自行載入 `doc-coauthoring` skill 直接更新長期文件。

### 跨專案 SOP 基線（Mandatory）

為了讓未來每個開發案都一致遵守流程，以下要求視為「交付前強制門檻」：

1. **任務開工前必有 event 檔**：
   - 路徑：`docs/events/event_<YYYYMMDD>_<topic>.md`
   - 至少包含：`需求`、`範圍(IN/OUT)`、`任務清單`。

2. **實作過程必有標準化 debug checkpoints**：
   - 一律遵守 `agent-workflow` / `code-thinker` 共享的 checkpoint schema。
   - 內容必須可追溯（指令、證據、checkpoint 訊號、決策依據）。

3. **完成回報必有驗證區塊**：
   - 明確列出通過/失敗項目，不可只寫「已測試」。
   - 若有已知噪音，需引用對應規範與豁免理由。

4. **禁止跳步收尾**：
   - 未更新 `docs/events`（含 debug/驗證）不得宣告完成。
   - 未同步 `templates/**` 的規範變更不得進入 release。

5. **Architecture 文件同步門檻**：
   - `specs/architecture.md` 採**全貌同步**原則，不採累進式變更流水帳。
   - 每次非瑣碎開發任務收尾前，都必須重新比對程式現況並嚴格同步 `specs/architecture.md`（必要時直接改寫相關章節）。
   - 即使判定無內容變更，也必須在對應 event 的 Validation 區塊記錄 `Architecture Sync: Verified (No doc changes)` 與比對依據。
   - 未完成 Architecture 同步檢查與紀錄，不得宣告完成。
6. **文件優先於重建心智模型**：
   - 複雜 debug / 開發任務應優先讀取相關框架文件，而不是每次從原始碼重新建模整個系統。
   - 若框架文件不足，應在本次任務中補齊，而不是接受知識缺口常態化。

7. **Plan / Spec Lifecycle Contract（規劃、實作、升格的強制規則）**：
   - **Active plan/build workspace 一律在 `/plans/`**：planner 與 build mode 進行中的 dated plan roots 必須建立於 `/plans/<YYYYMMDD>_<slug>/`；AGENTS 不得再把 dated roots 的進行中計畫導向 `/specs/`。
   - **`specs/architecture.md` 仍是架構單一真相來源**：長期架構、模組邊界、資料流、狀態機、runtime flows 仍以 `specs/architecture.md` 為準，不因 active plans 移到 `/plans/` 而改變。
   - **Formalized specs 採 semantic per-feature roots**：只有已正式沉澱、需長期維護的功能規格才放入 `/specs/<feature>/`；`/specs/` 不承接進行中的 dated execution roots。
   - **Tasks Checklist 即時同步**：當 coding agent 依據 `/plans/<YYYYMMDD>_<slug>/` 下的計畫文件實作時，每完成一個 task item，立即更新對應 `tasks.md` 的 checkbox（`[ ]` → `[x]`）。若 task 不適用或需拆分，標記 `[~] <reason>`。禁止所有工作完成後才一次性勾選。
   - **Session Event Log**：每個 session 結束前（或 commit 前），建立/更新 `docs/events/event_<YYYYMMDD>_<topic>.md`，至少包含 Scope（引用 tasks.md item 編號）、Key Decisions、Issues Found、Verification、Remaining。
   - **Commit Gate**：commit 前必須確認 (1) `/plans/.../tasks.md` checkbox 已同步 (2) event log 已建立/更新 (3) 架構變更已同步 `specs/architecture.md`。禁止在 tasks.md 和 event log 未更新的情況下 commit code changes。
   - **Promotion is manual only**：`/plans/<YYYYMMDD>_<slug>/` → `/specs/<feature>/` 的升格只允許在 execution 完成、必要 commit 完成、必要 merge 完成之後，且僅能於使用者明確要求時手動執行；不得自動搬移、不得預設升格、不得使用模糊或 silent fallback wording 暗示稍後會自動落入 `/specs/`。

### Release 前檢查清單（Prompt / Agent / Skill）

- [ ] 若調整工作流或規範，已同步更新 `templates/**` 與對應 `runtime`（如 `$XDG_CONFIG_HOME/opencode/skills/**`）。
- [ ] 若調整初始化行為，已確認 `templates/AGENTS.md` 與 `templates/prompts/SYSTEM.md` 一致。
- [ ] 若調整執行時技能，已確認 `$XDG_CONFIG_HOME/opencode/skills/**` 與 `templates/skills/**` 無漂移。
- [ ] 已在 `docs/events/` 記錄：變更目的、範圍、同步面、風險。
- [ ] 本次任務已完成 `specs/architecture.md` 全貌同步檢查；若無內容變更，已在 event Validation 註記 `Architecture Sync: Verified (No doc changes)` 與依據。
- [ ] 僅將 `~/.config/opencode/*` 視為本機環境，不作為 release 交付來源。

### 驗證基準排除（暫行）

---

## Subagent Skill Mapping（委派技能對照表）

Orchestrator 在委派 subagent 時，**必須**根據下表指示 subagent 載入對應 skill：

| Agent Type        | Skill to Load                    | 說明                                                                    |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `coding`          | `code-thinker`                   | 靜默內部審查、Two-Phase Execution、Anti-hallucination guard             |
| `testing`         | `webapp-testing`（暫定）         | Playwright 測試、瀏覽器自動化、UI 驗證。待泛用 testing skill 出現後替換 |
| `review`          | `code-review`                    | SOLID 違規偵測、安全風險、可操作改進建議                                |
| Orchestrator 自身 | `doc-coauthoring`, `miatdiagram` | 文件由 Orchestrator 直接撰寫，不委派 subagent                           |
| `explore`         | —（無需額外 skill）              | 方法論已內嵌於 explore prompt，無需外部 skill                           |

### 使用規則

1. Orchestrator 在 `task()` 的 delegation prompt 開頭必須加入：`FIRST: Load skill "<skill-name>" before starting work.`（多個 skill 時依序列出）
2. 若 AGENTS.md 指定了 skill，Orchestrator **不得**省略此指示。
3. `explore` agent 是唯一例外——其搜尋方法論已內建於 system prompt。
4. 若未來新增 agent type，必須同步更新此對照表。

---

## 技能管理與主動協助 (Skill Management & Proactive Assistance)

Orchestrator 應具備高度的機動性，隨時分析使用者意圖並主動提供技能建議：

1.  **意圖識別與技能建議**：
    - 當對話內容涉及特定領域（如：文檔撰寫、測試、資料分析、繪圖等）時，應檢查是否已載入對應的 Skill。
    - 若未載入，應**主動建議**使用者載入相關 Skill (例如：`doc-coauthoring`, `webapp-testing`, `xlsx` 等)，並說明該 Skill 能帶來的效益。

2.  **能力擴充屬例外，不是 bootstrap 預設**：
    - `skill-finder` / `mcp-finder` 保留為 on-demand 能力，不再視為預設加載項。
    - 只有在現有能力確實不足、且缺口可以透過外部 skill / MCP 補上時，才建議載入。
    - 說明：避免把「可能有用的擴充」混入 autorunner 的日常執行底盤。

---

## 使用者天條：禁止新增 fallback mechanism

- 實作、重構、除錯時，**不允許主動新增任何 fallback mechanism**，除非使用者明確批准。
- 尤其禁止以下行為：
  - 在 account / provider / model / session identity 不一致時，以 silent fallback 掩蓋問題
  - 用預設值、第一個可用項、插入順序第一筆、global active account、cross-provider rescue 等方式偷偷續跑
  - 在沒有 request-level evidence 前，以 fallback 當作「先讓系統能跑」的修補
- 預設策略應為：**fail fast、顯式報錯、保留證據、要求決策**，而不是自動 fallback。
- 若現有程式已存在 fallback，新的任務預設應優先評估：
  1. 是否能刪除
  2. 是否能改成 explicit decision gate
  3. 是否能縮到單一可觀測且經使用者批准的例外

---

## 使用者天條：善用系統既有 Infrastructure（禁止重複造輪子）

### 強制前置條件：所有 coding agent 開工前必讀 architecture.md

- **任何 coding / implement / fix / refactor 任務，開工前必須先完整閱讀 `specs/architecture.md`**，建立對系統現有 infrastructure 的完整認知。
- 禁止在未讀架構文件的情況下直接撰寫跨模組的非同步協調邏輯。
- 若 `specs/architecture.md` 尚未記載某個模組，應先補文件，再動手實作。

### 禁止繞過 Bus messaging 自製非同步協調

本系統已有成熟的 **Bus messaging framework**（`packages/opencode/src/bus/`），任何跨模組的非同步狀態協調**必須透過 Bus**，嚴禁自製 race-prone 替代方案：

- **禁止**：用 `setTimeout` / `setInterval` / polling loop 等待另一個 component 的狀態就緒
- **禁止**：依賴 `AsyncLocalStorage` 以外的隱式全域狀態傳遞跨模組訊號
- **禁止**：假設某個 async 操作（Bus subscriber、event handler）一定在另一個操作之前完成——若有順序依賴，必須用 Bus event chain 明確表達
- **正確做法**：
  - 跨模組狀態變更 → `Bus.publish(Event, payload, { context })`
  - 跨模組狀態監聽 → `Bus.subscribeGlobal(Event.type, priority, handler)`
  - 需要保證在 handler 之前執行 → 使用較低的 `priority` 數字（數字越小越優先）
  - Daemon 模式下需保留 Instance context → `event.context?.directory` + `Instance.provide({ directory, fn })`

### 已建立的 Infrastructure（開工前必須掌握）

所有實作必須建立在下列既有基礎設施上，**不得重複實作**：

| Infrastructure | 位置 | 用途 |
|---|---|---|
| **Bus** | `packages/opencode/src/bus/` | 跨模組事件發佈/訂閱，所有非同步協調的主幹 |
| **rotation3d** | `packages/opencode/src/model/` | 多模型輪替、負載平衡、quota 管理 |
| **SharedContext** | `packages/opencode/src/session/shared-context.ts` | Per-session 知識空間：subagent 注入、child→parent relay、compaction summary |
| **SessionActiveChild** | `packages/opencode/src/tool/task.ts` | Subagent 生命週期狀態機（running / handoff / null） |
| **ProcessSupervisor** | `packages/opencode/src/process/supervisor.ts` | Logical task process lifecycle 管理 |
| **Instance / AsyncLocalStorage** | `packages/opencode/src/project/instance.ts` | Daemon 模式下 per-request project context 傳遞 |
| **compaction pipeline** | `packages/opencode/src/session/compaction.ts` | Context overflow 與 idle compaction，整合 SharedContext |

### Race Condition 審查義務

- 凡涉及跨模組狀態讀寫（尤其是 session state、active child、workflow state），**必須先審查是否存在 race window**，再動手改動。
- 常見 race 模式（已發生過，不得重蹈）：
  - Bus subscriber 清除狀態的時機 vs. tool call 讀取狀態的時機不同步
  - Daemon fire-and-forget async loop 遺失 Instance context
  - 依賴 `status === "completed"` 偵測 turn boundary，但 fire-and-forget 模式下狀態是 `"running"`
- 修復 race 的正確優先順序：**讓讀取方自清（自防禦）> 改寫事件順序 > 引入新鎖/旗標**
