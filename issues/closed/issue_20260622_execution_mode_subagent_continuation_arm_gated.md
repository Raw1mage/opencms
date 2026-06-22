# BR: subagent 完成後 orchestrator 不自發續跑 — 續跑路徑被 autonomous arm flag 閘住

Status: ✅ RESOLVED (2026-06-22) — DD-8 implemented, reviewed, regression-tested, cherry-picked to main (`2c4a830c2`), and live-verified after `restart_self` (binary rebuilt 11:51:28).

## RESOLUTION (2026-06-22)

修法 = 計畫 `harness_autonomous-gate-enforcement` DD-8（窄範圍回歸修復，非新增能力）。

**Root cause（最終閉合）**：verbal-autorun 退役（`triggerPhrases: []`）把 `autonomous.enabled` 永久釘成 `false`。`pending-notice-appender` 仍在 subagent 完成時喚醒 parent（與 arm 無關），但喚醒後 `planAutonomousNextAction` early-return `not_armed`（`workflow-runner.ts:610`）→ drain 完一個 notice 就停，殺死原本可用的「subagent 完成 → orchestrator 自發 dispatch 下一步」迴圈。

**Fix（`workflow-runner.ts`，+143/-9，2 檔）**：

- 新增 `subagentTriggered`（由 `RunQueue.peek().triggerType === "task_completion" | "task_failure"` 導出，:802；**未新增 schema 欄位**）
- gate 改 `enabled === false && !subagentTriggered`（:626）：subagent-completion 觸發的續跑 turn 改用 **todolist 殘留**作續跑訊號（有 pending/in_progress + 無 gate → continue；drain 完 → `todo_complete` 乾淨停）
- 一般使用者 prompt 結束的 turn 維持 `not_armed`（窄範圍，使用者鎖定）

**邊界守住（review + 測試確認）**：

- DD-1/DD-2 approval gate（`isAutonomousApprovalGated`，:653）仍在 todolist-continue 分支**之前**先觸發 ✓
- freerun classify（:777 `enabled===true` guard）未動 → DD-7 保留 ✓
- bare one-shot / parentID parent-driven / dormant_scheduled 全不變 ✓

**驗證**：

- 親自 review 源碼 + 獨立重跑測試：workflow-runner 50 pass（含 9 新 DD-8）、session-autonomous 7 pass、todo 17 pass、pending-notice-appender 4 pass
- cherry-pick `2c4a830c2` 進 main（他人 WIP 未動，commit 乾淨 2 檔無 symlink/node_modules 污染）
- `restart_self` 重建 binary（11:51:28，晚於 cherry-pick）→ **live 驗證**：本 session 即活體證據——subagent 完成後，orchestrator 在無任何 verbal trigger 下自發 review + 跨多 turn 推進至 todolist 收斂

**殘留**：無。

---

Status (original): OPEN — root cause confirmed against source; folded into the autorun-retirement plan (`plans/harness_autonomous-gate-enforcement/`, revised 2026-06-22).

Date: 2026-06-22
Scope: opencode orchestrator 續跑機制（`session/workflow-runner.ts` `planAutonomousNextAction` + `prompt.ts` runloop continuation）
Severity: high（破壞多階段 execution；使用者每次需手動催，或仰賴 runtime 注入 nudge）
Reporter: pkcs12（live；docxmcp `pptx_delivery_hardening` Phase A/B 執行中觀察）
Cross-repo origin: 在 docxmcp 任務中觀察，原始 local-first 記於 `~/projects/docxmcp/issues/dx_20260622_orchestrator_no_autocontinue_after_subagent.md`；因根因在 opencode，正式 BR 落於本 repo。

## Summary

在明確進入 execution mode（使用者已說「開始實作」「繼續」）的多階段計畫執行期間，主代理每次 `task()` 委派的 subagent 完成後**不會自發 resume 並 dispatch 下一步**；推進完全依賴 runtime 注入的合成 continuation（`[subagent <id> finished status=success …] Drain pending notices and continue.`）。若無該注入，主代理 turn 結束即停，看起來像「卡住」。

## 已驗證根因（source-grounded，非假設）

續跑判斷的單一入口 `planAutonomousNextAction`（`workflow-runner.ts:590`）在 session **未 arm** 時 early-return：

```
workflow.autonomous.enabled === false  →  { type: "stop", reason: "not_armed" }   (:610-611)
```

arm 的唯一翻轉入口是 `detectAutorunIntent`（`autorun/detector.ts:20`，於 `prompt.ts:1584` 呼叫），需 verbal trigger（`接著跑`/`autorun`/`keep going`）才 flip `enabled=true`。連 `shouldInterruptAutonomousRun`（`workflow-runner.ts:750`）也同樣 arm-gated（`enabled===false` → `return false`）。

主 runloop 在 clean terminal turn 後呼叫 `decideAutonomousContinuation`（`prompt.ts:4351`）→ 走同一條 arm gate。因此：

- 使用者只說「開始實作/繼續」→ 進 execution mode（SYSTEM.md §2.7）但**未 arm autorun**（§9，opt-in verbal trigger）。
- subagent 完成不構成「自動下一 turn」；使用者實際看到的推進來自 `PendingSubagentNotice` resume 注入，**那是與 autonomous continuation 獨立的另一條路徑**。
- 結果：execution mode 與 autorun continuation 脫鉤 —— 使用者以為「開始實作」= 持續自動跑到完，實際只在 runtime 每次注入 continuation 時才動。

## Expected behavior

進入 execution mode（todolist 有 pending/in_progress 殘留、無 stop gate）後，subagent 完成事件 resume 主代理時，主代理應在同一 run 內自動：review 產出 → 同步 tasks/ledger → dispatch 下一步，直到 todolist 收斂或撞 stop gate，無需使用者或 runtime 額外催促。

## 修法方向（已併入 autorun-retirement 計畫）

使用者已拍板讓 verbal-trigger autorun 退役（分階段、Phase 1 中性化 arm、保留 freerun）。在 no-arm 世界裡，續跑不能再依賴 `autonomous.enabled` flag。決議：

- **subagent-completion continuation 改成 arm-independent**（計畫 DD-8）：把 subagent 完成的 resume 從 arm gate 解耦，讓 orchestrator 在 execution 期間依 todolist 殘留 + 無 stop gate 自發 dispatch 下一步。
- 與 BR#1（`harness_autonomous-gate-enforcement`）的 DD-3/DD-4 同一 merge 批次；DD-1/DD-2（runtime-owned arm gate）隨 arm 退役而 shelved。

## Acceptance criteria

1. 一個 execution-mode 多階段 session（未說任何 verbal autorun trigger），subagent 完成後 orchestrator 自發 review + dispatch 下一步，無需 runtime 注入 continuation。
2. todolist 收斂或撞 stop gate 時，orchestrator 乾淨停下交還使用者（不空轉）。
3. freerun-driven session 行為不受影響（freerun 保留）。
4. 回歸：bare/passthrough session 仍嚴格 one-shot（`prompt.ts:4315` 路徑不變）；subagent session（有 parentID）仍由 parent 驅動、不自跑續跑引擎（`workflow-runner.ts:605-606`）。

## Code anchors

- `packages/opencode/src/session/workflow-runner.ts:590,610-611` — `planAutonomousNextAction` arm gate（解耦點）
- `packages/opencode/src/session/workflow-runner.ts:741-752` — `shouldInterruptAutonomousRun` arm gate
- `packages/opencode/src/session/prompt.ts:4351-4365` — runloop terminal-turn continuation 呼叫點
- `packages/opencode/src/session/autorun/detector.ts:20` — `detectAutorunIntent`（arm 翻轉入口）
- `packages/opencode/src/session/prompt.ts:1584,1616-1617` — verbal autorun arm vs freerun arm（同一 flag，退役需區分）

## Related

- 計畫：`plans/harness_autonomous-gate-enforcement/`（state=implementing；2026-06-22 revise 納入 autorun 退役 + arm-independent continuation）
- 同類 BR#1：`issues/20260622_autonomous_approval_gate_and_paralysis_merge_scope_issue.md`（同子系統；arm 退役後只 merge DD-3+DD-4）
- 原始觀察：`~/projects/docxmcp/issues/dx_20260622_orchestrator_no_autocontinue_after_subagent.md`
- 規範：SYSTEM.md §2.3 Dispatch Rules / §2.7 Execution Modes / §9 Autorun
