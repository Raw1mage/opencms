# Orchestrator: 主代理在 subagent 完成後不自發接續工作，需靠系統注入 continuation 訊息才推進

- **日期**：2026-06-22
- **Status**：✅ RESOLVED — DUPLICATE（DD-8 已解決；本檔與正式件 `closed/issue_20260622_execution_mode_subagent_continuation_arm_gated.md` 同源）
- **嚴重度**：high（破壞 autonomous 多階段執行；使用者必須每次手動催，或仰賴 runtime 注入 nudge）

## RESOLUTION (2026-06-22) — DUPLICATE of DD-8

本 BR 與已 closed 的正式件 `issues/closed/issue_20260622_execution_mode_subagent_continuation_arm_gated.md` 描述**同一個 bug**（subagent 完成後 orchestrator 不自發續跑，續跑路徑被 `autonomous.enabled` arm flag 閘住）。後者帶完整 RCA + Resolution，本檔為較早的偵查草稿。

**修法**：計畫 `harness/autonomous-gate-enforcement` DD-8，commit `2c4a830c2`（在 main）。源碼複查（`workflow-runner.ts`）：

- `planAutonomousNextAction` gate 從 `enabled === false` 改為 `enabled === false && !subagentTriggered`（:626）
- `subagentTriggered` 由 `RunQueue.peek().triggerType === "task_completion" | "task_failure"` 導出（:801-802），caller `decideAutonomousContinuation` 已接線（`subagentTriggered` 傳入 :810）
- subagent-completion 觸發的續跑改用 **todolist 殘留**當訊號（pending/in_progress + 無 stop gate → continue；drain 完 → `todo_complete` 乾淨停）
- DD-1/DD-2 approval gate（`isAutonomousApprovalGated`，:653）仍在 todolist-continue 分支之前先觸發 ✓

驗證：DD-8 已 live 驗證（見正式件 §RESOLUTION）。本檔標 resolved-duplicate，移入 `issues/closed/`。

**殘留**：無（subagent path）。「無 subagent 的純本地工具序列」缺口是正交問題，見姊妹 BR `issue_20260622_orchestrator_no_autocontinue_single_thread_local_tools.md`（DD-8 不涵蓋，維持 open）。

---

- **元件**：opencode orchestrator 續跑機制（`packages/opencode/src/session/workflow-runner.ts` `planAutonomousNextAction` / PendingSubagentNotice resume path）
- **回報者**：pkcs12（live；於 docxmcp `pptx_delivery_hardening` Phase A/B 多階段執行中觀察到）

## 摘要

在一個明確進入 execution mode 的多階段計畫（使用者已說「開始實作」「繼續」）執行期間，主代理每次 `task()` 委派的 subagent 完成後，**不會自發 resume 並 dispatch 下一步**；實際推進完全依賴 runtime 注入的合成訊息「`Subagent <id> finished … Drain pending notices and continue.`」。若無該注入，主代理 turn 結束即停，看起來像「卡住」。

## 實際症狀（可複現）

多階段計畫 Phase A→B 期間，每個 coding subagent（bug fix / narrow-text lint / fingerprint）完成後：

1. 主代理 turn 已結束、控制權交回。
2. 必須出現一條 `[subagent ses_… finished status=success]` + 「Drain pending notices and continue」注入訊息，主代理才接著勾 tasks、記 event、派下一個 subagent。
3. 使用者觀察：「subagent 結束後 main agent 不接續工作了」。

## 期望行為

進入 execution mode（todolist 有 pending/in_progress 殘留、無 stop gate）後，subagent 完成事件 resume 主代理時，主代理應**在同一 autonomous run 內**自動：review 產出 → 同步 tasks/ledger → dispatch 下一步，直到 todolist 收斂或撞 stop gate，無需使用者或 runtime 額外催促。

## 根因假設（待確認，未讀源碼前不定性）

- SYSTEM.md §9：autorun 是 **opt-in**，需 verbal trigger（`接著跑`/`autorun`/`keep going`）才 arm。觀察到的 session 使用者只說「開始實作」「繼續」——可能觸發 execution mode（§2.7）但**未 arm autorun continuation**。
- SYSTEM.md §2.3：續跑引擎只認 todolist 殘留；但若 autorun 未 arm，主代理 turn 邊界仍是 conversational stop，subagent 完成不構成「自動下一 turn」。
- 結果：execution mode 與 autorun continuation 兩個概念脫鉤——使用者以為「開始實作」=持續自動跑到完，實際只在 runtime 每次注入 continuation 時才動。

## 候選修法（方向，待確認）

1. execution mode（user 明確下令 execute/開始實作）應隱含 arm subagent-completion continuation，不需另外 verbal autorun trigger。
2. 或：PendingSubagentNotice resume 時，若 todolist 仍有殘留且無 stop gate，runtime 應持續 drive 而非交回使用者。
3. 釐清「execution mode」vs「autorun」語義邊界並在 SYSTEM.md 對齊；避免使用者對「開始實作」的續跑預期落空。

## 關聯

- 觀察來源：docxmcp `plans/pptx_delivery_hardening/`（多階段委派執行）
- SYSTEM.md §2.3 Dispatch Rules / §2.7 Execution Modes / §9 Autorun
