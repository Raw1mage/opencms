# OpenCode 專案開發指引

本檔案定義 opencode 專案特有的開發規範。通用工作流程請參閱 `agent-workflow` skill。

## 核心工程技能棧 (Mandatory Skills)

本專案為 AI Agent 平台，開發時**必須**載入以下技能以確保架構一致性：

1.  **`software-architect`**: 架構決策核心。凡涉及系統設計、模組劃分、技術選型，必先諮詢此技能。
2.  **`bun-package-dev`**: 內建開發工具鏈。用於建置二進位檔、Docker 映像與管理 Monorepo。
3.  **`agent-creator`**: Agent 生產線。包含 LLM Prompt Engineering、System Prompt 優化與 4-Phase SOP。
4.  **`bun-file-io`**: I/O 標準。確保所有檔案操作優先使用 Bun API (Performance & Native)。

---

## 專案背景

本專案源自 `origin/dev` 分支，現已衍生為 `cms` 分支作為主要產品線。

### cms 分支主要特色

- **全域多帳號管理系統** - 支援多個 provider 帳號的統一管理
- **rotation3d 多模型輪替系統** - 動態模型切換與負載平衡
- **Admin Panel (`/admin`)** - 三合一管理界面
- **Provider 細分化** - 將原本的 `google` provider 拆分為獨立的三個 providers：
  - `antigravity`
  - `gemini-cli`
  - `google-api`

  以便充分利用每一 provider 提供的資源

---

## 整合規範

### 從 origin/dev 引進更新

任何從 GitHub pull 的 `origin/dev` 新 commits，都必須經過分析後再到 `cms` 中重構，**不可直接 merge**。

### 外部 Plugin 管理

引進的外部 plugin 都集中放在 `/refs` 目錄。若有更新，也必須逐一分析後再到 `cms` 中重構，**不可直接 merge**。

---

## 部署架構

預計安裝到使用者端的設定檔都集中在 `templates/` 目錄，以 XDG 架構部署。

---

## 開發 opencode 本專案時的 Prompt/Agent 維護邊界

當任務是「開發 opencode 本身」時，請遵循以下分層與同步原則：

- **Global**: `~/.config/opencode/AGENTS.md`
- **Project**: `<repo>/.opencode/AGENTS.md`
- **Template**: `<repo>/templates/AGENTS.md`（release 後供使用者初始化 global 設定）

### 維護原則

1. **Project AGENTS 由專案維護者規劃**：本檔作為專案內規範主體，重大策略先在此定義。
2. **Template 與 Runtime 需同步**：凡影響預設行為的流程/規範變更，需同時更新：
   - `templates/**`（發布到使用者端的來源）
   - `runtime` 對應檔案（例如 `.opencode/skills/**`）
3. **避免僅改 Global**：`~/.config/opencode/*` 屬本機執行環境，不作為 repo 交付依據。
4. **變更留痕**：所有重大決策與同步範圍需記錄於 `docs/events/`。

### Release 前檢查清單（Prompt / Agent / Skill）

- [ ] 若調整工作流或規範，已同步更新 `templates/**` 與對應 `runtime`（如 `.opencode/skills/**`）。
- [ ] 若調整初始化行為，已確認 `templates/AGENTS.md` 與 `templates/prompts/SYSTEM.md` 一致。
- [ ] 若調整執行時技能，已確認 `.opencode/skills/**` 與 `templates/skills/**` 無漂移。
- [ ] 已在 `docs/events/` 記錄：變更目的、範圍、同步面、風險。
- [ ] 僅將 `~/.config/opencode/*` 視為本機環境，不作為 release 交付來源。

---

## 技能管理與主動協助 (Skill Management & Proactive Assistance)

Orchestrator 應具備高度的機動性，隨時分析使用者意圖並主動提供技能建議：

1.  **意圖識別與技能建議**：
    - 當對話內容涉及特定領域（如：文檔撰寫、測試、資料分析、繪圖等）時，應檢查是否已載入對應的 Skill。
    - 若未載入，應**主動建議**使用者載入相關 Skill (例如：`doc-coauthoring`, `webapp-testing`, `xlsx` 等)，並說明該 Skill 能帶來的效益。

2.  **技能擴充 (Skill Finder)**：
    - 當現有 Skill 無法滿足使用者需求，或識別到使用者可能需要某類工具但系統尚未安裝時。
    - 應**積極建議**使用者使用 `skill(name="skill-finder")` 來尋找並安裝社群提供的擴充技能。
    - 說明：不要等待使用者詢問，應在識別到需求缺口時立即提出。
