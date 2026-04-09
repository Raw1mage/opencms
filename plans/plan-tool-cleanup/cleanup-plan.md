# 清理計畫：移除 plan_enter / plan_exit 硬編碼 tool

## 背景

plan_enter 和 plan_exit 轉為 skill + 腳本模式（planner skill + scripts/plan-init.ts + scripts/plan-validate.ts）。
硬編碼 tool 及其 mode-switching 基礎設施需要全部清除。

## 影響範圍（15 個檔案）

### Layer 1：Tool 定義層（先砍）

| # | 檔案 | 改動 |
|---|------|------|
| 1 | `src/tool/plan.ts` | 刪除 `PlanExitTool`、`PlanEnterTool` 兩個 export。刪除它們引用的 `plan-exit.txt`、`plan-enter.txt` import。保留純 utility 函數（`resolvePlannerArtifacts`、`buildSuggestedBetaBranchName`、`resolvePlanExitBetaMission`、`shouldCollectBetaMissionFields`、`collectMissingBetaMissionFields`、`materializePlanTodos` 等）——它們被 test 和 beta workflow 使用。 |
| 2 | `src/tool/registry.ts:29,156` | 移除 `import { PlanExitTool, PlanEnterTool }` 和條件註冊行。 |
| 3 | `src/tool/plan-exit.txt` | 刪除檔案（tool description，不再需要）。 |
| 4 | `src/tool/plan-enter.txt` | 刪除檔案。 |

### Layer 2：Tool 調用/攔截層（接著砍）

| # | 檔案 | 行號 | 改動 |
|---|------|------|------|
| 5 | `src/session/tool-invoker.ts:27-36,91` | 刪除 `assertPlannerIntentConsistency()` 函數及其在 invoke 中的呼叫。移除 `PlannerIntent` import。 |
| 6 | `src/agent/agent.ts:59-60,97,113,231-232` | 從 tool permission 映射中移除 `plan_enter` 和 `plan_exit` 條目。 |
| 7 | `src/cli/cmd/run.ts:459,464` | 從 CLI permission 映射中移除 `plan_enter` 和 `plan_exit` 條目。 |

### Layer 3：Prompt / Dialog 層（然後砍）

| # | 檔案 | 行號 | 改動 |
|---|------|------|------|
| 8 | `src/session/prompt.ts:75` | 移除 `PlannerIntent` import from dialog-trigger。 |
| 9 | `src/session/prompt.ts:140-148` | 移除 `hasPlanExitTool` 判斷及其在 turn-ending enforcement 中的分支。 |
| 10 | `src/session/prompt.ts:1573` | 從 bounded-question enforcement 訊息中移除 "plan_exit" 字樣。 |
| 11 | `src/session/prompt.ts:1793-1816` | 刪除 auto-invoke plan_exit handoff 邏輯（`getCommittedPlannerIntent` → dynamic import PlanExitTool → ToolInvoker.execute）。 |
| 12 | `src/session/prompt.ts:1862-1875` | 刪除 `getCommittedPlannerIntent()` 函數。 |
| 13 | `src/session/dialog-trigger.ts:5,19,24-25,43,205,221,257,274` | 移除 `PlannerIntent` type、plan_exit hard-negative patterns、plan_exit committed intent 分支。保留 `plan_enter` 作為 `DialogTriggerName`（dialog trigger 的 "suggest planning" 功能仍然有意義，改指向 planner skill 而非 plan_enter tool）。 |

### Layer 4：Session 狀態層（最後砍）

| # | 檔案 | 行號 | 改動 |
|---|------|------|------|
| 14 | `src/session/index.ts:275` | 從 session schema 移除 `committedIntent` 欄位。 |
| 15 | `src/session/index.ts:733` | 刪除 `setPlannerIntent()` 函數。 |

### Layer 5：Prompt 文字 + UI + Test

| # | 檔案 | 改動 |
|---|------|------|
| 16 | `src/session/prompt/claude.txt:86-87` | 移除提到 "call plan_enter" 和 "call plan_exit" 的指示，改為 "use the planner skill" 或 "/planner"。 |
| 17 | `src/session/prompt/plan.txt:19,23,29` | 全面改寫——移除 tool 引用，改為描述 skill + 腳本工作流。 |
| 18 | `src/session/user-message-parts.ts:373` | 移除 "call the plan_enter tool" 指示，改為 "use the planner skill"。 |
| 19 | `src/command/index.ts:118` | 移除 "call plan_enter()" 指示，改為 "use the planner skill"。 |
| 20 | `src/cli/cmd/tui/routes/session/index.tsx:269-272` | 移除 plan_exit/plan_enter 的 TUI 特殊渲染邏輯。 |
| 21 | `src/session/command-prompt-prep.test.ts:13` | 更新或移除 expect plan_enter() 的 test assertion。 |
| 22 | `src/tool/plan.test.ts` | 保留（測試 beta mission utility 函數，不涉及 tool definition）。 |

## 執行順序

1. **Layer 1** — 砍 tool 定義 + registry（斷根）
2. **Layer 2** — 砍攔截/permission（消除 dead import）
3. **Layer 3** — 砍 prompt/dialog 層（消除 mode-switching 邏輯）
4. **Layer 4** — 砍 session 狀態（移除 schema + API）
5. **Layer 5** — 改 prompt 文字 + UI + test（語意更新）

每一層完成後執行 `bun build` 確認無編譯錯誤。

## 不動的東西

- `plan.ts` 中的純 utility 函數（`resolvePlannerArtifacts`、beta mission helpers、`materializePlanTodos`）——被 beta-workflow 和 test 使用
- `planner-layout.ts` — 完全不涉及 tool，純路徑計算
- `dialog-trigger.ts` 中的 `DialogTriggerName` "plan_enter" 值——改指向 planner skill
- `plan.test.ts` — 測試 utility 函數，不涉及 tool

## 風險

- `prompt.ts` 的 turn-ending enforcement 移除 plan_exit 分支後，需確認 plan mode 的 turn ending 不會被過度嚴格的 enforcement 阻擋（因為 plan mode 現在完全靠 skill prompt 驅動，不再有特殊 tool-based 例外）
- `session/index.ts` 移除 `committedIntent` 後，舊 session 資料中可能有此欄位——zod schema 用 `.optional()` 不會 break，但如果有其他地方讀取需注意
