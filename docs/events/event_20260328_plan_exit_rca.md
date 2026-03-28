# Event: plan_exit RCA

**Date**: 2026-03-28
**Topic**: `plan_exit` 無法被目前 AI 正確完成的根因分析

## Requirement

使用者指出：目前的 AI 沒辦法正確 `plan_exit`。本次任務要做 RCA，找出不是單次操作失誤，而是系統/對話/工具契約哪裡讓 agent 容易失敗。

## Scope

### IN
- 分析 `plan_exit` 的正常控制路徑
- 分析問題卡片（Yes/No）與 dismiss 對 session/agent 的影響
- 分析為什麼 agent 會誤觸 `plan_enter`
- 分析為什麼之後 `plan_exit` 會得到 `The user dismissed this question`
- 產出 root cause、causal chain、修復方向

### OUT
- 本 event 不直接修 code
- 本 event 不直接宣告 planner workflow 已修好

## Baseline

- 使用者明確要求 `go on plan_exit`
- agent 先誤觸 `plan_enter`
- 隨後 agent 執行 `plan_exit`
- 系統回傳 `Error: The user dismissed this question`
- screenshot 顯示真正跳出的第一張問題卡不是 `plan_exit` 的 build-mode 確認，而是先前誤觸 `plan_enter` 所造成的進入 plan mode 問題
- 隨後 agent 又執行 `plan_exit`，而當前 session 裡已有被 dismiss 的 question 狀態，最後錯誤浮現為 `The user dismissed this question`
- 因此這次事故至少有兩層：先問錯問題，再把 dismiss 當 raw error 浮出

## Instrumentation Plan

- 讀取 `plan_exit`、question/tool card、dismiss handling、session runtime 相關程式
- 確認 `plan_exit` 是否本來就會進 question contract
- 確認 dismiss 是否被轉成 error 而非明確 decision outcome
- 確認 agent 是否缺乏 guard，導致在 stop gate 未解前繼續呼叫工具

## Execution

- 追蹤 `plan_exit` 實作，確認 build-mode Yes/No 問題卡由 `packages/opencode/src/tool/plan.ts:1147-1161` 發出。
- 追蹤 question reject 鏈，確認 UI dismiss 會走 `/question/:requestID/reject`，再進 `Question.reject()`，最後產生 `RejectedError("The user dismissed this question")`；關鍵位置為 `packages/opencode/src/server/routes/question.ts:68-96` 與 `packages/opencode/src/question/index.ts:143-165`。
- 對照 `plan.ts` 其他問答路徑，確認 beta branch-name admission 已有 catch dismiss 並轉成 `product_decision_needed:*`，位置在 `packages/opencode/src/tool/plan.ts:1236-1247`。
- 對照 `workflow-runner.ts:661-667` 與 `processor.ts:836-841`，確認 `Question.RejectedError` 在 workflow continuation 世界裡其實被視為 stop gate / block signal，但這次 `plan_exit` 是在即時 tool call 內以 raw error 浮出。

## Root Cause

### Primary Root Cause

- **第一層根因是 agent tool selection 錯誤。** 使用者要求的是 `plan_exit`，但 agent 先誤觸了 `plan_enter`，因此 UI 先跳出的是「要不要 enter plan mode」之類的錯問題。這一步本身就已經讓整個 control flow 失真。

### Secondary Root Cause

- 在錯誤 question 已被建立後，系統後續又執行 `plan_exit`；而 question dismiss 沒被正規化成 workflow-level stop reason，最終以 `The user dismissed this question` raw error 浮出。

### Contributing Causes

1. **Agent misuse / trigger discipline failure**
   - 對明確的 `go on plan_exit` 指令，agent 沒有維持 tool intent discipline，先呼叫了相反方向的 `plan_enter`。
2. **Tool contract ambiguity**
   - `plan_exit` 的 UX 本質是 blocking question + human decision gate，但工具層沒有把 dismiss 明確建模為結構化 outcome。
3. **Runtime stop-state mismatch**
   - continuation / workflow runner 對 `Question.RejectedError` 有 stop-gate 認知；但互動 tool call 內仍可能直接爆 raw error，沒有把同樣語意提升成穩定的 paused state。

## Causal Chain

1. 使用者要求 `go on plan_exit`
2. agent 卻先誤呼叫 `plan_enter`
3. UI 因 `plan_enter` 跳出錯誤方向的 question（先問要不要進 plan mode）
4. 該 question 被 dismiss，走 `/question/:requestID/reject`
5. `Question.reject()` 產生 `RejectedError("The user dismissed this question")`
6. agent/系統在錯誤問題之後又嘗試呼叫 `plan_exit`
7. question dismiss 沒被整形成清楚的 workflow stop reason
8. 錯誤以 raw tool error 浮出
9. 外觀上就變成「AI 沒辦法正確 plan_exit」

## Validation

### Evidence

- 對話與 screenshot 證據顯示：當時先跳出的問題不是使用者要的 `plan_exit` 確認，而是 agent 誤觸 `plan_enter` 後的錯誤方向 question。
- `packages/opencode/src/tool/plan.ts:1147-1161`：補充證明 `plan_exit` 自身也確實有一條會發 build-mode 問題卡的路徑，因此本次事故是「先問錯問題」與「dismiss normalization 不佳」兩層疊加。
- `packages/opencode/src/question/index.ts:143-165`：證明 dismiss 會產生固定訊息 `The user dismissed this question`。
- `packages/opencode/src/server/routes/question.ts:92-95`：證明前端 dismiss 會走 reject route。
- `packages/opencode/src/tool/plan.ts:1236-1247`：證明同檔案其他問答流已知需要把 dismiss 轉成 `product_decision_needed:*`。
- `packages/opencode/src/session/workflow-runner.ts:661-667`：證明 runtime continuation 已把 `Question.RejectedError` 視為 block-immediately 的 decision gate。
- `packages/opencode/src/session/processor.ts:836-841`：證明 processor 也把 `Question.RejectedError` 視為 blocked 類訊號。

### Fix Verification

- 已修 directionality：`packages/opencode/src/session/prompt.ts` 補強 auto-enter plan mode 的 hard negative patterns，明確 `plan_exit` / build-mode switch 不再被 auto-route 成 `plan_enter`。
- 已修 dismiss normalization：`packages/opencode/src/tool/plan.ts:1147-1174` 將 dismiss 正規化成 `product_decision_needed: plan_exit build-mode confirmation was dismissed`，並將明確 `No` 正規化成 `product_decision_needed: plan_exit remained in plan mode`。
- 已新增 focused tests：`packages/opencode/test/session/planner-reactivation.test.ts`
  - `does not auto-route explicit plan_exit requests into plan mode`
  - `does not auto-route build-mode switch requests into plan mode`
  - `plan_exit normalizes explicit No into a workflow decision stop`
  - `plan_exit normalizes dismissed confirmation into a workflow decision stop`
- Focused test results:
  - `bun test packages/opencode/test/session/planner-reactivation.test.ts --test-name-pattern "does not auto-route explicit plan_exit requests into plan mode|does not auto-route build-mode switch requests into plan mode"` → 2 pass / 0 fail
  - `bun test packages/opencode/test/session/planner-reactivation.test.ts --test-name-pattern "plan_exit normalizes explicit No into a workflow decision stop|plan_exit normalizes dismissed confirmation into a workflow decision stop"` → 2 pass / 0 fail

## Repair Direction

- 已完成第一優先修復：強化 agent/tool selection discipline，對明確的 `plan_exit` 指令不得先觸發 `plan_enter` 或其他相反方向工具。
- 已完成第二優先修復：在 `plan_exit` 的 build-mode確認問答外層 catch `Question.RejectedError`，轉成明確 workflow-level stop reason，而不是 raw error。
- 已確認目前 `plan_exit` 進一步具有 beta admission quiz：會以 authority fields（如 mainRepo/mainWorktree/baseBranch/implementationRepo/implementationWorktree/implementationBranch/docsWriteRepo）挑戰 AI 的 beta execution 認知，首次失敗可反思一次，第二次仍不符則以 `product_decision_needed: beta admission mismatches after retry` 失敗。
- 後續可再評估：若已有未完成或剛被 dismiss 的 blocking question，是否加入更明確的 session-level guard。 

## Architecture Sync

- Updated: 需要在 architecture 同時補充兩件事：
  1. agent/tool selection 對明確 `plan_exit` 指令的方向性約束
  2. `plan_exit` question gate 的 dismiss normalization contract
