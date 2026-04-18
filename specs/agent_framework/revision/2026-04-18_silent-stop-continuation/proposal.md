# Proposal: silent-stop-continuation

## Why

- autonomous runloop 觸發的 `AUTONOMOUS_COMPLETION_VERIFY_TEXT`（[workflow-runner.ts:43-45](packages/opencode/src/session/workflow-runner.ts#L43-L45)）本來的設計：「若沒有剩餘工作 → 不要叫 TodoWrite → runner 收到 empty diff 自動退出」。silence = 退出訊號。
- **實際行為**：2026-04-18 使用者觀察到 runloop 結束時 AI 在 UI 吐了一句「已確認本輪沒有剩餘可執行工作；目前只剩需另開新 plan 的未來延伸線。」AI 確實沒叫 TodoWrite（正確），但仍產出 user-facing wrap-up 敘述（多餘）。
- 根因：prompt 只禁止了 TodoWrite call，沒禁止 text output。AI 的「收到問題必回答」習慣讓它把 runloop probe 當成一般對話，補一句總結。
- 使用者的明確裁決：「如無繼續loop需求，靜默停止即可。」即 silence ≡ stop signal，不准任何 user-facing 文字。
- 脈絡一致：同 `feedback_orchestrator_verbosity.md`（內部推理不應外洩）與 `feedback_silent_stop_continuation.md`（本次新增記憶）。

## Original Requirement Wording (Baseline)

- 「在runloop結束後，出現這段話，我覺得不太適當。請問這是AI產生的還是runloop code產生的」（2026-04-18）
- 「Autonomouns runner continuation是我們外加的觸發器，用一個問句來觸發AI思考下一回合工作，但沒有要求他回覆。」
- 「如無繼續loop需求，靜默停止即可。」
- 「這是屬於agent framework」

## Requirement Revision History

- 2026-04-18: initial draft — silent-stop discipline on autonomous continuation

## Effective Requirement Description

1. `AUTONOMOUS_COMPLETION_VERIFY_TEXT` 必須顯式要求「無工作時 emit NOTHING」— 包含禁止 TodoWrite call、禁止任何 narration / summary / wrap-up 句。
2. 以 code comment 記錄 silent-stop 的設計意圖，讓未來維護者不會再放寬 prompt。
3. 本條規範**只適用於 autonomous continuation 觸發情境**；一般使用者對話仍保留正常回覆行為。
4. 與 `AUTONOMOUS_CONTINUE_TEXT` / `AUTONOMOUS_PROGRESS_TEXT` 不衝突 — 那兩個 prompt 是「有事繼續做」，不是 completion probe。

## Scope

### IN
- `packages/opencode/src/session/workflow-runner.ts` `AUTONOMOUS_COMPLETION_VERIFY_TEXT` 字串
- 對應的 code comment 區塊
- `feedback_silent_stop_continuation.md` memory（已寫）

### OUT
- `AUTONOMOUS_CONTINUE_TEXT` / `AUTONOMOUS_PROGRESS_TEXT`（不需改）
- `smart-runner-governor.txt` / `runner.txt` / `plan.txt`（本輪不動，若後續發現也洩漏 wrap-up 再另開）
- cron trigger / heartbeat trigger prompt（本輪不動）
- TUI 層 error/completion 渲染（另屬 RCA H4 範疇）

## Non-Goals

- 不重新設計 runloop 架構
- 不改 completion-verify 的行為語意（「empty diff = exit」不變）
- 不限制一般對話中的 wrap-up（只限 autonomous trigger）

## Constraints

- AGENTS.md 第一條：silence 是 signal，不是 silent fallback — 這是 runloop ↔ LLM 協定層面的顯式約定
- 記憶 `feedback_orchestrator_verbosity.md` 同脈絡
- 變更必須在 beta worktree 執行，fetch-back 後才到 main

## What Changes

1. `AUTONOMOUS_COMPLETION_VERIFY_TEXT` 字串改寫：
   - Before: `Call TodoWrite with any remaining work you can identify. If there is genuinely nothing left, do NOT call TodoWrite — the runner treats an empty diff as confirmation and will exit.`
   - After: `Call TodoWrite with any remaining work you can identify. If there is genuinely nothing left, emit NOTHING — do NOT call TodoWrite, do NOT write any narration, summary, or wrap-up sentence. Silence is the confirmation signal the runner waits for; any user-facing text here is treated as unwanted output.`
2. 補 comment 說明 silent-stop 設計意圖、列出禁止的中英文示例。

## Capabilities

### Modified Capabilities
- `AUTONOMOUS_COMPLETION_VERIFY_TEXT` 從「只禁 TodoWrite」擴展為「禁 TodoWrite + 禁任何 text output」

## Impact

- **Code**：單一檔案、2-line prompt 改動 + comment。
- **Behavior**：runloop 結束時不會再冒出 wrap-up 敘述。
- **Risk**：極低。prompt 更 strict，邊界仍是「有工作 → 叫 TodoWrite」「無工作 → 靜默」。
- **Dependencies**：隨同 `beta/codex-cleanup-rotation-rca` 分支一起 fetch-back。
