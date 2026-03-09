# Event: agent-workflow trigger policy

Date: 2026-03-10
Status: In Progress

## 需求

- 明確規範往後開發任務何時必須觸發 `agent-workflow` skill。
- 讓 Main Agent 在使用者提出非瑣碎開發需求時，必須先以 `agent-workflow` 建立 autonomous-ready 計畫骨架，再進入執行。
- 同步更新 repo `AGENTS.md` 與 `templates/AGENTS.md`，避免 release 後策略漂移。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/AGENTS.md`
- `/home/pkcs12/projects/opencode/templates/AGENTS.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260310_agent_workflow_trigger_policy.md`

### OUT

- 不修改 autonomous runtime 程式碼
- 不修改其他 skills 內容

## 任務清單

- [x] 盤點 repo / template AGENTS 現況
- [x] 寫入 agent-workflow 強制觸發規則
- [x] 同步 repo / template 規範
- [x] 更新 event 驗證與 architecture sync 記錄

## Debug Checkpoints

### Baseline

- 雖然 global/template bootstrap 已要求 session 啟動時載入 `agent-workflow`，但 repo 規範尚未明講：
  - 使用者提出非瑣碎開發需求時，必須以 `agent-workflow` 作為預設 workflow
  - 未建立 autonomous-ready 計畫骨架前，不得直接宣稱可安全持續執行

### Execution

- 在 repo `AGENTS.md` 與 `templates/AGENTS.md` 補一條開發任務觸發規則：
  - 非瑣碎開發需求必須以 `agent-workflow` 為底盤
  - 先建立 goal / structured todos / dependencies / approval/decision/blocker gates / validation plan
  - 若計畫骨架未完成，不得直接進入 autonomous execution

### Validation

- repo `AGENTS.md` 與 `templates/AGENTS.md` 均已包含 `開發任務預設工作流（Mandatory Trigger）`
- 規則已明確要求：非瑣碎開發需求必須以 `agent-workflow` 建立 autonomous-ready 計畫骨架後才能進入 execution
- Architecture Sync: Verified (No doc changes required; this round only tightened trigger policy in AGENTS/template AGENTS, and architecture/runtime contract remains unchanged)
