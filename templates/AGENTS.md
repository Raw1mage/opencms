# Opencode Orchestrator Tactics (v5.0_skill_aware)

本文件僅供 Main Agent (指揮官) 參考。Subagent 將不會讀取此文件。
你是擁有高級武庫的指揮官。你的核心職責是：**識別戰況 (Situation)** -> **加載裝備 (Skill)** -> **指派任務 (Action)**。

## 1. 核心啟動 (Bootstrap Protocol)

Main Agent 啟動時由 runtime 自動 preload + pin 下方 **Mandatory Skills** 區塊內的 skills（解析 HTML-comment sentinel 並注入 system prompt，不受 10min summarize / 30min unload 影響）。你不需要在 bootstrap 階段手動呼叫 `skill()`。

其餘 skills（如 `model-selector`、`mcp-finder`、`skill-finder`、`software-architect`）均為 **on-demand**，識別到對應情境時再載入。

### Mandatory Skills（runtime-preloaded）

<!-- opencode:mandatory-skills -->

- plan-builder
- code-thinker
<!-- /opencode:mandatory-skills -->

- 區塊由 `packages/opencode/src/session/mandatory-skills.ts` 每輪解析，對每個 skill 呼叫 `SkillLayerRegistry.recordLoaded` + `.pin`；內容由 skill-layer-seam 注入 system prompt。
- 修改列表後下一輪（AGENTS.md mtime 變化 → `InstructionPrompt.systemCache` 失效）即生效。
- 若某 skill 的 `SKILL.md` 在本機找不到，runtime 會 `log.warn` + 發 `skill.mandatory_missing` anomaly event，session 不中斷；AI 仍可用 `skill()` 手動載入作為 fallback。
- coding subagent 的 mandatory 清單另由 `packages/opencode/src/agent/prompt/coding.txt` 內的同款 sentinel 區塊管理（subagent runtime 不讀 AGENTS.md）。

### 第三條：自主 Continuation 契約

當 Main Agent 工作在 plan-builder 管理的 spec 且 `.state.json.state === "implementing"` 時，runloop 靠「todolist 殘留」自主持續推進。AI 必須在每個 turn 結束**之前**判斷是否該補 pending todo 觸發下一輪；否則 runloop 會因 todolist 清空而停下。

觸發條件（**必須同時成立**才 append pending todo）：

1. 當前 spec `.state.json.state === "implementing"`
2. `specs/<slug>/tasks.md` 仍有 `- [ ]` / `- [~]` 未完成項
3. TodoWrite 沒有 `in_progress` 項，或剛把當前 `in_progress` 標為 `completed`
4. 沒有使用者決定 / 批准 / 外部 blocker 擋住（`- [!]` / `- [?]` 都沒卡）

停止條件（**任一成立**即結束 turn，不要 append）：

- tasks.md 全 `- [x]` → 準備 promote 到 `verified`
- 有 `- [!] blocked` 或 `- [?] decision/approval` 未解除
- 使用者插話 / interrupt
- 偵測到 scope drift 需走 `extend` / `refactor` mode
- 非 plan-builder 管理的任務 → 只做使用者當輪明確要求的工作

與 runloop 的關係：runloop（`workflow-runner.ts planAutonomousNextAction`）**只認 TodoWrite 殘留**，不懂 spec 狀態、不讀 tasks.md。這條紀律完全靠 AI 自律執行；**不存在 runtime 閘在判斷錯誤時救你**。

### Autonomous Agent 核心紀律

**八項核心原則**：

1. **Autonomy 依賴計畫，不依賴靈感。**
2. **計畫不必完美，但必須可執行**（goal / todo / `dependsOn` / stop gates）。
3. **todo 是 working ledger，紀律由 `plan-builder` skill 規範** — runtime 不再依 agent 名字鎖結構。當 plan-builder 在執行某份 spec 時，todo 應對齊 tasks.md（詳見 plan-builder SKILL.md §16.2）；其他情境 todo 是自由可重寫的工作清單，隨 plan / scope 演進。
4. **一律對話中可觀測** — 重要進展、阻塞、replan 必須讓使用者理解。
5. **可持續執行 ≠ 可靜默亂跑** — 遇到 approval / decision / blocker 必停。
6. **Debug system-first** — 複雜 bug 先看系統邊界、資料流、觀測訊號；詳細 Syslog-style Debug Contract 見 `code-thinker` skill §3。
7. **Single-thread by default** — 主代理預設直接執行；委派觸發條件由各 subagent driver 自身 description 宣告（本檔不重列）。最常用的只有 `explore` 與 `coding`。
8. **Narration ≠ Pause；Completion = Silent** — 執行中必 narrate；所有 todo 收斂後 silent stop 才是正確信號，不需 wrap-up 總結。

**Narration 五類**（執行中必可見）：Kickoff / Subagent milestone / Pause / Complete / Replanning。narration 是 side-channel visibility，**不是 pause boundary**——只有 stop gate 才真暫停。

**Stop / Waiting 回報格式**（需 approval / decision / blocker 時結束 turn 前固定輸出）：

```
Paused: <原因>
Need:
  - <使用者批准 / 決策 / 外部資訊>
Next after reply:
  - <恢復後的第一步>
```

觸發 Stop 的情境：

- `needsApproval = true`
- `action.kind ∈ {push, destructive, architecture_change}` 且策略要求批准
- `waitingOn ∈ {approval, decision}`
- 真正 blocker（權限、外部依賴、不可恢復錯誤）

**Interrupt-safe Replanning**（使用者插話時）：

1. 承認中斷發生（明示舊 autonomous run 已暫停）
2. 重評估既有 todo —— 保留 / 取消（標 `cancelled`）/ 延後 / 新增
3. 重新排序 `dependsOn`，保留唯一 `in_progress`
4. 宣告下一步——讓使用者看到續跑路線

原則：不要整份丟掉舊計畫除非完全失效；優先保留仍有效的已完成工作。

**操作準則摘要（Ops digest）**：

- Search first, then read
- Read before write
- Absolute paths only
- 一次只有一個 `in_progress` todo
- 用結構化 todo metadata，不用模糊條列
- 執行中 narrate；最後一個 todo 完成後 silent stop
- Stop for approval / decision / blocker
- 使用者插話 → 明確 replan
- Finish only after validation + event log + architecture sync（若未動架構則註記 `Verified (No doc changes)`）

## 語言回應規範

- 對使用者的預設回應語言一律使用**繁體中文**。
- 若使用者明確要求其他語言，或任務本身需要保留原文/特定語言格式，再依需求切換。

### 開發任務預設工作流（Mandatory Trigger）

- 只要使用者提出**非瑣碎開發需求**（例如 implement / build / fix / refactor / debug / write tests / continue plan / make it autonomous），Main Agent **必須**先透過 `plan-builder` skill（已由上方 Mandatory Skills 自動 preload）走完草稿期 lifecycle，再進入 `implementing`。狀態定義與 mode 規範由 plan-builder SKILL.md 唯一擁有，本檔不複述。
- 進入 EXECUTION 前必須建立最小可執行骨架：
  - `goal`
  - structured todos（優先使用 `todowrite` + `action` metadata）
  - `dependsOn`
  - approval / decision / blocker gates
  - validation plan
- 若上述骨架尚未成立，**不得**宣稱可安全 autonomous 持續執行；必須先補 plan，再進入 execution。
- 在 planning / clarification 階段，凡屬於**有明確選項的選擇題**（例如 milestone、scope、approval posture、validation target、delegation strategy），**預設必須使用 MCP `question`** 呈現，而不是用自由文字把選項混在 prose 內；只有在使用者需要先用長篇背景補充脈絡時，才先 freeform 再用 `question` 收斂決策。
- 若任務變更模組邊界、資料流、狀態機、debug checkpoints 或沉澱了重要 root cause，Main Agent **必須**自行載入 `doc-coauthoring` + `miatdiagram` skills 並直接更新框架文件。文件工作不委派 subagent。
- 其他技能（如 `code-thinker`, `webapp-testing`, `doc-coauthoring`）屬於按需加值裝備；`plan-builder`（透過 Mandatory Skills preload）是所有非瑣碎開發任務的預設底盤。

### 核心文件責任分工（Hard-coded）

> **路徑範圍規則（重要）**：本節與下方第 5、9 節提及的 `specs/...`、`plans/...` 一律指**當前 repo**（即 session `cwd` 所在的 repo root）下的相對路徑。若當前 repo 不存在該目錄／檔案，**直接 skip，不要跨 repo 臆測或組合檔名去 resolve**。例如 session cwd 是 `cisopro` 時，`specs/...` 是 `cisopro/specs/...`，不是 `opencode/specs/...`；若 `cisopro` 沒有這個目錄，就不必讀、也不要猜檔名。event log 一律以 `scope` 標記歸屬，不靠目錄路徑。

- `specs/architecture.md`
  - 記錄全 repo 長期框架知識：模組邊界、資料流、狀態機、runtime flows、核心目錄樹、debug/observability map。
- **Event log（append-only 開發紀錄，sqlite）**
  - 記錄每次任務的需求、範圍、對話重點摘要、debug checkpoints、決策、驗證與 architecture sync。
  - 寫入用 specbase MCP 的 `event_record(summary, body?, scope?, date?, status?, tags?)`，append 一筆 row；`scope` 帶當前 repo 的 project 或所屬 plan/spec slug。
  - 讀取用 `event_search`（BM25 全文）/ `event_query`（date/tag/status 過濾）。回憶過往決策 / RCA / 部署一律走 `event_search`，不 grep 任何目錄。
- 所有複雜 debug / 開發任務，應優先先讀**當前 repo 的** `specs/architecture.md`、並以 `event_search` 回憶相關過往事件，再進入原始碼偵查。

### 全域 Debug / Syslog 契約（Mandatory）

- 往後所有開發 / debug 工作一律採 **system-first、boundary-first、evidence-first** 思維。
- 遇到複雜 bug（例如 reload blank、state mismatch、跨層 sync、race、multi-component failure）時，不得只憑局部 symptom 判斷；必須先拆：
  - 系統層次
  - component boundaries
  - 資料 / 狀態 / config 傳遞路徑
- 所有 debug 任務都必須遵守 `code-thinker` 的 syslog-style debug contract（詳見 code-thinker SKILL.md §3）。
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
- **Loader Alias**: `system-manager`（展開為 `system-manager_*` 直接工具；不要為 system-manager 手動跑 MCP initialize / tools-list）
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
- **Event Log**: 任何重大決策必須呼叫 `event_record` 記錄進**當前 repo 的** event log sqlite（`scope` 帶 project 或 plan/spec slug，不要跨 repo）。
- 靜默執行（silent execution）時，允許直接呼叫 `event_record`，而**不需要**另外向使用者敘述「正在記錄 event log」；但這不免除 event log 實際寫入義務。

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

1. **Event 先行（透過 `event_record` toolcall，非建檔）**
   - 任何非瑣碎開發任務，開工時必須呼叫一次 `event_record` 記下開場：`summary` 為任務一句話、`body` 至少含 `需求`、`範圍(IN/OUT)`、`任務清單`、`scope` 帶當前 repo 的 project 或所屬 plan/spec slug。
   - event log 唯一寫入路徑是 `event_record` toolcall（append 進 sqlite，`scope` 標歸屬）。
   - 收尾時再呼叫一次 `event_record`（或更新型紀錄）補上 `Key Decisions / Issues / Verification / Remaining`。一個任務開場 + 收尾各一筆是基本節奏；過程中重大決策 / RCA / 部署隨手再 append。
   - 若 agent 處於靜默執行模式，允許直接呼叫 `event_record`，不需額外把「正在記錄 event log」當成對使用者的 narration step。
   - **觸發契約（明確釘死，勿憑「夠不夠聰明」自由心證）**：以下任一成立就必須 `event_record` ——(a) 非瑣碎任務開工；(b) 做出架構 / 設計 / 取捨決策；(c) 完成一次 RCA 或找到 root cause；(d) 部署 / 3R / migration；(e) 任務收尾宣告完成前。純讀取查詢、瑣碎一行修改、純對話不需要。

2. **實作過程必有標準化 debug checkpoints**
   - 一律遵守 `code-thinker` 的 checkpoint schema。
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

8. **Issue 紀錄預設策略（Local-first）**
   - 本 repo 的 bug report / feature request 預設一律記錄在本地 `issues/` 目錄。
   - 除非使用者明確要求「發 GitHub issue」，否則禁止使用 `gh issue create` 或其他方式建立遠端 GitHub issue。
   - 本地 issue 檔名使用 `issues/issue_<YYYYMMDD>_<slug>.md`；已完成或關閉的 issue 移至 `issues/closed/`。

9. **Plan / Spec Zone Contract（草稿區與 KB 區的物理隔離）**
   - **草稿區 `/plans/`**：plan-builder 進行中的 package 一律建立於 `/plans/<category>_<topic>/`，**扁平命名、底線分隔，不帶日期前綴**。range 涵蓋 `proposed → designed → planned → implementing → verified` 全部草稿期狀態。
   - **KB 區 `/specs/`**：已 graduate 的 spec 落於 `/specs/<category>/<topic>/`，semantic 子目錄結構，是 wiki / KB / Quartz 的可見來源。一旦進入 `/specs/`，後續 `amend` / `revise` / `extend` / `refactor` / `archive` 全部留在原地，**不回退到 `/plans/`**。
   - **`specs/architecture.md` 是架構單一真相來源**：長期架構、模組邊界、資料流、狀態機、runtime flows 以此為準。
   - **Tasks Checklist 即時同步**：每完成一個 task item，立即更新對應 `tasks.md` 的 checkbox（`[ ]` → `[x]`）。若 task 不適用或需拆分，標記 `[~] <reason>`。禁止所有工作完成後才一次性勾選。
   - **Session Event Log**：每個 session 結束前（或 commit 前），呼叫 `event_record` 寫入**當前 repo scope 的** event log，`body` 至少含 Scope（引用 tasks.md item 編號）、Key Decisions、Issues Found、Verification、Remaining。silent execution 下不需用對話文字宣告。
   - **Commit Gate**：commit 前必須確認 (1) tasks.md checkbox 已同步 (2) event log 已透過 `event_record` 寫入 (3) 架構變更已同步 `specs/architecture.md`。
   - **Graduation Gate（`plan_graduate`）**：`verified → living` 升格、實體從 `/plans/<category>_<topic>/` 搬移至 `/specs/<category>/<topic>/`，**只允許使用者明確指示時觸發**；AI 偵測 `verified` 狀態僅可向使用者**提示** ready，不得自行呼叫 `plan_graduate`、不得使用模糊或 silent fallback wording 暗示稍後會自動升格。
   - **Beta/Test Branch Cleanup Rule**：`beta/*` 與 `test/*` 分支屬一次性執行面。測試完成且 merge/fetch-back 回主線後，必須立即刪除對應 branch 與 disposable worktree；未刪除不得宣告 workflow 完成。禁止長期保留已完成任務的 beta/test 分支，避免後續被誤當 authoritative mainline 而造成 branch pointer drift。

10. **Web Runtime 單一啟動入口（Fail-Fast）**

- 本 repo 的 web runtime **只允許**透過 `./webctl.sh dev-start`（或 `dev-refresh`）啟動。
- 禁止直接使用 `bun ... opencode ... web` / `opencode web` 手動啟動，避免載入錯誤前端 bundle 或錯誤 env。
- 所有 server runtime 參數（含 `OPENCODE_FRONTEND_PATH`）必須集中定義於 `/etc/opencode/opencode.cfg`，作為單一事實來源。

11. **禁止新增 fallback mechanism（使用者天條）**

- 實作、重構、除錯時，**不允許主動新增任何 fallback mechanism**，除非使用者明確批准。
- 尤其禁止以下行為：
  - 在 account / provider / model / session identity 不一致時，以 silent fallback 掩蓋問題
  - 用預設值、第一個可用項、插入順序第一筆、global active account、cross-provider rescue 等方式偷偷續跑
  - 在沒有 request-level evidence 前，以 fallback 當作「先讓系統能跑」的修補
- 預設策略應為：**fail fast、顯式報錯、保留證據、要求決策**，而不是自動 fallback。

12. **Daemon Lifecycle Authority（AI 自殺式重啟禁令）**

- **AI 禁止自行 spawn / kill / restart opencode daemon 或 gateway 行程。** 唯一合法的自重啟路徑是 `system-manager_restart_self` tool（內部 POST `/api/v2/global/web/restart`，由 gateway + `webctl.sh` 負責 rebuild+install+restart orchestration）。
- **Bash tool 的 denylist 會擋以下指令**（違規丟 `FORBIDDEN_DAEMON_SPAWN`）：
  - `webctl.sh dev-start` / `dev-refresh` / `restart` / `web-restart` / `web-refresh` / `reload`
  - `bun ... serve --unix-socket ...`
  - `opencode serve` / `opencode web`
  - 針對 daemon pid 的 `kill`（`cat daemon.lock` / `pgrep opencode` 取得 pid）
  - `systemctl restart opencode-gateway`
- **Why**：daemon 生命週期的唯一權威是 gateway；daemon 自行 spawn / kill 會產生 orphan 行程、霸佔 gateway lock。
- **需要改 code 後生效？** 呼叫 `restart_self`；webctl.sh smart-detect dirty 層（daemon / frontend / gateway）並只 rebuild 變動部分。`targets: ["gateway"]` 會附 `--force-gateway` 讓 systemd respawn gateway 本體（期間所有使用者斷線 3-5s）。
- **rebuild 失敗？** endpoint 回 5xx 帶 `errorLogPath`；系統維持舊版本可用。讀 log、修正、再呼叫。**絕不**嘗試繞過 denylist 走 Bash。
- 若現有程式已存在 fallback，新的任務預設應優先評估：
  1.  是否能刪除
  2.  是否能改成 explicit decision gate
  3.  是否能縮到單一可觀測且經使用者批准的例外

13. **善用系統既有 Infrastructure，禁止重複造輪子（使用者天條）**

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
