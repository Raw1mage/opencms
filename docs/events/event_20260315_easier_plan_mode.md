# Event: easier_plan_mode

Date: 2026-03-15
Status: Implemented
Branch: cms
Workspace: /home/pkcs12/projects/opencode

## 需求

- 使用者要求放寬 todolist 更新條件。
- 重新定義：plan mode 不只是 planner 文件階段，也是一種 casual/debug/small-fix mode。
- build mode 才嚴格與 planned task todo list 同步。
- 使用者明確追加：一併修復 `todowrite` 的 mode-aware 與 sync 能力。

## 範圍 (IN / OUT)

### IN

- plan/build mode todo policy rewrite
- mode-aware todo authority semantics
- prompt/system/docs/skill 規範同步
- validation planning

### OUT

- scheduler substrate implementation
- daemon / heartbeat / cron changes
- push / PR

## 任務清單

- [x] 建立 easier_plan_mode 的獨立 spec package 與 event
- [x] 把 plan mode 寬鬆 todo policy 與 build mode 嚴格 sync policy 寫成 execution-ready spec
- [x] 收斂 transition rule、受影響檔案與驗證策略
- [x] 實作 runtime mode-aware todowrite: `working_ledger` UpdateMode + plan-mode auto-promotion
- [x] 更新 system.ts / plan.txt / claude.txt / anthropic-20250930.txt todowrite 規範為 mode-aware
- [x] 更新 agent-workflow SKILL.md todowrite 章節
- [x] 更新 plan_enter / plan_exit handoff 訊息明確宣告 todo authority 切換
- [x] 同步 docs/ARCHITECTURE.md: todo 從 planner-projection-only 改為 mode-aware contract

## Debug Checkpoints

### Baseline

- 現行規範把 todo 強烈綁定 planner artifacts projection，對 build mode 合理，但對 plan mode 過重。
- `system.ts`、`plan.txt`、`agent-workflow` 與 `docs/ARCHITECTURE.md` 都存在偏向「plan mode 也要嚴格對齊 planner todo」的敘述。

### Instrumentation Plan

- 先建立獨立 plan package。
- 再明確定義 mode-aware todo semantics。
- 最後盤點 prompt/system/docs/tests 的修正面。

### Execution

- 已建立 `specs/20260315_easier_plan_mode/*`
- 已建立 `docs/events/event_20260315_easier_plan_mode.md`
- 已根據使用者批准，將本 plan 範圍擴展為：
  - plan mode relaxed todo policy
  - build mode strict planner sync policy
  - `todowrite` mode-aware authority rewrite
  - explicit plan/build sync behavior

### Root Cause

- todo policy 把 plan mode 和 build mode 混成單一嚴格規則，導致 casual/debug 工作流被過度約束。
- 同時，`todowrite` 缺少明確 mode-aware authority 與 plan/build sync contract，導致 sidebar/runtime todo 在兩種模式間容易空白、回退或失配。

### Validation

- 實作檢核結果：符合本 plan 主要交付。
- 已檢查關鍵 runtime / prompt / docs surface：
  - `packages/opencode/src/tool/todo.ts`
  - `packages/opencode/src/session/todo.ts`
  - `packages/opencode/src/session/system.ts`
  - `packages/opencode/src/session/prompt/plan.txt`
  - `packages/opencode/src/tool/plan.ts`
  - `templates/skills/agent-workflow/SKILL.md`
  - `docs/ARCHITECTURE.md`
- 實測驗證：
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts"`
  - 結果：34 passed / 0 failed
- 驗證結論：
  - plan mode 已允許 working-ledger 結構變更（透過 `working_ledger` / auto-promotion）
  - build mode 仍保留 planner-derived execution ledger 限制
  - `plan_enter` / `plan_exit` 已明確宣告 todo authority 切換
  - 未發現需要在本 event 中追加的 blocker 或 regression evidence

## Architecture Sync

- Architecture Sync: Verified (Doc already updated by implementation)
- 已確認 `docs/ARCHITECTURE.md` 第 142-148 行附近已同步為 mode-aware contract：
  - **Plan mode (working ledger)**
  - **Build mode (execution ledger)**
  - `plan_enter` / `plan_exit` authority switch
- 本輪檢核不需要再追加 architecture 文本修改。

## Implementation Summary

### Runtime changes

- `todo.ts`: 新增 `working_ledger` UpdateMode，直接 enrichAll 而不走 merge/projection 邏輯
- `tool/todo.ts`: todowrite handler 現在 mode-aware — plan mode 下 structure change 自動升格為 `working_ledger`；build mode 維持嚴格 `status_update` 限制

### Prompt/doc changes

- `system.ts`: todowrite 規範拆成 plan mode (working ledger) vs build mode (execution ledger)
- `plan.txt`: 加入 casual/debug/small-fix 語言，明確宣告 plan mode 下的 relaxed todo policy
- `claude.txt` / `anthropic-20250930.txt`: plan/build mode todowrite 行為分開描述
- `agent-workflow/SKILL.md`: todowrite 強制規範改為 mode-aware 版本
- `plan.ts`: plan_enter 和 plan_exit 的 handoff 訊息明確宣告 todo authority 切換
