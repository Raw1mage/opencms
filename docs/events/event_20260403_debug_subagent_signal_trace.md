# Event: Debug Instrumentation — Subagent Completion Signal Trace

**Date**: 2026-04-03  
**Status**: In Progress (log collection phase)

---

## 問題描述

Subagent（`@coding`）完成工作後，main session 的計時器持續運轉，且 `resumePendingContinuations` 的 `count` 永遠為 0，代表 pending continuation 從未被 enqueue。Main session 必須靠人工通知才能繼續。

---

## Baseline

### 症狀
- Subagent 顯示工作結果，但 UI 計時器不停
- `resumePendingContinuations: pending items count: 0`（log 中確認）
- `worker_exit_unexpected: lastPhase: "heartbeat"`（done msg 未被讀到，或 Bus.publish 沒觸發 subscriber）

### 重現步驟
1. 在 main session 觸發 task tool 建立 subagent（例如 `@coding`）
2. Subagent 完成工作
3. Main session 計時器持續，無動作

### 影響範圍
- 所有使用 task tool 觸發 subagent 的 session

---

## 分析（RCA 候選）

### 候選 A：done message 收到但 worker.current id 不匹配
- `msg.type === "done"` 但 `worker.current?.id !== msg.id`
- 結果：Done event 不發出，active-child 不清除

### 候選 B：done message 根本沒被 streaming path 讀到
- Worker subprocess 在 stdout 寫入 done 前就被 kill
- `lastPhase: "heartbeat"` 印證此候選

### 候選 C：Done event publish 成功，但 subscriber early-exit（無 clearActiveChild）
- `enqueueParentContinuation` 在前期 guard 拋 error（parent 找不到、message 找不到、toolPart 找不到）
- 但這三個 guard 都沒有 `clearActiveChild()`

---

## Debug Instrumentation（本次變更）

### 修改的檔案
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/bus/subscribers/task-worker-continuation.ts`

### 新增 TRACE 標記（`[TRACE]` 前綴）

| 標記 | 位置 | 追蹤目標 |
|------|------|---------|
| `[TRACE] worker message parsed` | task.ts stdout loop | 每條 msg 的 type/id/hasCurrent |
| `[TRACE][DONE_MSG_RECEIVED]` | task.ts | done msg 到達時的完整狀態 |
| `[TRACE][DONE_MSG_NO_CURRENT]` | task.ts | current=undefined 警告 |
| `[TRACE][DONE_MSG_ID_MISMATCH]` | task.ts | id 不匹配警告 |
| `[TRACE][DONE_BRANCH_ENTERED]` | task.ts | 進入正常 done 處理分支 |
| `[TRACE][DONE_CURRENT_CLEARED]` | task.ts | worker.current 清除時機 |
| `[TRACE][BEFORE_DONE_PUBLISH]` | task.ts | Bus.publish 前 |
| `[TRACE][DONE_PUBLISH_SUCCESS]` | task.ts | Bus.publish 成功 |
| `[TRACE][DONE_PUBLISH_FAILED]` | task.ts | Bus.publish 失敗 |
| `[TRACE][STDOUT_EOF]` | task.ts | stdout EOF 時的 buffer 狀態 |
| `[TRACE][FLUSH_MSG_FOUND]` | task.ts | flush path 的 msg 解析 |
| `[TRACE][FLUSH_DONE_RECOVERED]` | task.ts | flush path 成功恢復 done |
| `[TRACE][EXIT_HANDLER]` | task.ts | exit handler 進入時狀態 |
| `[TRACE][EXIT_COMPENSATION]` | task.ts | compensation path 判斷 |
| `[TRACE][SUBSCRIBER_DONE_FIRED]` | continuation.ts | Done subscriber 觸發 |
| `[TRACE][ENQUEUE_START]` | continuation.ts | enqueueParentContinuation 入口 |
| `[TRACE][ENQUEUE_GET_PARENT]` | continuation.ts | 取 parent session |
| `[TRACE][ENQUEUE_EARLY_EXIT_1]` | continuation.ts | parent 找不到 |
| `[TRACE][ENQUEUE_EARLY_EXIT_2]` | continuation.ts | nested parent |
| `[TRACE][ENQUEUE_GET_MSG]` | continuation.ts | 取 assistant message |
| `[TRACE][ENQUEUE_EARLY_EXIT_3]` | continuation.ts | assistant msg 找不到 |
| `[TRACE][ENQUEUE_FIND_TOOL_PART]` | continuation.ts | 找 task tool part |
| `[TRACE][ENQUEUE_EARLY_EXIT_4]` | continuation.ts | tool part 找不到 |
| `[TRACE][ENQUEUE_CLEAR_ACTIVE_CHILD]` | continuation.ts | 清除 active child |
| `[TRACE][ENQUEUE_BEFORE_ENQUEUE]` | continuation.ts | enqueue continuation 前 |

---

## Validation（待完成）

**驗證指令**：
```bash
grep "\[TRACE\]" ~/.local/share/opencode/log/debug.log | tail -80
```

**預期目標**：找出 TRACE log 在哪個節點斷掉，確認具體 RCA

---

## 後續任務

- [ ] 觸發問題重現，收集 TRACE log
- [ ] 確認 RCA（候選 A/B/C）
- [ ] 實施 fix
- [ ] 清除 debug instrumentation
