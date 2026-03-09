# Event: autonomous documentation contract

Date: 2026-03-10
Status: In Progress

## 需求

- 為 autonomous agent 制定更治本的文件規範，使其能像真人一樣持續指揮 subagents 開發、測試、除錯、驗證。
- 硬編碼核心文件責任分工：`docs/ARCHITECTURE.md` vs `docs/events/`。
- 要求在開發中持續由 documentation agent 將框架知識文件化，讓 debug 時優先讀文件而不是每次重新建模整個系統。
- 同步更新相關 skills、AGENTS 與 template system prompts。

## 範圍

### IN

- `/home/pkcs12/.local/share/opencode/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/.local/share/opencode/skills/doc-coauthoring/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/doc-coauthoring/SKILL.md`
- `/home/pkcs12/projects/opencode/AGENTS.md`
- `/home/pkcs12/projects/opencode/templates/AGENTS.md`
- `/home/pkcs12/projects/opencode/templates/prompts/SYSTEM.md`
- `/home/pkcs12/projects/opencode/templates/prompts/constitution.md`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260310_autonomous_doc_contract.md`

### OUT

- 不修改 runtime 程式碼
- 不新增新的 docs 專用 skill 名稱；本輪沿用 `doc-coauthoring`

## 任務清單

- [x] 盤點現有 workflow / docs / prompt 邊界
- [x] 定義核心文件責任分工與 docs-agent 觸發規則
- [x] 同步更新相關 skills / AGENTS / system prompts
- [x] 更新 event / architecture 記錄
- [x] 驗證 runtime/template 對齊

## Debug Checkpoints

### Baseline

- 現有流程已要求更新 `docs/ARCHITECTURE.md` 與 `docs/events/`，但尚未把它們當成 autonomous/debug 專用的持久化系統模型來明確定義。
- `doc-coauthoring` 偏一般文件協作，尚未定義 repo framework docs / docs-agent 的固定責任。
- 若每次 debug 都重新建模模組結構、資料流、狀態機，會浪費大量 token，也容易出現 session 間知識斷裂。

### Execution

- 硬編碼文件分工：
  - `docs/ARCHITECTURE.md`：全局、長期、框架級文件
  - `docs/events/event_<date>_<topic>.md`：每次任務的事件、對話摘要、debug checkpoints、驗證與決策
- 要求 agent 在開發中識別到新的模組邊界、資料流、狀態機、debug checkpoints 時，主動委派 documentation agent 使用 `doc-coauthoring` 更新框架文件。
- 要求 debug 任務先讀相關框架文件，再補當前 issue 的 system slice。

### Validation

- `agent-workflow` runtime/template parity: MATCH
- `code-thinker` runtime/template parity: MATCH
- `doc-coauthoring` runtime/template parity: MATCH
- template skill quick validation:
  - `agent-workflow`: valid
  - `code-thinker`: valid
  - `doc-coauthoring`: valid
- `templates/prompts/SYSTEM.md` 已加入 `Framework-Docs-First Principle`
- `templates/prompts/constitution.md` 已加入 framework-docs-first 規則
- Architecture Sync: Verified (Updated `docs/ARCHITECTURE.md` to record framework docs as persistent system model and doc-coauthoring as documentation-agent workflow)
