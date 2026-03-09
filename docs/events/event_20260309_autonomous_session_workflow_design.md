# Event: Autonomous session workflow design

Date: 2026-03-09
Status: In Progress

## 需求

- 釐清為何目前 Main Agent 在回覆後會回到待命，無法持續推進工作。
- 設計可讓 Main Agent 按計畫持續指揮 subagent、分析/計畫/執行/驗證循環的 session workflow。
- 明確界定 autonomous mode 的狀態機、停止條件、背景執行模型與 rollout 路線。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/**`
- `/home/pkcs12/projects/opencode/packages/app/**`
- session / task / tool orchestration / event / persistence 相關文件與程式

### OUT

- 本輪先做架構設計與計畫，不直接實作完整 autonomous executor
- 不處理與 autonomous workflow 無關的產品功能擴充

## 任務清單

- [x] 收斂目前 session workflow 的實際停點與限制
- [x] 界定 autonomous session 所需狀態機與責任邊界
- [x] 設計 Main Agent / subagent / scheduler / stop protocol
- [x] 產出分階段落地計畫
- [x] 落地 autonomous workflow Phase 1（metadata + state machine foundation）
- [x] 落地 dynamic model orchestration foundation（autonomous main turn + subagent dispatch）
- [x] 落地 shared sidebar status panel v1（goal / method / process / result）
- [x] 落地 todo-step ↔ task monitor linkage
- [x] 落地 todo dependency / auto-advance foundation
- [x] 落地 transcript-visible autonomous narration + interrupt-safe replanning foundation

## Debug Checkpoints

### Baseline

- 當 Main Agent 回覆使用者後，session 會回到等待使用者輸入的 request/response 模式。
- 缺乏背景持續執行與自動續跑機制。

### Execution

- 巡檢目前 session/task workflow 後，確認現況是標準 request/response 架構：
  - `packages/opencode/src/session/status.ts` 只有 `idle | retry | busy`，不足以表達 autonomous session lifecycle。
  - `packages/opencode/src/session/index.ts` 的 session metadata 尚未承載 autonomous policy / scheduler state / blocker state。
  - `packages/opencode/src/tool/task.ts` 已能安全 dispatch subagent，但只是一個「被當前回合呼叫的工具」，不是背景 scheduler。
  - `packages/opencode/src/session/todo.ts` 已有 todo persistence，可作為 autonomous runner 的工作集來源，但目前不會主動驅動續跑。
  - `packages/opencode/src/session/processor.ts` 只在本次 message processing 期間迴圈；assistant 回覆完成後，session 沒有自動再被喚醒。
  - `packages/opencode/src/session/command-handler-executor.ts` 也屬一次性觸發，沒有 background continuation 機制。
- 因此根因不是 prompt，而是缺少 system-level continuation runtime：
  - 沒有 autonomous mode flag
  - 沒有 scheduler / queue
  - 沒有 session-level stop protocol
  - 沒有在「assistant 回覆完成後」自動決定是否進入下一輪的執行器
- 在 Phase 1 實作中，先落地最小基礎，不碰 background executor：
  - `packages/opencode/src/session/index.ts`
    - 新增 persisted workflow metadata：
      - `workflow.autonomous`
      - `workflow.state`
      - `workflow.stopReason`
      - `workflow.updatedAt`
      - `workflow.lastRunAt`
    - session create 預設帶入 `defaultWorkflow()`，使新 session 一開始就有明確 workflow state
    - 新增 `mergeAutonomousPolicy(...)`、`setWorkflowState(...)`、`updateAutonomous(...)`
    - 新增 `session.workflow.updated` bus event
  - `packages/opencode/src/session/processor.ts`
    - assistant 回合開始時把 workflow state 設為 `running`
    - assistant 回合結束後依結果收斂成 `waiting_user` 或 `blocked`
    - 先把 stop reason 縮成 Phase 1 可觀測基礎（如 `permission_or_question_gate`、`assistant_error`）
  - `packages/opencode/src/server/routes/session.ts`
    - 擴充既有 `PATCH /session/:sessionID`，允許更新 workflow autonomous policy / state / stopReason
    - 避免另外開新 mutation route，先沿用既有 session metadata 更新路徑
  - `packages/opencode/src/session/index.test.ts`
    - 新增 workflow default / policy merge 測試
  - `packages/app` 尚未接入 workflow UI；本輪先把 runtime metadata 與 API contract 打底

## 初步設計

### 1. 新的 session workflow state

- 保留既有 `SessionStatus` 給 UI 的模型執行狀態（busy/retry/idle）。
- 另外新增獨立的 `SessionWorkflowState`，建議至少包含：
  - `idle`
  - `running`
  - `waiting_user`
  - `blocked`
  - `completed`
- 這層不取代 token/model 狀態，而是描述「整個 session 工作流是否應繼續」。

### 2. Autonomous policy 寫入 session metadata

- 在 session metadata 增加類似：
  - `autonomous.enabled`
  - `autonomous.maxContinuousRounds`
  - `autonomous.stopOnTestsFail`
  - `autonomous.requireApprovalFor`（push / destructive / architecture-change 等）
- 使用者一句 `go` 可以只更新 policy，而不是把所有續跑意圖隱含在自然語言裡。

### 3. Todo-driven continuation runner

- 新增 `SessionWorkflowRunner`：
  - 讀取 session todo
  - 判斷是否還有 `pending/in_progress`
  - 檢查 blocker / approval requirement / recent failures
  - 若可繼續，主動發起下一個 session round
- `Todo` 會從單純紀錄，升級為 scheduler 的工作輸入。

### 4. Assistant-complete hook

- 在 session processor / command executor 完成 assistant 回覆後，不是直接結束整個 workflow。
- 應交給 `SessionWorkflowRunner.maybeContinue(sessionID)`：
  - 若 autonomous disabled → 回到 `waiting_user`
  - 若 autonomous enabled 且無 blocker → enqueue next round
  - 若需要使用者決策 → 轉 `waiting_user`
  - 若發生 hard blocker → 轉 `blocked`

### 5. Main Agent / Subagent 角色分層

- Main Agent：只負責「下一個 slice 決策、指派、收斂、是否續跑」。
- Subagent：維持一次性 task worker，不改成常駐。
- Scheduler：只負責再喚醒 Main Agent，不直接做任務內容決策。
- 這樣可避免把 subagent worker pool 誤做成全域自治 orchestrator。

### 6. 明確 stop protocol

- 只有遇到以下情況才停：
  - 需要產品/規格決策
  - destructive action 未授權
  - 連續驗證失敗
  - provider/tooling exhausted
  - 外部依賴需要人處理
- 其他情況應由 autonomous runner 自動續跑。

### 7. UI / Web / TUI 可觀測性

- session UI 應顯示：
  - current workflow state
  - autonomous on/off
  - pending blockers
  - next planned step
  - last auto-round timestamp
- 否則使用者會誤以為 agent「停住了」，其實只是 runner 在等待條件。

## 建議 rollout

### Phase 1 — Metadata + state machine

- 新增 `SessionWorkflowState` 與 autonomous policy persistence
- 先不做背景執行，只把狀態與 stop reasons 建模好

### Phase 2 — In-process auto-continue

- 在單一 app/runtime 內加入 `maybeContinue(sessionID)`
- assistant 回合結束後，若條件成立就自動再進下一輪
- 先不跨重啟恢復

## Phase 2 實作

- `packages/opencode/src/session/workflow-runner.ts`
  - 新增 `evaluateAutonomousContinuation(...)` / `decideAutonomousContinuation(...)`
  - 判斷條件目前收斂為：
    - subagent session 不自動續跑
    - autonomous disabled 不續跑
    - blocked 不續跑
    - `maxContinuousRounds` 達上限則停
    - todo 還有 `pending` / `in_progress` 時才續跑
  - 新增 `enqueueAutonomousContinue(...)`，在允許續跑時寫入 synthetic user message
- `packages/opencode/src/session/prompt.ts`
  - 在 `processor.process(...)` 回合完成、結果為 `stop` 後，不再一律直接 break
  - 若 workflow runner 判定可續跑，會插入 synthetic continue user message 並留在同一個 `loop(...)` 中繼續下一輪
  - 若 todo 已完成，workflow state 轉為 `completed`
  - 若是 hit `maxContinuousRounds`，則保留在 `waiting_user` 並寫入 stopReason
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 補 autonomous continuation 決策測試
- 目前 Phase 2 仍是 **in-process skeleton**：
  - 沒有 durable queue
  - 沒有跨重啟恢復
  - 沒有 multi-session fairness / scheduler arbitration
  - 但已經能在單次 session loop 中，基於 todo 與 workflow policy 自動續跑下一步

### Phase 3 — Durable queue / resume

- 將 pending continuation 寫入 storage
- 支援 runtime 重啟後恢復 autonomous session

## Phase 3 實作（foundation）

- `packages/opencode/src/session/workflow-runner.ts`
  - 新增 storage-backed pending continuation helpers：
    - `enqueuePendingContinuation(...)`
    - `getPendingContinuation(...)`
    - `clearPendingContinuation(...)`
    - `listPendingContinuations()`
  - `enqueueAutonomousContinue(...)` 現在在寫入 synthetic user message 的同時，也會留下 durable pending continuation record
- `packages/opencode/src/session/processor.ts`
  - assistant 回合真正開始時會 `clearPendingContinuation(sessionID)`
  - 這表示 queue entry 的語義是：
    - 「下一輪 autonomous continuation 已經排入，但尚未被 processor 實際接手」
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 補 queue persistence / clear regression test
- 目前這仍是 **Phase 3 foundation**，尚未完成完整 resume：
  - queue 已 durable
  - 但還沒有 boot-time supervisor 去掃描 queue 並自動重新喚醒 session loop
  - 這會留到下一個 slice（Phase 3b / Phase 4 之間）

### Phase 4 — Supervisor / scheduling policy

- 引入更完整的 queue fairness、rate limiting、multi-session arbitration
- 避免多個 autonomous sessions 同時搶 worker/provider 資源

## Phase 4 實作（in-process supervisor）

- `packages/opencode/src/session/workflow-runner.ts`
  - 新增 `shouldResumePendingContinuation(...)`，把 resume gate 條件收斂成可測邏輯
  - 新增 `resumePendingContinuations()`：
    - 掃描 durable pending continuation queue
    - 檢查 session 是否 idle / autonomous enabled / 非 blocked / 非 completed
    - 以 in-memory `resumeInFlight` + `Lock.write(...)` 避免重複 resume
    - 透過 dynamic import 重新進入 `SessionPrompt.loop(sessionID)`
    - 若 resume 失敗，會清 queue 並把 workflow state 轉成 `blocked`
  - 新增 `ensureAutonomousSupervisor()`，啟動固定 interval 的 in-process queue scan
- `packages/opencode/src/server/app.ts`
  - server app 啟動時即啟用 `ensureAutonomousSupervisor()`
  - 這使 web/server runtime 具備「只要 process 活著，就會持續掃 pending autonomous sessions」的最小 supervisor 能力
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 補 `shouldResumePendingContinuation(...)` 的 resume gate 測試
- 目前 Phase 4 仍有限制：
  - supervisor 仍是單 process / in-process interval，不是獨立 daemon scheduler
  - 尚未加入多 session fairness、provider budget arbitration、backoff policy
  - 但已經從「有 queue」進展到「server runtime 會主動恢復 idle autonomous session」

## Dynamic model orchestration foundation

- `packages/opencode/src/session/model-orchestration.ts`
  - 新增集中式 model orchestration helper：
    - `domainForAgent(...)`
    - `shouldAutoSwitchMainModel(...)`
    - `selectOrchestratedModel(...)`
    - `resolveProviderModel(...)`
  - 規則先收斂為：
    - explicit model 最高優先
    - agent pinned model 次之
    - 否則依 agent domain 走 `ModelScoring.select(...)`
    - 若 scoring 失敗則回退到 caller fallback model
- `packages/opencode/src/session/workflow-runner.ts`
  - `enqueueAutonomousContinue(...)` 現在在 synthetic autonomous user turn 建立前，會檢查是否應 auto-switch main model
  - 當 session 處於 autonomous synthetic continue 流程時，main agent 可從上一輪模型切到較適合當前 agent domain 的模型，而不是永遠沿用前一個 user-selected model
- `packages/opencode/src/tool/task.ts`
  - subagent dispatch 改為透過 orchestration helper 做 model resolve：
    - 顯式 `model` 參數保留最高優先
    - agent 自帶 pinned model 仍會保留
    - 若都沒有，subagent 不再無條件繼承 parent model，而會先嘗試依 subagent domain 選出更適合的模型
- `packages/opencode/src/session/prompt.ts`
  - subtask part 若有 `task.model`，現在會把 model 明確傳入 `TaskTool`，避免 command/subtask 顯式指定模型時被後續 orchestration 意外覆蓋
- `packages/opencode/src/session/model-orchestration.test.ts`
  - 補 pure helper regression tests，驗證 domain mapping / autonomous synthetic gate / precedence order

## Phase 5 實作（progress narration + interrupt-safe replanning foundation）

- `packages/opencode/src/session/prompt-runtime.ts`
  - runtime entry 新增 `runID`
  - `start(..., { replace: true })` 可安全取代正在執行的 autonomous runtime，並先 abort 舊 run
  - `finish(sessionID, runID)` 只會清理對應 run，避免舊 loop 的 deferred cleanup 誤刪新 loop
- `packages/opencode/src/session/prompt.ts`
  - `prompt(...)` 現在在新使用者訊息進來時，會先判斷是否應該中斷 busy 的 autonomous synthetic run，再以 replace-runtime 方式重啟 loop
  - autonomous `stop` 決策現在會先寫入簡短 synthetic assistant narration，讓訊息流顯示「正在接續哪個 todo」或「為何暫停」
- `packages/opencode/src/session/workflow-runner.ts`
  - continuation planner 現在回傳目前要處理的 todo，供 narrator 直接引用
  - 新增 `describeAutonomousNextAction(...)` 與 `shouldInterruptAutonomousRun(...)`，把 progress narration / interrupt gate 收斂成可測 pure logic
- `packages/opencode/src/session/message-v2.ts`
  - narrator text part 透過 `metadata.excludeFromModel = true` 留在使用者可見訊息流，但不回灌模型上下文
- `packages/opencode/src/session/prompt-runtime.test.ts`
  - 補 runtime replace safety regression test，驗證舊 run finish 不會清掉新 run

### Validation

- `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/workflow-runner.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt-runtime.test.ts"` ✅
- `bun run --cwd "/home/pkcs12/projects/opencode/packages/opencode" typecheck` ✅
- Architecture Sync: Verified (Doc updated for narration + runtime replacement contract)

## Current wrap-up pass

### Execution

- 本輪對尚未提交的 shared status UI / todo contract 相關 dirty diff 做聚焦盤點與驗證。
- 聚焦驗證結果：runtime todo contract、shared sidebar status panel、task monitor linkage 目前皆可通過 focused tests 與 app/opencode typecheck。
- 清除 `packages/app/src/pages/session/session-side-panel.tsx` 中一段 sidebar render `console.debug(...)` 殘留，避免把暫時性 debug 輸出留在交付狀態。

### Validation

- `bun test --preload "/home/pkcs12/projects/opencode/packages/app/happydom.ts" "/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts" "/home/pkcs12/projects/opencode/packages/app/src/pages/session/monitor-helper.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/todo.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/session/index.test.ts"` ✅
- `bun run --cwd "/home/pkcs12/projects/opencode/packages/app" typecheck && bun run --cwd "/home/pkcs12/projects/opencode/packages/opencode" typecheck` ✅
- Architecture Sync: Verified (No doc changes required for debug-log cleanup; current architecture wording already covers sidebar status/todo linkage/runtime contract)

## Dynamic model orchestration follow-up

- `packages/opencode/src/session/model-orchestration.ts`
  - orchestration 現在不只看 agent domain scoring，也會接上現有 rotation/health 狀態：
    - 先檢查 scored model 是否 operational（rate-limit / account health / provider health status）
    - 若 scored model 不可用，退回 caller fallback model
    - 若 scored 與 fallback 都不可用，會再透過 `findFallback(...)` 嘗試找可用 rescue candidate
  - 這使 autonomous synthetic main turn 與 subagent dispatch 開始具備最小 quota/health-aware arbitration，而不是只做靜態 domain ranking
- `packages/app/src/pages/session.tsx`
  - session 頁面現在會從 session metadata 讀出 workflow/autonomous 狀態，整理成 header chips
- `packages/app/src/pages/session/message-timeline.tsx`
  - session header 現在可顯示：
    - `Auto`
    - `Model auto`
    - workflow state（Running / Waiting / Blocked / Completed）
    - stop reason 摘要
- `packages/app/src/pages/session/helpers.ts`
  - 新增 `getSessionWorkflowChips(...)`，集中處理 workflow state / stop reason 的 UI 摘要轉換，避免頁面直接耦合 raw metadata
- `packages/opencode/src/session/model-orchestration.ts`
  - 新增 `orchestrateModelSelection(...)`，除了回傳 resolved model，也產出可序列化的 arbitration trace
- `packages/opencode/src/session/workflow-runner.ts`
  - autonomous synthetic user part 會寫入 `metadata.modelArbitration`，把 main-agent auto-switch 的決策依據附著到該回合 user turn
- `packages/opencode/src/tool/task.ts`
  - subagent `TaskTool` metadata 現在除了 sessionId/model，也會帶 `modelArbitration`，讓 UI 可以看到 subagent 實際是 scored / fallback / rescue 哪種決策
- `packages/app/src/pages/session/helpers.ts`
  - 新增 `getSessionArbitrationChips(...)`，從 user/tool part metadata 抽出最新 arbitration trace 並轉成 UI chips
- `packages/app/src/pages/session/message-timeline.tsx`
  - session header 現在除了 workflow chips，也會顯示最新 arbitration trace 摘要（source + resolved provider/model）
- 目前限制：
  - scored candidate 的 arbitration 仍是 local/in-process 決策，尚未接到全域 multi-session budget scheduler
  - explicit model / agent pinned model 仍保留最高優先，不主動覆寫
  - header 目前只顯示「最新一筆」arbitration trace 摘要，尚未提供完整 per-turn trace timeline / debug inspector

## Autonomous scheduler fairness follow-up

- `packages/opencode/src/session/workflow-runner.ts`
  - supervisor resume sweep 不再看到 queue 就全部同時拉起
  - 新增 `pickPendingContinuationsForResume(...)`：
    - 只挑符合 resume gate 的 session
    - 依 `workflow.lastRunAt` 最久未跑優先
    - 次序再看 queue `createdAt`
    - 每輪 sweep 預設只拉起 1 個 autonomous session，避免同時 stampede
  - scheduler 在實際 resume 前會先把 workflow state 設成 `running` 並更新 `lastRunAt`
  - 這讓 autonomous supervisor 至少具備最小 fairness：不會因 queue scan 一口氣把所有 session 都搶起來，也比較不會讓先前剛跑過的 session 持續霸佔機會
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 fairness tests：
    - oldest-starved session 先被挑中
    - blocked / busy session 不會進入當輪 resume candidates
- 目前限制：
  - 仍是單 process / in-process interval scheduler
  - fairness 目前是 time-based（lastRunAt / createdAt），尚未接入 provider-family level budget buckets
  - 尚未做 weighted policy（例如 docs/coding/testing 不同 class 的配額）

## Provider-family budget bucket follow-up

- `packages/opencode/src/session/workflow-runner.ts`
  - scheduler 現在會為每個 pending continuation 推導 budget bucket：
    - 從 pending user message / arbitration metadata 推導 selected provider/model
    - 解析成 canonical provider family
    - 透過 `Account.getMinWaitTime(family, model)` 取得目前 family bucket wait time
  - `pickPendingContinuationsForResume(...)` 排序規則擴充為：
    - 先挑 `waitTimeMs === 0` 的 ready family buckets
    - 再看 wait time 長短
    - 再看 `lastRunAt`
    - 再看 queue `createdAt`
  - 同一輪 sweep 會先盡量分散到不同 provider families，再補第二個同 family session，避免某個 family 把全部 resume slot 吃掉
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 bucket-aware tests：
    - ready family 優先於較老但仍在 cooldown/rate-limit 的 family
    - 同一輪會先 spread 到不同 provider families
- 目前限制：
  - budget bucket 目前只看 family min wait time，尚未綜合 tokens/cost window/5hr quota 等更高階配額訊號
  - 若所有 families 都在等待中，scheduler 仍會選最接近可用/最久未跑的 session，而不是完全停擺
  - 尚未接入真正的 global budget oracle 或 daemon-level lease system

## Supervisor lease / retry-backoff contract follow-up

- `packages/opencode/src/session/index.ts`
  - workflow schema 新增 `supervisor` 區塊，開始持久化：
    - `leaseOwner`
    - `leaseExpiresAt`
    - `retryAt`
    - `consecutiveResumeFailures`
    - `lastResumeError`
  - 新增 `Session.updateWorkflowSupervisor(...)`，讓 supervisor contract 可以和 workflow state 分開演進
- `packages/opencode/src/session/workflow-runner.ts`
  - 加入 process-local supervisor owner ID 與 lease TTL
  - `shouldResumePendingContinuation(...)` 現在會檢查：
    - foreign active lease
    - future `retryAt`
  - resume 成功後會清 lease / retry 狀態並把 failure counter 歸零
  - resume 失敗後會：
    - 累加 `consecutiveResumeFailures`
    - 依 exponential backoff 設定下一次 `retryAt`
    - failure 達門檻後轉成 `blocked`
  - 這代表 scheduler 不再只是「掃 queue 然後再跑一次」，而是開始具備最小的 lease / retry / escalation contract
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 lease/backoff tests：
    - same-owner lease recovery allowed
    - foreign lease blocked
    - exponential backoff capped at upper bound
- 目前限制：
  - lease 仍是存在 session workflow metadata 中，不是跨 process 的強一致 distributed lease
  - in-flight round 若 process crash，只能靠 lease expiry + retryAt 恢復，不是精準 checkpoint replay
  - failure classification 仍偏粗（目前以 generic resume failure 為主），尚未拆成 tool/network/provider/auth 類型化策略

## Failure taxonomy / stop-block contract follow-up

- `packages/opencode/src/session/workflow-runner.ts`
  - 新增 `classifyResumeFailure(...)`，把 autonomous resume failure 初步分成：
    - `provider_rate_limit`
    - `provider_auth`
    - `provider_transient`
    - `tool_runtime`
    - `session_state`
    - `unknown`
  - stop/block contract 現在會依 category 決定：
    - auth / tool / session-state 類直接 block
    - rate-limit / transient / unknown 類先 retry + backoff
  - `stopReason` 也從 generic failure 改成：
    - `resume_blocked:<category>:<reason>`
    - `resume_retry_scheduled:<category>:<reason>`
  - workflow supervisor metadata 也會持久化 `lastResumeCategory`
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 failure taxonomy tests：
    - auth failure → immediate block
    - tool runtime failure → immediate block
    - transient provider failure → retry
- 目前限制：
  - taxonomy 目前仍以 message/error-shape heuristics 為主，還沒有完整 typed error graph
  - 尚未把 permission/approval-required 類型提升成獨立 autonomous stop contract 類別
  - 仍缺 per-tool/per-provider 專屬 retry policy

## Session planner / executor contract follow-up

- `packages/opencode/src/session/workflow-runner.ts`
  - 新增 `planAutonomousNextAction(...)`，把 autonomous session 的下一步從單純 `todo_pending` 判斷，提升成最小 planner/executor contract
  - planner 目前會區分：
    - `continue: todo_in_progress` → 優先完成已在做的工作
    - `continue: todo_pending` → 開始下一個待做事項
    - `stop: wait_subagent` → 若當前 session 還有 active task tool/subagent，先等待而不是再塞 synthetic turn
    - 其餘 stop reasons（blocked / complete / rounds reached ...）
  - 新增 `countActiveSubtasks(...)`，會掃當前 session assistant tool parts 中 `task` 的 `pending/running` 狀態
  - pending continuation queue 現在接受 `todo_in_progress` / `todo_pending` 兩種 planner reason
- `packages/opencode/src/session/prompt.ts`
  - autonomous continuation 不再固定塞同一句 prompt
  - 改由 planner decision 決定 synthetic text
  - 若 planner 回傳 `wait_subagent`，workflow 會停在 `waiting_user` + `stopReason=wait_subagent`
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 planner tests：
    - in-progress todo 優先延續
    - active subagent/task 存在時不再額外 enqueue autonomous turn
- 目前限制：
  - planner 仍是 heuristic/minimal contract，尚未形成完整 goal decomposition / explicit plan graph
  - 還沒有真正的 plan revision / evidence checkpoint / subagent result synthesis loop
  - `wait_subagent` 目前只依 tool part 狀態判斷，尚未引入 richer session graph supervisor semantics

## Approval-needed / blocker contract follow-up

- `packages/opencode/src/session/workflow-runner.ts`
  - planner 現在在 autonomous next-action 決策前，會先檢查 session 是否存在：
    - pending permission approvals → `approval_needed`
    - pending questions / product clarifications → `product_decision_needed`
  - 新增 `countPendingApprovals(...)` / `countPendingQuestions(...)`
  - 這讓 autonomous session 遇到「真的該停下來等人」的情況時，會停在明確 contract，而不是被 generic retry/block 混掉
  - failure classifier 也開始識別 approval/product-decision 類訊號，避免後續 supervisor 將其誤判為可重試 transient failure
- `packages/opencode/src/session/prompt.ts`
  - autonomous stop branch 現在會把這兩類 stop reason 寫回 workflow：
    - `approval_needed`
    - `product_decision_needed`
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 planner/blocker tests：
    - pending approval → stop
    - pending product question → stop
- 目前限制：
  - approval contract 目前只看 pending permission/question queues，尚未把 `requireApprovalFor` 直接提升成靜態 next-action gate
  - product-decision detection 目前仍以 question queue / corrected feedback 為主，還不是完整 semantic blocker extractor
  - UI 尚未把這兩類 blocker 單獨做成高顯著提醒面板

## requireApprovalFor planner gate follow-up

- `packages/opencode/src/session/workflow-runner.ts`
  - 新增 `detectApprovalRequiredForTodos(...)`
  - planner 現在不只看 live pending approval/question queues，也會直接讀 autonomous policy 的 `requireApprovalFor`
  - 目前先以 minimal heuristic 把 actionable todo content 映射到三類 gate：
    - `push`
    - `destructive`
    - `architecture_change`
  - 若命中，autonomous next action 會直接停在 `approval_needed`
  - 這表示 session master agent 已開始遵守靜態 safety policy，而不是等真的跑到 permission ask 才停
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 policy gate tests：
    - push todo 命中 push gate
    - delete/remove/reset 類 todo 命中 destructive gate
    - schema/migration/refactor 類 todo 命中 architecture gate
    - 即使當下還沒有 live permission queue，也會先停在 `approval_needed`
- 目前限制：
  - gate detection 目前仍以 todo text heuristics 為主，還沒有真正的 intent classifier / plan graph annotation
  - 尚未把 tool input / command payload / diff intent 一起納入 gate 判斷
  - 未來需要把 heuristic gate 升級成 structured action plan metadata，降低誤判

## Structured action-plan metadata follow-up

- `packages/opencode/src/session/todo.ts`
  - `Todo.Info` 新增可選 `action` metadata，允許 planner 使用結構化訊號而非只靠 todo text
  - 目前 action metadata 最小集合包含：
    - `kind`
    - `risk`
    - `needsApproval`
    - `canDelegate`
    - `waitingOn`
- `packages/opencode/src/session/workflow-runner.ts`
  - planner 新增 structured action consumption：
    - `detectStructuredStopReason(...)`
    - `detectStructuredApprovalGate(...)`
  - 若 todo 帶有結構化 action，planner 會優先採信它，而不是退回文字 heuristic
  - 例如：
    - `action.kind = push|destructive|architecture_change` 可直接命中 approval gate
    - `action.waitingOn = subagent|approval|decision` 可直接對應 stop reason
  - 這讓 autonomous session 開始從「讀文字猜下一步」轉向「讀 action metadata 做下一步決策」
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 structured action tests：
    - structured `push` action 命中 approval gate
    - structured `architecture_change` action 即使文字不明顯也會停在 approval gate
    - structured `waitingOn=subagent` 會直接停在 `wait_subagent`
- 目前限制：
  - action metadata 雖已進入 planner，但尚未由上游 tools / agent 規劃流程穩定產生
  - 還沒有 action graph / dependency graph，只是單點 metadata
  - 下一步需要把 todowrite / subtask planning 流程也逐步導向輸出 structured action metadata

## Structured action metadata propagation follow-up

- `packages/opencode/src/session/todo.ts`
  - 新增 `inferActionFromContent(...)`、`enrich(...)`、`enrichAll(...)`
  - `Todo.update(...)` 現在會在寫入前自動補齊缺失的 action metadata
  - 這表示即使上游 `todowrite` 還沒完全結構化輸出，runtime 仍會把 freeform todo 轉成最小 action metadata，供 autonomous planner 使用
  - 目前自動推導涵蓋：
    - push/release/deploy/publish → `push`
    - delete/remove/drop/reset/destroy → `destructive`
    - architecture/refactor/schema/migration → `architecture_change`
    - waiting on / blocked by → `wait`
    - delegate / subagent / hand off → `delegate`
    - 其他預設 → `implement`
- `packages/opencode/src/session/todo.test.ts`
  - 新增 todo action inference/persistence tests，驗證 runtime enrichment 會把 freeform todo 穩定轉成 planner 可用的 structured metadata
- 目前限制：
  - propagation 現在是 runtime-side enrichment，不代表 agent 已經學會穩定主動輸出高品質 action metadata
  - inference 仍屬 heuristic，尚未結合 tool call history / subtask results / session graph
  - 下一步應考慮把 todowrite prompt/contract 顯式升級，讓 agent 原生輸出更準確的 structured action

## todowrite contract / planning prompt upgrade follow-up

- `packages/opencode/src/tool/todo.ts`
  - `todowrite` tool schema description 現在明確要求：若已知，請原生提供 todo `action` metadata
  - `TodoWriteTool.execute(...)` 現在回傳的是寫入後的 enriched todo state，而不是原始輸入，讓呼叫端立即看見最終 action metadata
- `packages/opencode/src/tool/todowrite.txt`
  - 補上 native structured action output 指南：
    - `kind`
    - `risk`
    - `needsApproval`
    - `canDelegate`
    - `waitingOn`
  - 同時明示：runtime inference 只是 best-effort，明確 metadata 才是首選
- `packages/opencode/src/session/system.ts`
  - planning guidance 現在會直接提醒 agent：使用 `todowrite()` 時優先提供結構化 `action` metadata，減少 autonomous planner 猜測
- `packages/opencode/src/session/todo.test.ts`
  - 補上 `Todo.update` / `Todo.get` round-trip test，驗證 todo 經 runtime 寫入後會保留 enriched action metadata
- 目前限制：
  - contract 已升級，但尚未對所有 agent/system prompt example 做全面 few-shot 改寫
  - 上游規劃器仍可能輸出簡單 todo；目前靠 tool contract + runtime enrichment 雙軌兜底
  - 後續可再把 subtask/result synthesis 也納入 action metadata 回寫

### Validation

- `bun run --cwd packages/opencode typecheck` ✅
- `bun test --cwd packages/opencode src/session/index.test.ts` ✅
- `bun test --cwd packages/opencode src/session/index.test.ts src/session/workflow-runner.test.ts` ✅
- Phase 3 foundation 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test --cwd packages/opencode src/session/index.test.ts src/session/workflow-runner.test.ts` ✅
- Phase 4 in-process supervisor 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test --cwd packages/opencode src/session/index.test.ts src/session/workflow-runner.test.ts` ✅
- Dynamic model orchestration foundation 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/model-orchestration.test.ts packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts` ✅
- Dynamic model orchestration follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun run --cwd packages/app typecheck` ✅
  - `bun test --preload packages/app/happydom.ts packages/app/src/pages/session/helpers.test.ts` ✅
- Arbitration trace follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck && bun run --cwd packages/app typecheck` ✅
  - `bun test packages/opencode/src/session/model-orchestration.test.ts packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts` ✅
  - `bun test --preload packages/app/happydom.ts packages/app/src/pages/session/helpers.test.ts` ✅
- Autonomous scheduler fairness follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/model-orchestration.test.ts packages/opencode/src/session/index.test.ts` ✅
- Provider-family budget bucket follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/model-orchestration.test.ts packages/opencode/src/session/index.test.ts` ✅
- Supervisor lease / retry-backoff contract follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- Failure taxonomy / stop-block contract follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- Session planner / executor contract follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- Approval-needed / blocker contract follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- requireApprovalFor planner gate follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- Structured action-plan metadata follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- Structured action metadata propagation follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/todo.test.ts packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- todowrite contract / planning prompt upgrade follow-up 驗證：
  - `bun run --cwd packages/opencode typecheck` ✅
  - `bun test packages/opencode/src/session/todo.test.ts packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts` ✅
- Architecture Sync: Updated `docs/ARCHITECTURE.md`
  - 本輪再補上 todowrite contract/prompt 升級，讓文件反映 planning path 已開始原生鼓勵 structured action，而不只靠 runtime 補救。

## TUI / Web parity note

- 目前 session 互動表面不是分成獨立 `packages/tui` 與 `packages/app` 兩套實作；本 repo 現況是以 `packages/app/src/pages/session.tsx` 與相關 session components 作為共用 session surface
- 因此本輪 workflow/arbitration/header visibility 的 UI 變更，已自然同時作用在現有 TUI/Web 共享 session 介面，而不是 Web-only feature branch
- 後續規範：凡新增 autonomous session 相關可觀測性/操作能力，必須優先落在共享 session surface 或共享 runtime contract，避免先做單端漂移

## Shared sidebar status audit

- 已確認現有共享 session surface 其實已經有可重用的 sidebar status 基礎：
  - `packages/app/src/pages/session/session-side-panel.tsx`
  - `packages/app/src/pages/session/session-status-sections.tsx`
  - `packages/app/src/pages/session/status-todo-list.tsx`
  - `packages/app/src/pages/session/use-status-monitor.ts`
  - `packages/app/src/pages/session/monitor-helper.ts`
- 目前 sidebar 已具備兩條資料主軸：
  - **Todo list**：由 `sync.data.todo[sessionID]` 驅動
  - **Task monitor**：由 `session.top(... includeDescendants)` + tool/message status 推導 monitor entries
- audit 判斷：這就是最適合落實 shared status panel 的現成骨架，應優先擴充，而不是另造新 sidebar
- 目前仍存在的可觀測性缺口：
  1. **Goal**：todo content 有，但尚未把 in-progress/current step 做高顯著聚焦
  2. **Method**：task monitor 只顯示 active tool / model / token，缺少「採取的方法」摘要（例如 delegate / wait / approval / destructive gate）
  3. **Process**：缺少 planner reason、workflow stop reason、action metadata 的清晰呈現
  4. **Result**：monitor 著重 active work，較少顯示最近完成步驟/結果摘要
- 因此下一個 shared status panel phase 應優先補：
  - sidebar 置頂 current objective / current step
  - todo action metadata 可視化（kind / waitingOn / approval）
  - workflow stop reason / planner decision / latest result summary
  - subagent/task method/result alignment，讓使用者能看到「目標、方法、過程、結果」

## Shared sidebar status panel v1

- `packages/app/src/pages/session/session-side-panel.tsx`
  - 重用既有 Status mode，新增 shared summary 區塊，不另造新 sidebar
  - summary 現在會顯示：
    - **Current objective**：當前 in-progress / pending step
    - **Method**：由 todo action metadata 推導的 chips（例如 wait / waiting: subagent / needs approval / delegable）
    - **Process**：workflow state / stop reason / runtime status
    - **Latest result**：最近 completed/cancelled todo 的結果摘要
- `packages/app/src/pages/session/status-todo-list.tsx`
  - todo list 現在會高亮 current step
  - 同步顯示 todo action badges，讓 sidebar progress 不只看到文字，也看到方法/等待條件
- `packages/app/src/pages/session/session-status-sections.tsx`
  - Status mode 新增 `Autonomous` summary section，作為 shared status panel 的收斂入口
- `packages/app/src/pages/session/helpers.ts`
  - 新增 `getSessionStatusSummary(...)`
  - 集中推導 current objective / method chips / process lines / latest result，避免 UI 自行拼湊 runtime 狀態
- `packages/app/src/pages/session/helpers.test.ts`
  - 新增 summary derivation tests，驗證 sidebar 會把「目標、方法、過程、結果」收斂成一致摘要
- 目前限制：
  - latest result 目前以 todo 完成/取消為主，尚未綁定更細的 assistant/subagent result artifacts
  - method 層目前以 todo action metadata 為核心，尚未把 task monitor 的 tool/result 詳情做完整融合
  - 下一步應把 subagent/task result synthesis 接到 summary，讓 sidebar 不只知道「做了什麼」，也知道「產出了什麼」

## Sidebar subagent/task result synthesis

- `packages/app/src/pages/session/helpers.ts`
  - `getSessionStatusSummary(...)` 現在除了 todo/workflow，也會讀 assistant message parts
  - 新增 task result synthesis：
    - 最近完成的 `task` tool part → `Task completed · provider/model`
    - 最近失敗的 `task` tool part → `Task blocked: ...`
    - 最近仍在跑的 `task` tool part → `Task running · <subagent_type>`
  - 這使 sidebar summary 開始從 todo-only 進化成能看見 subagent/task 的真實 execution result
- `packages/app/src/pages/session/session-side-panel.tsx`
  - summary 現在會把 `sync.data.part` 傳入 status summarizer，讓 shared sidebar 可以直接消化 runtime tool part 狀態
- `packages/app/src/pages/session/helpers.test.ts`
  - 補上 synthesized task result test，驗證最新 task tool completion 會優先成為 latest result，而不是被較舊的 todo completion 蓋掉
- 目前限制：
  - 目前仍是 latest-task-first 的簡化摘要，尚未做 per-todo ↔ per-task 精準關聯
  - 尚未把 tool output/result body 壓縮成更細的可讀摘要
  - 下一步若要再升級，應建立 todo-step 與 task part 的明確映射

## Todo-step ↔ task monitor linkage

- `packages/opencode/src/tool/task.ts`
  - TaskTool 現在會在啟動 subagent 時，把 parent session 當前 todo step 附著到 task tool metadata：
    - `todo.id`
    - `todo.content`
    - `todo.status`
    - `todo.action`
  - 這讓 runtime 從 task 啟動當下就保留「這個 SA 是為了哪一步 todo」的 linkage
- `packages/app/src/pages/session/monitor-helper.ts`
  - monitor entries 現在會從 tool part metadata 讀出 todo linkage 與 latest task result
  - tool row / agent row 可開始攜帶：
    - linked todo
    - latest result
- `packages/app/src/pages/session/session-side-panel.tsx`
  - sidebar task monitor 現在直接顯示：
    - `Todo: <step content>`
    - `Method: <action kind / waitingOn / needsApproval>`
    - `Result: <latest task result>`
  - 這讓使用者在 task monitor 中可以直接看到「哪個 SA 在哪個 todo step 上」
- `packages/app/src/pages/session/monitor-helper.test.ts`
  - 新增 linkage test，驗證 task monitor row 會正確接回 todo 與 result
- 目前限制：
  - 目前 linkage 仍以「task 啟動時抓當前 todo」為主，尚未做到多 task 並行時的更強 dependency mapping
  - agent/session level monitor row 的 linkage 仍是 best-effort，最精準的是 tool-level row
  - 若未來要更準，需為 todo-step 建立顯式 task IDs / dependency edges

## Todo dependency + auto-advance foundation

- `packages/opencode/src/session/todo.ts`
  - action metadata 新增 `dependsOn`，允許 todo step 表達最小 dependency
  - 新增：
    - `isDependencyReady(...)`
    - `nextActionableTodo(...)`
    - `reconcileProgress(...)`
  - 行為：
    - subagent/task 成功完成 linked todo 時，該 todo 會標成 `completed`
    - 若沒有其他 in-progress step，下一個 dependency-ready pending todo 會自動推進為 `in_progress`
    - task error 時，linked todo 會保留在 `in_progress` 並標成 `waitingOn=subagent`
- `packages/opencode/src/tool/task.ts`
  - task 成功/失敗後，會呼叫 `Todo.reconcileProgress(...)`，讓 todo progression 不再完全仰賴人工更新
- `packages/opencode/src/session/workflow-runner.ts`
  - planner 現在會用 `Todo.nextActionableTodo(...)` / dependency readiness 決定下一步，不會盲目挑到尚未解鎖的 pending step
- `packages/opencode/src/session/todo.test.ts`
  - 新增 auto-advance / dependency tests：
    - linked step 完成後推進下一個 dependency-ready step
    - task error 時轉為 wait-subagent style state
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增 planner dependency test，驗證 planner 會跳過尚未 ready 的 pending step
- 目前限制：
  - 目前 dependency graph 仍是線性/最小版，尚未支援複雜 fan-in/fan-out planning
  - auto-advance 目前主要由 task result 驅動，尚未涵蓋更多非-task execution result 類型
  - 還沒有完整的 plan revision / dynamic reprioritization engine

### Validation

- Shared sidebar status panel v1 驗證：
  - `bun test --preload packages/app/happydom.ts packages/app/src/pages/session/helpers.test.ts` ✅
  - `bun run --cwd packages/app typecheck && bun run --cwd packages/opencode typecheck` ✅
- Sidebar subagent/task result synthesis 驗證：
  - `bun test --preload packages/app/happydom.ts packages/app/src/pages/session/helpers.test.ts` ✅
  - `bun run --cwd packages/app typecheck && bun run --cwd packages/opencode typecheck` ✅
- Todo-step ↔ task monitor linkage 驗證：
  - `bun test --preload packages/app/happydom.ts packages/app/src/pages/session/helpers.test.ts packages/app/src/pages/session/monitor-helper.test.ts` ✅
  - `bun run --cwd packages/app typecheck && bun run --cwd packages/opencode typecheck` ✅
- Todo dependency + auto-advance foundation 驗證：
  - `bun test packages/opencode/src/session/todo.test.ts packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/index.test.ts packages/opencode/src/session/model-orchestration.test.ts packages/app/src/pages/session/monitor-helper.test.ts` ✅
  - `bun run --cwd packages/opencode typecheck && bun run --cwd packages/app typecheck` ✅
- Architecture Sync: Updated `docs/ARCHITECTURE.md`
  - 本輪再補上 todo dependency + auto-advance foundation，讓文件反映 autonomous session 已開始能依 execution result 自動推進下一步，而不只做可視化。
