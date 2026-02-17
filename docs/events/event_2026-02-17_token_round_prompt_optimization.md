# Event: Token / Request-Round Prompt Optimization

Date: 2026-02-17
Status: Done

## 1. 目標

- 針對 Orchestrator 工作流落地 6 項優化：
  - 平行工具呼叫（#2）
  - 最小 Subagent 脈絡（#3）
  - 固定短輸出（#4）
  - 模板重用（#6）
  - 搜尋先於精讀（#7）
  - 差異導向回報（#8）

## 2. 主要決策

1. 在 SYSTEM 層新增硬性規範，避免依賴單一技能文件。
2. 在 AGENTS 層新增指揮官戰術，將優化原則轉成可操作條列。
3. 在 agent-workflow skill 補齊執行細節，確保 Subagent 輸出一致。
4. 同步更新 template 與 in-repo runtime skill，降低規範漂移。

## 3. 變更檔案

- `templates/prompts/SYSTEM.md`
- `templates/AGENTS.md`
- `.opencode/skills/agent-workflow/SKILL.md`
- `templates/skills/agent-workflow/SKILL.md`
- `.opencode/AGENTS.md`（補充專案開發邊界與 release checklist）

## 4. 風險與後續

- 風險：若外部全域設定（例如 `~/.config/opencode`）與 repo 模板不同步，仍可能出現行為差異。
- 建議：在下一次模板發布流程中加入「prompt/skill drift check」。

## 5. AGENTS 層級定位（補充）

- Global: `~/.config/opencode/AGENTS.md`
- Project: `<repo>/.opencode/AGENTS.md`
- Template: `<repo>/templates/AGENTS.md`（release 後供初始化 global 設定）

## 6. 後續落地

- 已將「開發 opencode 本專案時的 Prompt/Agent 維護邊界」正式寫入 `<repo>/.opencode/AGENTS.md`。
- 明確要求：涉及預設行為的規範變更，需同步更新 `templates/**` 與 `runtime` 對應檔案。
- 已新增「Release 前檢查清單（Prompt / Agent / Skill）」以便發版前機械化檢查。
