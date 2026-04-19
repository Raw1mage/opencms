# Event: orchestrator runloop early exit

Date: 2026-04-19
Status: Done

## 需求

- 修復 orchestrator 在 runloop 中無預警結束、但實際工作尚未真正結束的問題。
- 補充使用者新證據：client 網路不穩時，web 前端會把 symptom 放大成「AI 壞掉」的假象。

## 範圍

### IN

- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/session/todo.ts`
- `packages/opencode/src/session/todo.test.ts`
- `specs/architecture.md`

### OUT

- 不重寫整個 workflow-runner / prompt runloop
- 不改寫 web SSE / reconnect 機制
- 不處理所有前端弱網路 UX 顯示問題

## 任務清單

- [x] 讀取 architecture 與既有 runloop / subagent / stalled-session event
- [x] 定位 orchestrator 提前結束的控制面根因
- [x] 實作最小安全修補
- [x] 執行 focused tests
- [x] 補 event log 與 architecture sync

## Debug Checkpoints

### Baseline

- 使用者回報：orchestrator 會在 runloop 中無預警結束，且 AI 自己也知道工作未完成。
- 使用者補充：當 client 網路不好時，web 前端也會表現得像 AI/後端壞掉。

### Evidence Collected

- `packages/opencode/src/tool/task.ts` 在 child subagent 完成後，會立即呼叫 `Todo.reconcileProgress(... taskStatus: "completed")`。
- `packages/opencode/src/session/todo.ts` 的 `reconcileProgress("completed")` 會直接把 linked todo 標成 `completed`，且在沒有其他 `in_progress` 時，還會自動推進下一個 pending todo。
- `packages/opencode/src/session/workflow-runner.ts` 的 `planAutonomousNextAction()` 以 todo graph 作為唯一 continue/stop 依據；若已無 actionable todo，會直接回傳 `todo_complete`。
- 因此 parent orchestrator 還沒真正消化 `<child_session_output>`、也還沒自行更新 todo graph 前，runtime 就可能看到「todos 已排空」而提早 stop/completed。
- 同時既有 web/runtime 文件已記錄 SSE reconnect / foreground resume / stale-state 問題；弱網路會讓前端看起來像 AI 停住或壞掉，但這屬 symptom amplifier，不足以單獨解釋本次 server-side early-exit。

### Root Cause

- **Primary root cause (server-side)**：`task` tool 在 child 成功回傳當下，就越權替 parent orchestrator 把 linked todo 自動結案；這使得 runloop 的 todo-driven stop gate 在 parent 尚未消化 child 結果前就可能觸發 `todo_complete`。
- **Secondary amplifier (client-side)**：弱網路 / SSE 暫時失同步會讓 web UI 顯示 stale 或像是 AI 壞掉，放大操作感知；但這不是本次 early-exit 的唯一根因。

### Fix

- 將 child 成功完成後的 parent todo reconciliation 從 `completed` 改為新的 `returned` 語義。
- `returned` 只負責：
  - 保持 linked todo 為 `in_progress`
  - 清除 `waitingOn: "subagent"`
  - 不自動推進下一個 todo
- 讓 parent orchestrator 在下一輪真正讀取 child output 後，自行決定是否 `todowrite` 完成、拆新步驟或繼續委派。

## Validation

- `bun test "packages/opencode/src/session/todo.test.ts"` ✅
- `bun test "packages/opencode/src/session/workflow-runner.test.ts"` ✅

## Key Decisions

- 不在這一刀重建 runloop 或恢復舊的 synthetic parent continuation 注入；先守住「child completion 不得越權修改 parent completion semantics」這個邊界。
- 將弱網路視為並存 symptom amplifier，記錄於 RCA，但不把它當成掩蓋 server-side early-exit 的 fallback 解釋。

## Architecture Sync

- Updated `specs/architecture.md`：補記 child completion 返回 parent 時，只能解除 `waitingOn: subagent` / 保留 current todo，不能在 `task` tool 層直接把 parent linked todo 自動標成 completed。
