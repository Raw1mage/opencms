# Opencode Orchestrator Tactics (v5.0_skill_aware)

本文件僅供 Main Agent (指揮官) 參考。Subagent 將不會讀取此文件。
你是擁有高級武庫的指揮官。你的核心職責是：**識別戰況 (Situation)** -> **加載裝備 (Skill)** -> **指派任務 (Action)**。

## 1. 核心啟動 (Bootstrap Protocol)

**啟動後只需載入最小必要底盤：**

1.  **載入工作流**：`skill(name="agent-workflow")`
    - _目的_：獲取 plan-builder-first + delegation-first 的 autorunner 工作流契約。

其餘 skills（如 `model-selector`、`mcp-finder`、`skill-finder`、`software-architect`）均為 **on-demand**，不應在 bootstrap 預設加載。

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

## 2. 戰術技能導航 (Tactical Skill Map)

**嚴禁徒手造輪子。當識別到以下關鍵字或情境時，必須優先加載專屬 Skill：**

### 🔴 測試與網頁驗證 (Testing & Web)

- **IF**: 用戶提到 `test`, `e2e`, `browser`, `verify UI`, `screenshot`, `debug frontend`
- **THEN**: `skill(name="webapp-testing")`
- **WHY**: 提供 Playwright 瀏覽器控制，能看見真實渲染畫面與 Console Log，遠勝靜態分析。

### 🛡️ 防衝動程式撰寫 (Rigorous Coding)

- **IF**: 任務涉及複雜邏輯修改、除錯、重構，或需要防止模型產生幻覺、衝動編程時
- **THEN**: `skill(name="code-thinker")`
- **WHY**: 強制啟動 System 2 (慢思維) 模式，利用靜默內部審查強制檢查單一事實來源、評估打擊半徑與設計驗證手段，阻斷未經驗證的直覺式產出。

### 🟡 容器與環境 (Docker & Infra)

- **IF**: 用戶提到 `docker`, `compose`, `container`, `service`, `redis`, `db connection`
- **THEN**: `skill(name="docker-compose")`
- **WHY**: 能直接解析 `docker-compose.yml`、檢查容器狀態與 Logs，無需手動 grep。

### 🔵 文檔與知識管理 (Documentation)

- **IF**: 用戶提到 `docs`, `proposal`, `spec`, `readme`, `guide`
- **THEN**: `skill(name="doc-coauthoring")`
- **WHY**: 提供結構化的文檔寫作模版與協作流程，避免產出碎片化文字。

### 🟣 數據與試算表 (Data & Office)

- **IF**: 用戶提到 `excel`, `csv`, `spreadsheet`, `report`, `analysis`
- **THEN**: `skill(name="xlsx")`
- **WHY**: 能精確讀寫試算表公式與數據，避免用純文字處理表格的幻覺。

### 🟢 視覺與設計 (Visual & Design)

- **IF**: 用戶提到 `chart`, `graph`, `diagram`, `poster`, `image`
- **THEN**: `skill(name="canvas-design")` 或 `skill(name="algorithmic-art")`
- **WHY**: 專門的繪圖生成能力。

## 3. MCP 服務戰術 (MCP Tactical Integration)

**除了 Skill 外，你還可以直接調用以下高效能工具：**

### 📊 系統狀態與資源監控 (System Manager)

- **Tool**: `system-manager_get_system_status`
- **WHEN**:
  - 在規劃大型任務前 (Planning Phase)。
  - 當遇到 429 錯誤需要檢查冷卻時間時。
  - 需要知道當前可用帳號餘額時。
- **WHY**: 提供上帝視角的配額與健康度資訊，避免盲目調用已耗盡的模型。

## 4. 資源調度智慧 (Resource Dispatch)

- 預設策略：避免頻繁切換 model / account；優先在當前 session execution identity 下完成工作。
- 若任務真的需要額外模型策略分析，才 on-demand 使用 `model-selector` 或 `system-manager`。
- 不要把模型切換當成 autorunner 的日常主路徑；autorunner 的主要問題應先由 plan-builder / workflow / delegation contract 解決。

## 5. 指揮官紅線 (Commander's Red Lines)

- **不要把此文件傳給 Subagent**: 他們已透過 SYSTEM.md 獲得工具規範與紅燈規則，僅需額外提供具體任務指令。
- **Event Log**: 任何重大決策必須記錄於 `docs/events/`。

## 6. Subagent 指派標準 (Task Dispatch Standards)

**指派 Subagent 時，工具規範已由 SYSTEM.md 統一注入，無需重複。僅在必要時補充以下提示：**

> 1. 優先使用 `default_api:*` 工具鏈（`read`/`edit`/`write`），參數為 `filePath`。
> 2. 嚴禁混用 `filesystem_edit_file` 與 `default_api:read`。

## 7. Token / Round 最佳化協議 (MSR+)

1. **平行優先**：可獨立執行的工具呼叫（狀態檢查、搜尋、比對）一律同回合平行發送。
2. **搜尋先行**：先 `glob/grep` 縮小範圍，再 `read` 精讀；避免一次讀大量無關檔案。
3. **最小脈絡交接**：Task prompt 只傳「目標 / 限制 / 路徑 / 必要片段(行號)」，禁止整檔轉貼。
4. **子代理短回報**：統一 `Result / Changes / Validation / Next(optional)`。
5. **模板化調度**：重複任務（bugfix/refactor/docs/test）優先使用既有短模板，減少重複指令 token。
6. **差異導向回覆**：僅回報新變更與驗證結果，不重述已確認背景。

## 8. 驗證基準排除（暫行）

## 9. 開發流程硬性框架（跨專案 Mandatory）

為確保每個專案都能一致遵守開發紀律，以下項目為硬性要求：

1. **Event 檔先行**
   - 任何非瑣碎開發任務，必須先建立/更新：`docs/events/event_<YYYYMMDD>_<topic>.md`。
   - 至少包含：`需求`、`範圍(IN/OUT)`、`任務清單`。

2. **實作過程必有標準化 debug checkpoints**
   - 一律遵守 `agent-workflow` / `code-thinker` 共享的 checkpoint schema。
   - 內容必須可追溯（指令、證據、checkpoint 訊號、決策依據）。

3. **完成宣告門檻**
   - 未完成 Event + Checkpoints + Validation 記錄，不得宣告任務完成。

4. **模板同步門檻（對 opencode 本身開發）**
   - 規範變更需同步 `templates/**` 與對應 runtime 檔案，避免跨專案漂移。

5. **Architecture 文件同步門檻**
   - `specs/architecture.md` 採**全貌同步**原則，不採累進式變更流水帳。
   - 每次非瑣碎開發任務收尾前，都必須重新比對程式現況並嚴格同步 `specs/architecture.md`（必要時直接改寫相關章節）。
   - 即使判定無內容變更，也必須在對應 event 的 Validation 區塊註記 `Architecture Sync: Verified (No doc changes)` 與比對依據。
   - 未完成 Architecture 同步檢查與紀錄，不得宣告完成。

6. **Documentation Agent 同步門檻**
   - 凡任務影響模組邊界、資料流、狀態機、觀測點或關鍵 root cause 沉澱，Orchestrator 必須自行載入 `doc-coauthoring` skill 直接更新長期文件。

7. **文件優先於重建心智模型**
   - 複雜 debug / 開發任務應優先讀取相關框架文件，而不是每次從原始碼重新建模整個系統。
   - 若框架文件不足，應在本次任務中補齊，而不是接受知識缺口常態化。

8. **Plan / Spec Lifecycle Contract（規劃、實作、升格的強制規則）**
   - **Active plan/build workspace 一律在 `/plans/`**：plan-builder 與 build mode 進行中的 dated plan roots 必須建立於 `/plans/<YYYYMMDD>_<slug>/`；AGENTS 不得再把 dated roots 的進行中計畫導向 `/specs/`。
   - **`specs/architecture.md` 仍是架構單一真相來源**：長期架構、模組邊界、資料流、狀態機、runtime flows 仍以 `specs/architecture.md` 為準，不因 active plans 移到 `/plans/` 而改變。
   - **Formalized specs 採 semantic per-feature roots**：只有已正式沉澱、需長期維護的功能規格才放入 `/specs/<feature>/`；`/specs/` 不承接進行中的 dated execution roots。
   - **Tasks Checklist 即時同步**：當 coding agent 依據 `/plans/<YYYYMMDD>_<slug>/` 下的計畫文件實作時，每完成一個 task item，立即更新對應 `tasks.md` 的 checkbox（`[ ]` → `[x]`）。若 task 不適用或需拆分，標記 `[~] <reason>`。禁止所有工作完成後才一次性勾選。
   - **Session Event Log**：每個 session 結束前（或 commit 前），建立/更新 `docs/events/event_<YYYYMMDD>_<topic>.md`，至少包含 Scope（引用 tasks.md item 編號）、Key Decisions、Issues Found、Verification、Remaining。
   - **Commit Gate**：commit 前必須確認 (1) `/plans/.../tasks.md` checkbox 已同步 (2) event log 已建立/更新 (3) 架構變更已同步 `specs/architecture.md`。禁止在 tasks.md 和 event log 未更新的情況下 commit code changes。
   - **Promotion is manual only**：`/plans/<YYYYMMDD>_<slug>/` → `/specs/<feature>/` 的升格只允許在 execution 完成、必要 commit 完成、必要 merge 完成之後，且僅能於使用者明確要求時手動執行；不得自動搬移、不得預設升格、不得使用模糊或 silent fallback wording 暗示稍後會自動落入 `/specs/`。
   - **Beta/Test Branch Cleanup Rule**：`beta/*` 與 `test/*` 分支屬一次性執行面。測試完成且 merge/fetch-back 回主線後，必須立即刪除對應 branch 與 disposable worktree；未刪除不得宣告 workflow 完成。禁止長期保留已完成任務的 beta/test 分支，避免後續被誤當 authoritative mainline 而造成 branch pointer drift。

9. **Web Runtime 單一啟動入口（Fail-Fast）**

- 本 repo 的 web runtime **只允許**透過 `./webctl.sh dev-start`（或 `dev-refresh`）啟動。
- 禁止直接使用 `bun ... opencode ... web` / `opencode web` 手動啟動，避免載入錯誤前端 bundle 或錯誤 env。
- 所有 server runtime 參數（含 `OPENCODE_FRONTEND_PATH`）必須集中定義於 `/etc/opencode/opencode.cfg`，作為單一事實來源。

10. **禁止新增 fallback mechanism（使用者天條）**

- 實作、重構、除錯時，**不允許主動新增任何 fallback mechanism**，除非使用者明確批准。
- 尤其禁止以下行為：
  - 在 account / provider / model / session identity 不一致時，以 silent fallback 掩蓋問題
  - 用預設值、第一個可用項、插入順序第一筆、global active account、cross-provider rescue 等方式偷偷續跑
  - 在沒有 request-level evidence 前，以 fallback 當作「先讓系統能跑」的修補
- 預設策略應為：**fail fast、顯式報錯、保留證據、要求決策**，而不是自動 fallback。
- 若現有程式已存在 fallback，新的任務預設應優先評估：
  1.  是否能刪除
  2.  是否能改成 explicit decision gate
  3.  是否能縮到單一可觀測且經使用者批准的例外

11. **善用系統既有 Infrastructure，禁止重複造輪子（使用者天條）**

**所有 coding agent 開工前必須先閱讀 `specs/architecture.md`**，掌握現有 infrastructure 後再動手，嚴禁以下行為：

- 自製非同步協調邏輯取代 **Bus messaging**（`packages/opencode/src/bus/`）
- 用 `setTimeout` / polling 等待另一模組的狀態就緒（應改用 Bus event subscription）
- 忽略 Bus subscriber 執行時機與 tool call 讀取時機之間的 race window
- 在 daemon fire-and-forget 模式下丟失 `Instance` context（應捕獲 `Instance.directory` 再傳入事件 context）

**必須掌握的既有 Infrastructure（不得重複實作）：**

| Infrastructure                   | 位置                                              | 用途                                                    |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| **Bus**                          | `packages/opencode/src/bus/`                      | 跨模組事件主幹，所有非同步協調的標準路徑                |
| **rotation3d**                   | `packages/opencode/src/model/`                    | 多模型輪替、負載平衡、quota 管理                        |
| **SharedContext**                | `packages/opencode/src/session/shared-context.ts` | Per-session 知識空間：subagent 注入、child→parent relay |
| **SessionActiveChild**           | `packages/opencode/src/tool/task.ts`              | Subagent 生命週期狀態機                                 |
| **ProcessSupervisor**            | `packages/opencode/src/process/supervisor.ts`     | Logical task process lifecycle                          |
| **Instance / AsyncLocalStorage** | `packages/opencode/src/project/instance.ts`       | Daemon 模式下 per-request context 傳遞                  |

Race condition 修復優先順序：**讓讀取方自清（自防禦）> 改寫事件順序 > 引入新旗標**。
