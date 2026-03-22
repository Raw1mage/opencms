# OpenCode 專案開發指引

本檔案定義 opencode 專案特有的開發規範。通用操作規則見 SYSTEM.md，指揮官戰術見 Global AGENTS.md。

## 核心工程技能棧

本專案為 AI Agent 平台，**唯一預設 workflow skill** 是 `agent-workflow`。其餘 skills 為 on-demand 裝備。

### 開發任務預設工作流（Mandatory Trigger）

非瑣碎開發需求必須以 `agent-workflow` 作為預設 workflow。進入 EXECUTION 前，必須先建立：
- `goal` + structured todos + `dependsOn` + gates + validation plan

在 planning / clarification 階段，凡屬於**有明確選項的選擇題**（scope、priority、approval posture、validation target、delegation strategy），**預設必須使用 MCP `question`** 呈現結構化選項，不要用自由文字把選項混在 prose 內；只有在需要長篇背景補充脈絡時，才先 freeform 再用 `question` 收斂決策。

若任務變更模組邊界、資料流、狀態機或沉澱重要 root cause，Main Agent 必須自行載入 `doc-coauthoring` + `miatdiagram` 直接更新框架文件（不委派 subagent）。

### 核心文件責任分工

- `specs/architecture.md` — 全 repo 長期框架知識 SSOT
- `docs/events/event_<YYYYMMDD>_<topic>.md` — 任務記錄、debug checkpoints、決策、驗證
- 複雜任務應優先讀 `specs/architecture.md` 與 `docs/events/`

### Debug 契約

system-first、boundary-first、evidence-first。沒有 checkpoint evidence 不得宣稱已找到 root cause。

### Enablement Registry

- Runtime: `packages/opencode/src/session/prompt/enablement.json`
- Template: `templates/prompts/enablement.json`
- 擴充能力後必須同步更新兩處

---

## 專案背景

本專案源自 `origin/dev`，現已衍生為 `cms` 分支作為主要產品線。

### cms 分支主要特色

- 全域多帳號管理系統
- rotation3d 多模型輪替系統
- Admin Panel (`/admin`)
- Provider 細分化：`gemini-cli`、`google-api`

---

## 整合規範

- **origin/dev 更新**：必須分析後重構到 cms，不可直接 merge
- **外部 Plugin**：集中在 `/refs`，更新時逐一分析重構
- **PR 策略**：預設不建立 PR，除非使用者明確要求

---

## 部署架構

設定檔集中在 `templates/`，以 XDG 架構部署。

### Web Runtime

只允許透過 `./webctl.sh dev-start`（或 `dev-refresh`）啟動。Server 參數集中定義於 `/etc/opencode/opencode.cfg`。

---

## Prompt/Agent 維護邊界

- **Global**: `~/.config/opencode/AGENTS.md` — 指揮官戰術
- **Project**: `<repo>/AGENTS.md` — 專案規範主體
- **Template**: `<repo>/templates/AGENTS.md` — 使用者初始化來源

維護原則：Project 先定義 → Template/Runtime 同步 → Global 僅本機環境。

---

## 跨專案 SOP 基線

1. **Event 檔先行**：非瑣碎任務必建 `docs/events/event_<YYYYMMDD>_<topic>.md`
2. **Debug checkpoints**：遵守 `agent-workflow` / `code-thinker` checkpoint schema
3. **完成宣告**：需有明確驗證區塊，禁止跳步收尾
4. **Architecture 同步**：每次非瑣碎任務收尾前同步 `specs/architecture.md`（全貌同步），未完成不得宣告完成
5. **文件優先**：優先讀框架文件，不從原始碼重建心智模型

### Plan / Spec Lifecycle Contract

- Active plans 在 `/plans/<YYYYMMDD>_<slug>/`
- `specs/architecture.md` 仍是架構 SSOT
- Formalized specs 在 `/specs/<feature>/`（手動升格 only）
- Tasks checkbox 即時同步，Event log 必須建立/更新
- Commit gate：tasks.md + event log + architecture sync 三項確認

### Template / Runtime 同步門檻

凡影響預設行為的流程/規範變更，需同時更新：
- `templates/**`（發布到使用者端的來源）
- `runtime` 對應檔案（如 `$XDG_CONFIG_HOME/opencode/skills/**`、`enablement.json`）

未同步 `templates/**` 的規範變更不得進入 release。

### Release 前檢查清單

- [ ] templates/** 與 runtime 同步
- [ ] docs/events/ 已記錄
- [ ] specs/architecture.md 已同步檢查

---

## Subagent Skill Mapping

| Agent Type | Skill | 說明 |
|---|---|---|
| `coding` | `code-thinker` | 靜默審查 + Two-Phase Execution |
| `testing` | `webapp-testing` | Playwright 瀏覽器自動化 |
| `review` | `code-review` | SOLID 違規偵測 |
| Orchestrator | `doc-coauthoring`, `miatdiagram` | 文件直接撰寫 |
| `explore` | —（內建） | 無需外部 skill |

Orchestrator 在 delegation prompt 開頭必須加入：`FIRST: Load skill "<name>" before starting work.`

---

## 技能管理

- 對話涉及特定領域時，主動建議載入對應 Skill
- `skill-finder` / `mcp-finder` 為 on-demand，非 bootstrap 預設

---

## 禁止新增 fallback mechanism

不允許主動新增任何 fallback mechanism，除非使用者明確批准。預設策略：**fail fast、顯式報錯、保留證據、要求決策**。
