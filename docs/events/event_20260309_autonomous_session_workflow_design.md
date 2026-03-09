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
- Architecture Sync: Updated `docs/ARCHITECTURE.md`
  - 本輪再補上 arbitration trace persistence/display，說明 orchestration 不只是選模型，也會把「為何選這個模型」以最小可觀測形式回饋到 web session surface。
