# Event: agent-workflow autonomous upgrade

Date: 2026-03-10
Status: In Progress

## 需求

- 升級 `agent-workflow` skill，使其足以驅動本系統的 autonomous agent。
- 讓 agent 能在對話中協助使用者建立可執行計畫，而不是只有通用 SOP。
- 明確定義 plan→todo metadata→autonomous continuation→interrupt/replan 的必要條件。
- 同步 runtime skill 與 `templates/skills/**`，避免 release 後行為漂移。

## 範圍

### IN

- `/home/pkcs12/.local/share/opencode/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/projects/opencode/templates/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260310_agent_workflow_autonomous_upgrade.md`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`

### OUT

- 不新增全新 skill 名稱；本輪直接升級既有 `agent-workflow`
- 不修改 autonomous runtime 程式碼本身
- 不調整 enablement registry（skill 既有、僅內容升級）

## 任務清單

- [x] 盤點 runtime skill 與 template skill 現況及同步要求
- [x] 設計 autonomous-ready 的 `agent-workflow` 結構
- [x] 同步更新 runtime skill 與 template skill
- [x] 更新 event / architecture 記錄
- [x] 驗證 runtime/template 無漂移

## Debug Checkpoints

### Baseline

- 現行 `agent-workflow` 偏向通用 ANALYSIS/PLANNING/EXECUTION SOP。
- 它能要求先規劃再執行，但尚未明確規範：
  - 如何把對話收斂成 runtime 可用的 todo metadata
  - 如何定義 autonomous continuation 的 stop gates
  - 如何在使用者插話時做 interrupt-safe replanning
  - 如何要求 transcript-visible progress narration
- runtime skill 與 template skill 內容已經漂移，不適合作為單一真實來源。

### Execution

- 將 `agent-workflow` 重寫為 autonomous-first 版本，核心補齊：
  - Conversation-to-Plan protocol
  - Todo metadata contract (`action.kind/risk/needsApproval/canDelegate/waitingOn/dependsOn`)
  - Execution readiness gate（何時可一路跑、何時必須先問）
  - Autonomous loop contract（todo 驅動、單一 `in_progress`、步驟完成後 auto-advance）
  - Narration contract（kickoff / subagent milestone / pause / complete / replanning）
  - Interrupt-safe replanning contract（保留 / 取消 / 延後 / 重排）
  - Completion gate（驗證 / docs / architecture sync）

### Validation

- runtime skill 與 template skill 內容一致（`cmp -s ... && MATCH`）
- Architecture Sync: Verified (Updated `docs/ARCHITECTURE.md` to record `agent-workflow` as part of the autonomous planning runtime contract and template-sync requirement)
