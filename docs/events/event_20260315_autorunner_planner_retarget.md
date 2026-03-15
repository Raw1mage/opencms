# Event: autorunner planner retarget

Date: 2026-03-15
Status: Completed
Branch: cms
Workspace: /home/pkcs12/projects/opencode

## 需求

- 使用者明確指出目前 autorunner 實際效果為 0，仍停留在一步一停的回合制 assistant，而不是持續推進的 agent execution loop。
- 使用者要求不要再產出純報告，而是直接用 planner 更新出一個能被 build mode 接手的 autorunner 優化計畫。
- 使用者已明確決議：`mcp-finder`、`skill-finder`、`software-architect`、`model-selector` 都不再作為預設加載 skill。
- 使用者要求：將 `software-architect` 的有效能力併入 planner hardcode，並將 `agent-workflow` 改寫成符合 autorunner、以 delegation 為預設的 workflow。

## 範圍 (IN / OUT)

### IN

- `specs/20260315_autorunner/*`
- `AGENTS.md`
- `templates/AGENTS.md`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/prompt/{plan.txt,runner.txt,claude.txt,anthropic-20250930.txt}`
- `packages/opencode/src/session/system.ts`
- `templates/skills/agent-workflow/SKILL.md`
- `/home/pkcs12/.local/share/opencode/skills/agent-workflow/SKILL.md`
- `packages/opencode/src/session/prompt/enablement.json`
- `templates/prompts/enablement.json`
- `templates/system_prompt.md`
- `templates/global_constitution.md`
- 對應 planner / runner / bootstrap 測試

### OUT

- daemon architecture rewrite
- worker supervisor / queue substrate 大改
- 新 fallback mechanism
- push / PR

## 任務清單

- [x] 讀取 `docs/ARCHITECTURE.md`、既有 autorunner event、與 active planner artifacts
- [x] 盤點目前 bootstrap / planner / runner / enablement 的實際入口檔案
- [x] 將使用者最新決策沉澱到 `specs/20260315_autorunner/*`
- [x] build mode 依新計畫改寫 planner templates / runner prompts / bootstrap policy
- [x] 進行 targeted validation 並同步 architecture/event 記錄

## Debug Checkpoints

### Baseline

- `docs/ARCHITECTURE.md` 已記錄 autorunner 目前已有 mission-driven continuation、planner-derived todo、queue/health/anomaly surfaces，但本質仍是 prompt-loop centric continuation。
- 現有 `AGENTS.md`、`templates/AGENTS.md`、`templates/system_prompt.md`、`templates/global_constitution.md` 仍保留 `model-selector`、`mcp-finder`、`skill-finder`、`software-architect` 作為預設或核心 skill 的敘述。
- `packages/opencode/src/tool/plan.ts` 的 fallback artifact templates 仍偏通用，尚未把 architecture-thinking 與 delegation-first execution 寫死進 planner hardcode。
- `packages/opencode/src/session/prompt/runner.txt` 雖已有 authority/behavior，但未明講 narration 不等於 pause，也未把 delegation-first continuation 收斂成主語。
- `agent-workflow` skill 雖已有 autonomous-ready SOP，但尚未明確把 delegation-first 與「narration 不應成為 pause boundary」寫成 autorunner-centered contract。

### Instrumentation Plan

- 以 planner-first 方式先固定新的 execution contract，再交給 build mode 實作。
- 觀測面分成四層：
  1. bootstrap docs 是否仍要求多 skill 常駐
  2. planner templates 是否仍是 generic placeholder
  3. runner / prompt wording 是否仍將 progress 與 pause 混在一起
  4. enablement / template 是否仍暗示 `software-architect` 或 `model-selector` 是預設依賴

### Execution

- 已重新讀取：
  - `docs/ARCHITECTURE.md`
  - `docs/events/event_20260313_autorunner_system_stability_plan.md`
  - `docs/events/event_20260313_autorunner_autonomous_agent_completion.md`
  - `docs/events/event_20260313_planner_sync_from_autorunner.md`
  - `specs/20260315_autorunner/{implementation-spec,proposal,spec,design,tasks,handoff}.md`
  - `packages/opencode/src/tool/plan.ts`
  - `packages/opencode/src/tool/registry.ts`
  - `packages/opencode/src/session/prompt/{plan.txt,runner.txt,claude.txt,instructions.txt}`
  - `AGENTS.md`, `templates/AGENTS.md`
  - `packages/opencode/src/session/prompt/enablement.json`, `templates/prompts/enablement.json`
  - `templates/system_prompt.md`, `templates/global_constitution.md`
- 已將本輪規劃正式收斂為一個新的 planner package contract：
  - bootstrap 精簡
  - planner hardcode 吸收 architecture-thinking
  - `agent-workflow` / runner 改寫為 delegation-first
- build mode 已實作完成：
  - `packages/opencode/src/tool/plan.ts` fallback templates 已改寫為 architecture-aware、delegation-first、gate-driven contract
  - `packages/opencode/src/session/prompt/{runner,plan,claude,anthropic-20250930}.txt` 與 `packages/opencode/src/session/system.ts` 已對齊新的 autorunner wording
  - `AGENTS.md`、`templates/AGENTS.md`、`packages/opencode/src/session/prompt/enablement.json`、`templates/prompts/enablement.json`、`templates/system_prompt.md`、`templates/global_constitution.md` 已改為 workflow-first、移除多餘預設 bootstrap skill 敘述
  - `templates/skills/agent-workflow/SKILL.md` 與本機 runtime mirror `/home/pkcs12/.local/share/opencode/skills/agent-workflow/SKILL.md` 已同步為 delegation-first / narration != pause 契約
  - 已新增 / 更新回歸測試以鎖住 planner wording、runner wording、bootstrap policy

### Root Cause

- 現況問題不是「缺 plan」，而是 plan 沒有被包進一個真正的 execution environment：
  1. bootstrap 仍有多個低實效 skill 常駐，拉高 prompt 噪音與顧問化傾向
  2. planner templates 尚未硬編碼 architecture / constraints / delegation contract
  3. runner contract 尚未把 narration 與 pause decouple
  4. 因此 autorunner 雖有 mission/todo/continuation substrate，仍缺一個真正 delegation-driven 的行為底盤

### Validation

- 規劃驗證（已完成）：
  - 已確認 active plan root 為 `specs/20260315_autorunner`
  - 已確認 companion artifacts 全部改寫為本輪 autorunner optimization slice
  - 已建立本 event 作為本輪 planning authority ledger
- build / regression 驗證（已完成）：
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/session/bootstrap-policy.test.ts"`
  - 結果：66 passed / 0 failed
  - 覆蓋面：planner template regression、workflow-runner wording regression、bootstrap / enablement policy regression

## Architecture Sync

- Architecture Sync: Updated
- 已同步 `docs/ARCHITECTURE.md` 中 bundled skill / runtime contract 描述，補上：
  - bootstrap 改為最小必要、其餘技能 on-demand
  - `agent-workflow` 現為 delegation-first、narration != pause、autorunner-centered contract
  - `code-thinker` 與 `doc-coauthoring` 仍保留為高風險實作 / 文件同步時的配套能力
