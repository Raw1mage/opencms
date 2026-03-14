# Event: planner question RCA

Date: 2026-03-14
Status: Completed
Branch: cms
Workspace: /home/pkcs12/projects/opencode

## 需求

- 說明為何 planner 在提問時沒有穩定遵循「使用 MCP `question` 產生選擇題」的要求。
- 回到 cms branch 原始碼修正 planner 契約，讓規劃提問預設優先走 `question` 的 choice-based flow。
- 補回歸測試與事件紀錄。
- 收斂 planner prompt 成單一事實來源，避免 `plan.txt` / `reminders.ts` 雙軌漂移。
- 移除 legacy `build-switch.txt` prompt asset 在 runtime 中的實際依賴，避免非權威 phase 提示殘留。
- 將 planner 的 question 規則從 prompt discipline 升級為 runtime hard enforcement（B + C）。
- 移除 plan/build 間的 system-reminder 控制訊號；planner 若要交接 build，只能透過正式文件與 `plan_exit` handoff metadata。

## 範圍 (IN / OUT)

### IN

- planner prompt / reminder contract
- planner prompt 單一事實來源收斂
- build-switch legacy prompt asset 移除
- plan mode output validator / allowed-ending hard contract
- planner regression test
- 本次 RCA / validation event 記錄

### OUT

- planner artifact 結構變更
- autorunner / daemon 架構修改
- 新增 fallback 機制

## 任務清單

- [x] 讀取 planner question contract / revival / methodology 與現行 runtime 實作
- [x] 確認 planner 未穩定使用 `question` choice flow 的根因
- [x] 強化 planner reminder，將 `question` choice-based 使用升級為明確 hard contract
- [x] 新增 regression test，驗證 plan-mode reminder 已包含 choice-based `question` 指示
- [x] 完成 validation 與 architecture sync 記錄
- [x] 移除 planner prompt 雙軌，runtime 永遠以 `session/prompt/plan.txt` 為唯一 prompt source
- [x] 拔除 `build-switch.txt` 的 runtime 注入依賴與 prompt seeding 暴露
- [x] 新增 plan mode output validator，違規 plain-text 決策題不再直接交付使用者
- [x] 移除 plan→build synthetic handoff prompt 與 plan-mode synthetic retry reminder

## Debug Checkpoints

### Baseline

- planner 相關 spec 已多次明寫：規劃流程應優先用 MCP `question` 來處理 decision-shaping clarification。
- `packages/opencode/src/tool/plan.ts` 的 `plan_enter/plan_exit` 本身已透過 `Question.ask(...)` 使用正式 question flow。
- 但實際在線生效的 planner prompt 來自 `packages/opencode/src/session/prompt/plan.txt`，其內容只寫了泛稱的「Ask the user clarifying questions」，沒有把「bounded decision 時必須優先用 choice-based MCP question」寫成夠硬的契約。
- 同時 `packages/opencode/src/session/reminders.ts` 仍保留另一份 experimental plan prompt，形成雙軌 prompt source，違反 SSOT。

### Instrumentation Plan

- 先讀 `docs/specs/planning_agent_question_contract.md`、`planning_agent_revival.md`、`planner_spec_methodology.md`，確認 SSOT 要求。
- 再讀 `packages/opencode/src/session/reminders.ts`、`packages/opencode/src/session/prompt/plan.txt` 與 planner tests，定位 planner 實際被注入的指示。
- 以 targeted test 驗證新的 reminder 文字已明確要求優先使用 choice-based MCP `question`。

### Execution

- 比對 spec 與 runtime 後確認：planner spec/文件層要求比實際生效的 planner prompt 更強，但 `session/prompt/plan.txt` 沒把 choice-based `question` 變成 hard rule。
- 初次修補誤判了生效路徑，先改到 `packages/opencode/src/session/reminders.ts`；跑測後從實際注入內容回推，才確認真正在線生效的是 `packages/opencode/src/session/prompt/plan.txt`。
- 最終在 `packages/opencode/src/session/prompt/plan.txt` 補入明確規則：
  - 2–5 個清楚選項時預設用 MCP `question`
  - scope/priority/approval/validation/delegation 等 decision fork 優先用 choice-based prompt
  - 只有 truly open-ended context 才允許 freeform 問句
  - 不可在 choice-based `question` 可行時退回 plain conversational clarification
- 接著在 `packages/opencode/src/session/reminders.ts` 移除 plan-mode dual-source routing：
  - 進入 plan mode 時不再依賴 `OPENCODE_EXPERIMENTAL_PLAN_MODE` 分流不同 prompt 文案
  - runtime 無論 flag 狀態都只注入 `PROMPT_PLAN` (`session/prompt/plan.txt`)
  - build-switch 行為保留既有邏輯
- 補 planner regression test，直接驗證實際注入的 plan-mode prompt 是否包含新的 choice-based `question` 契約語句。
- 再補一個 regression test，驗證即使 `OPENCODE_EXPERIMENTAL_PLAN_MODE=1`，runtime 仍然只走 `plan.txt` 單一 prompt source。
- 最後移除 `packages/opencode/src/session/reminders.ts` 對 `BUILD_SWITCH` prompt asset 的依賴，plan→build handoff 只保留最小結構化文字：
- 最後進一步移除 `packages/opencode/src/session/reminders.ts` 內 plan→build synthetic handoff 文字，避免用 prompt text 傳遞 phase/control 訊號。
- 同步移除 `packages/opencode/src/session/system.ts` 對 `session/build-switch.txt` 的 prompt seeding 暴露，避免 XDG / template registry 繼續把它當成有效 runtime asset。
- 新增 `SessionPrompt.classifyPlanModeAssistantTurn(...)` 作為 runtime classifier：
  - `question` tool call → allowed
  - `plan_exit` tool call → allowed
  - 非提問 progress summary → allowed
  - plain-text decision question / plain-text question → violation
- 在 `packages/opencode/src/session/prompt.ts` 的 `result === "stop"` 路徑接上 hard enforcement：
  - 若 `agent === "plan"` 且本回合違規
  - 不直接把 assistant 回覆交給使用者
  - 直接標記為 enforcement error 並 fail-fast stop
  - 不再透過 synthetic retry reminder 用 prompt 糾正模型

### Root Cause

- 根因不是 `Question.ask` 能力缺失，也不是 planner tool registry 沒有 question。
- 真正根因是 **contract drift between spec and runtime prompt**：
  1. 規格文件已要求 planner 使用 MCP `question` 做 decision-shaping clarification
  2. 但 runtime 真正注入給 planner agent 的 `session/prompt/plan.txt` 僅寫成寬鬆的「Ask the user clarifying questions」
  3. 這讓模型仍可能把 requirement 理解成「可以用一般對話問」而不是「應優先產生選擇題 question flow」
  4. 測試也只覆蓋 planner route / artifact / gating，沒有覆蓋 prompt contract wording
- 5. `reminders.ts` 與 `plan.txt` 之間存在雙軌 prompt source，讓維護者容易改錯位置，且不同 flag 下行為不一致
- 6. `build-switch.txt` 屬於 AutoRunner_Planner Phase 的過渡提示資產；在 `plan_exit`/handoff metadata 已成為正式 phase bridge 後，該 prompt 已不再是權威狀態來源，繼續保留只會製造誤導
- 7. 更深層問題是 planner 問題契約主要仍靠 LLM 遵循 prompt；即使 prompt 修好，若沒有 runtime validator，模型仍可能在某些回合滑回 plain-text 問題
- 8. 更深層的控制問題是：若把 phase/handoff/retry 訊號做成 `<system-reminder>` text，最終仍要靠 LLM 理解那段文字；這不屬於可靠控制面
- 因此行為會反覆漂移，表面看像「常常不遵循」，本質是 prompt contract 不夠硬、prompt source 分散、legacy phase prompt 未完全退場、且缺少對互動層契約的 runtime enforcement 與 regression coverage。

### Validation

- Targeted test:
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts"`
- Additional regression:
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/session/planner-reactivation.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/test/tool/registry.test.ts"`
- 結果：21 pass / 0 fail ✅
- 驗證重點：
  - plan mode reminder 包含 choice-based `question` 指示
  - plan_enter / plan_exit 既有 planner regression 不回歸
  - `OPENCODE_EXPERIMENTAL_PLAN_MODE=1` 時仍走 `plan.txt` 單一 prompt source
  - plan mode classifier 能區分 question tool / plan_exit / progress summary / plain-text question violation
  - 移除 plan/build synthetic system-reminder 後，planner regression 仍全綠

## Architecture Sync

- Architecture Sync: Updated
- `docs/ARCHITECTURE.md`
  - 新增 `Planner / build handoff contract (authoritative)`
  - 新增 `Synthetic reminder boundary`
- 同步內容：
  - planner/build phase control 不得再依賴 system-reminder prompt text
  - planner → build 交接只能透過正式文件與 `plan_exit` handoff metadata
  - plan-mode hard enforcement 屬 runtime contract，不屬 prompt 自律
