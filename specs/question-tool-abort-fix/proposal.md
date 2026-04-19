# Proposal: question-tool-abort-fix

## Why

使用者回報 webapp 上 AskUserQuestion (內部 `question` tool) 連續多題「認真答題後 abort」的故障模式：

1. AI 呼叫 question tool → QuestionDock 顯示
2. 使用者開始答題（選項 or 自訂輸入）
3. 畫面出現紅框 "Tool execution aborted"
4. AI 隨後再問**同一題**
5. 重覆 3–5 同一 session 可連發多次

既存證據：

- [question/index.ts:110-134](../../packages/opencode/src/question/index.ts#L110-L134) `Question.ask()` 沒有掛 AbortSignal。stream abort 時 pending question 卡在記憶體、tool part 被 [processor.ts:1769-1785](../../packages/opencode/src/session/processor.ts#L1769-L1785) 覆蓋成 error。
- 使用者按 Submit 時 `Question.reply` 仍能 resolve 舊 promise，但 AI SDK stream 已 tear down，tool result 回不去 LLM → LLM 重跑看到 aborted tool part → 重新問同一題。
- [question-dock.tsx:10-51](../../packages/app/src/components/question-dock.tsx#L10-L51) QuestionDock cache key 用 `request.id`，AI 重問時 id 變更 → cache orphan、輸入無法自動回填。
- `prompt-runtime.cancel()` 目前沒有 caller context / reason label，無法從 log 直接判斷是哪個路徑 abort（rate-limit fallback rotation / manual stop / monitor watchdog）。

## Original Requirement Wording (Baseline)

- 「我在認真答題後出現 abort。然後 AI 就再問我一次同樣的題目。已經連續發生好幾題了」
- 「Question tool call 頻繁的被中斷，害我輸入內容遺失」

## Requirement Revision History

- 2026-04-18: initial draft created via plan-init.ts
- 2026-04-18: scope lockdown (A+B+C) confirmed by user in conversation
- 2026-04-19: proposal + state 因 branch 切換遺失，在 test/session-poll-cache 上重建

## Effective Requirement Description

1. **(A) AbortSignal wiring**：`Question.ask()` 必須接受 stream 的 AbortSignal。當 signal 觸發時 pending promise 立即 reject、自動 publish `question.rejected`，並把對應 `pending[id]` 清掉。RejectedError 沿用現有類別以共用既有 `blocked = shouldBreak` 邏輯。
2. **(B) Cache key 穩定化**：QuestionDock cache key 改用「sessionID + 問題內容 stable hash」。同 session 同內容的問題（AI 重問）能從 cache 自動回填 `tab / answers / custom`，避免使用者重打。
3. **(C) Abort-cause telemetry**：`prompt-runtime.cancel()` 的 caller 必須帶入 `reason` 字串（enum）；AbortController 使用 `controller.abort(reason)` 傳遞；cleanup/log 紀錄 reason；log 顯示 top-level caller（stack trace 首格）以利追蹤。目的是下次發生同類故障時 log 直接告訴我們 trigger 是誰。

## Scope

### IN

- `packages/opencode/src/question/index.ts`：`ask()` 新增 `abort?: AbortSignal` 參數；`pending[id]` 結構增加 `dispose` 函式；abort handler auto-reject + publish `question.rejected` + delete pending entry。
- `packages/opencode/src/tool/question.ts`：把 `ctx.abort` 傳給 `Question.ask`。
- `packages/opencode/src/session/prompt-runtime.ts`：`cancel(sessionID, reason)` 新增 reason 參數；`controller.abort(reason)` 改成帶 reason；log.info 加 reason + caller stack top。
- 所有呼叫 `SessionPrompt.cancel` / `prompt-runtime.cancel` 的點（session routes、monitor、workflow-runner…）都補 reason 字串。
- `packages/app/src/components/question-dock.tsx`：cache key 改 `${sessionID}:${hash(questions)}`；hash 用 stable JSON + 簡單 FNV 或 SubtleCrypto。
- `specs/architecture.md`：補一段「Question tool abort lifecycle」 SSOT。

### OUT

- **不改** rate-limit fallback rotation 的觸發邏輯本身（[processor.ts:1639-1718](../../packages/opencode/src/session/processor.ts#L1639-L1718)）——C 的 telemetry 讓我們先觀察，再決定要不要加 pending-question 保護條件（留給後續 `extend` mode）。
- **不動** permission 系統。
- **不動** TUI 版 question.tsx（cache 機制本來就沒有）——留後續補 feature parity 再處理。
- **不引入** localStorage 持久化（跨 tab reload）——目前痛點是同 session 內連發，先修這段。

### Non-Goals

- 解決 subagent / rotation 在 question pending 時應不應該觸發（屬於另一議題）
- 改造 permission 對等的 abort 流程（同類 bug 但獨立修）
- webapp 以外的 UI（TUI、ACP）

## Constraints

- 維持 `Question.RejectedError` 既有型別——processor [line 961](../../packages/opencode/src/session/processor.ts#L961) 的 instanceof 判斷依賴它來 set `blocked = shouldBreak`。
- Bus event schema 不可 breaking change（`question.rejected` 既有 consumer 在 TUI、webapp、ACP）。
- AGENTS.md 第一條：不可靜默 fallback——abort path 必須 log.warn 明確紀錄。
- AGENTS.md 第零條：本 spec = 該 plan，先確認再動手。
- reason string 建議走 enum（`"manual-stop" | "rate-limit-fallback" | "monitor-watchdog" | "instance-dispose" | "replace" | ...`）避免 free-form 失控。

## What Changes

Runtime 行為變化：

- stream abort 發生時，pending question 會立刻從 UI 消失（因為 `question.rejected` 自動 publish），不會再讓使用者誤以為要繼續打字。
- 使用者答案打到一半 abort → dialog 消失 → AI 重問時，新 dialog 會自動帶回使用者先前打的字。
- log 新增可搜尋的 abort-cause 欄位，下次可直接 `grep reason=rate-limit-fallback` 驗證假設。

## Capabilities

### New Capabilities

- **`Question.ask(input, abort?)` 接受 AbortSignal**：生命週期明確綁定 stream。
- **`prompt-runtime` 帶 reason telemetry**：cancel / abort 的 caller 可追溯。
- **QuestionDock content-hashed cache**：AI 重問不清空輸入。

### Modified Capabilities

- **Question lifecycle**：從「手動 reply/reject」擴充到「手動 + stream abort 自動 reject」。
- **Session abort**：從「匿名 cancel」升級到「帶 reason 的 cancel」。

## Impact

- **Code**:
  - `packages/opencode/src/question/index.ts`（核心）
  - `packages/opencode/src/tool/question.ts`（傳遞 ctx.abort）
  - `packages/opencode/src/session/prompt-runtime.ts`（reason 參數）
  - `packages/opencode/src/session/prompt.ts`（`SessionPrompt.cancel` 也帶 reason）
  - 所有 `SessionPrompt.cancel` / `prompt-runtime.cancel` 的 call site
  - `packages/app/src/components/question-dock.tsx`（cache key）
- **Docs**: `specs/architecture.md`（Question lifecycle SSOT）+ `docs/events/event_2026-04-19_question-abort-fix.md`
- **沒影響**: LLM provider 層、permission 系統、TUI question.tsx、ACP agent
- **Risk 等級**: 中——Bus event 多跑一次 `question.rejected`；下游 consumer 行為需驗（webapp / TUI / ACP 都吃同一顆事件）
