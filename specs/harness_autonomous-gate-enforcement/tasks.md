# Tasks: harness_autonomous-gate-enforcement

> **2026-06-22 STATE RECONCILIATION** — 偵查發現 plan 的環境假設過時。
> `feat/autonomous-arming-retirement`（曾 merge beta→test→feat）**已整支 merge 回 main**：
> git merge-base 證實 `f7741cb2e`(DD-3) / `86b0c58de`(DD-1/2) / `a96b203ad`(DD-4) 都是 main ancestor。
> beta/test/feat 分支皆已刪除（commit 變 dangling 但內容已在 main）。
> DD-6（arm 中性化）也已落地：`tweaks.ts:470 triggerPhrases: []`（verbal 無法 arm）。
> **唯一真正未做 = DD-8（arm-independent 續跑，新 BR 核心）。**
> MERGE GATE **已不適用**（無待 cherry-pick；全在 main 了）。
> 注意：DD-1/DD-2 並非 SHELVED——它們已 live 在 main，DD-8 不得破壞其 approval-gate 路徑。

## 已落地 main（驗證：git merge-base + source grep）

- [x] DD-3: `todo.ts inferActionFromContent` 移除 architecture_change keyword 假門（grep 確認 0 個 architecture/refactor/schema/migration includes）
- [x] DD-1: `isAutonomousApprovalGated` + `requireApprovalFor` runtime-owned gate（workflow-runner.ts，7 處）
- [x] DD-2: `awaiting_approval` model handback key（workflow-runner.ts 6 + todo.ts 2）
- [x] DD-4: paralysis 對 gate 讓路 `isGateSuspended`（prompt.ts:2855-2869）
- [x] DD-6 (Phase 1): verbal autorun arm 中性化 — `tweaks.ts:470 triggerPhrases: []`；detector flip 邏輯仍在但空清單下永不命中
- [x] DD-7 邊界: freerun arm（prompt.ts:1616-1617）保留未動

## Phase 8 — DD-8: 修復 DD-6 退役 arm 造成的 subagent 續跑回歸（唯一未做，新 BR 核心）

> **因果校正（user-confirmed 2026-06-22）**：subagent 續跑機制**原本就很順** —— 它**不是**一個獨立的舊缺陷。
> 是 DD-6 把 `triggerPhrases:[]` 中性化 arm 後，`autonomous.enabled` 永遠 false，使
> `shouldInterruptAutonomousRun`(:750) 與 `planAutonomousNextAction`(:610) 的 `enabled===false→擋`
> 硬閘**永遠生效**，把本來順暢的 subagent 完成續跑一起弄死。
> 所以 DD-8 是 **DD-6 的回歸修復**，不是新增能力：把續跑從 arm flag 救回來。

訊號決策（user-locked 2026-06-22）：用 **todolist 殘留**作續跑訊號，不再看 `autonomous.enabled` flag。
這正是「讓原本順的機制在 arm 退役後繼續順」——訊號從 arm flag 換成 execution-mode 的天然訊號（有 actionable todo + 無 stop gate）。

> **DD-9 SCOPE LOCK（evidence-closed + user-narrowed 2026-06-22）**：窄範圍 = **只修 subagent 完成觸發的續跑 turn**。
> root cause 鏈：appender auto-resume（pending-notice-appender.ts:177-189）本來就會在 subagent 完成時起 parent turn（不看 arm），
> 但那 turn drain 完 notice 後「要不要續下一步」由 `planAutonomousNextAction` 決定，`enabled===false→not_armed→stop`（wf-runner.ts:610-611）。
> DD-6 把 arm 釘死 false → appender 仍踢一下、drain 完就停 = BR 症狀。
> 類比：Claude 官版的「自動接」是 Task tool 同步 tool_result 回注、同一迴圈自然續；opencode 非同步架構用 todolist 殘留還原「還有事就續」語義。
> 一般使用者 prompt 結束的 turn **不在 Phase 1 範圍**、維持現狀。

- [x] 8.1 在「由 subagent 完成觸發的續跑 turn」上（triggerType=task_completion/task_failure，或 lastDecisionReason 指示 appender-driven resume），`planAutonomousNextAction`(wf-runner.ts:610-611) 不再 early-return `not_armed`；改評估 todolist 殘留：有 pending/in_progress + 無 gate → continue；否則 stop(todo_complete)
- [x] 8.2 一般使用者 prompt 結束的 turn（非 subagent 觸發）維持現狀 `not_armed`（Phase 1 不擴大）
- [x] 8.3 守住 DD-1/2 approval gate: `isAutonomousApprovalGated` 必須在 todolist-continue 分支**之前**仍先觸發（approval_required 不得被續跑邏輯跳過）
- [x] 8.4 守住 freerun(DD-7): `decideAutonomousContinuation` freerun classify(:761 `enabled===true` guard) 不被 todolist 訊號干擾
- [x] 8.5 守住既有 early-return: parentID(:605) subagent parent-driven / dormant_scheduled(:599) / bare one-shot(prompt.ts:4315) 全不變
- [x] 8.6 測試: subagent 完成觸發的續跑 turn → 有殘留則自發 dispatch、收斂則乾淨 stop；非 subagent turn 維持 not_armed；bare/subagent/freerun/approval-gate 全回歸綠
- [x] 8.7 `restart_self` 啟用 → live 驗證：(a) subagent 完成自發續跑到 todolist 收斂 (b) 收斂乾淨停 (c) freerun 不受影響 (d) approval gate 仍暫停 (e) 一般 prompt turn 不自驅
- [x] 8.8 關 BR `issue_20260622_execution_mode_subagent_continuation_arm_gated`（移 closed/）

## Phase 9 — spec sync + 收尾

- [x] 9.1 `spec_amend` `harness/autonomous-opt-in`: 記錄 verbal autorun 已退役、approval gate(DD-1/2) live、續跑改 todolist-driven
- [x] 9.2 `specs/architecture.md` 同步 autonomous/autorun/continuation 契約（或註記 Verified No doc changes）
- [x] 9.3 `event_record` 收尾：DD-8 落地 + 環境校正紀錄
- [x] 9.4 BR#1 既有 issue（20260622_autonomous_approval_gate...）回填：merge 範圍 open question 已由「全已在 main」事實解答，可關
- [~] 9.5 advance verified →（user-gated）graduate — graduate 為 user-only gate（plan_graduate），非本次 verified 推進範圍；deferred 待使用者明確指示

## Stop gates

- Phase 8.1/8.2/8.5 觸及續跑核心控制流，打擊半徑大 → 委派 coding subagent 隔離實作 + 完整回歸測試。
- 8.8 `restart_self` 為 sanctioned lifecycle op，只走 `system-manager_restart_self`。
- 9.5 graduate 為 user-only gate。
