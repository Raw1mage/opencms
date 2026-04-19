# Spec: question-tool-abort-fix

## Purpose

讓 Question tool 的 pending 生命週期在 stream abort 時可被乾淨地取消、abort cause 可追溯、使用者的輸入在 AI 重問同題時可被回填，避免使用者在 webapp 上「認真答題後畫面出現 Tool execution aborted → AI 重問同一題 → 輸入消失」的連鎖故障。

## Requirements

### Requirement: Question.ask honors stream AbortSignal

Pending question 的生命週期必須綁定到呼叫方提供的 `AbortSignal`，以確保 stream 結束時 pending state 不會遺留、UI 不會繼續讓使用者對著孤兒 dialog 打字。

#### Scenario: stream aborts while question pending

- **GIVEN** Question tool 已呼叫 `Question.ask({ sessionID, questions, tool, abort })` 且 promise 尚未 resolve
- **WHEN** 傳入的 `abort: AbortSignal` 被觸發（rate-limit fallback rotation / 使用者按 Stop / monitor watchdog / instance dispose 任一）
- **THEN** `pending[id]` 立即被 delete
- **AND** `Bus.publish(Event.Rejected, { sessionID, requestID })` 被呼叫一次
- **AND** 該 promise reject 為 `Question.RejectedError`（維持既有 type，processor.ts 的 `blocked = shouldBreak` 邏輯不需改）
- **AND** log 出現 `level=info service=question event=aborted requestID=... reason=<abort-reason>`（reason 取自 `signal.reason` 若存在，否則為 `"unknown"`）

#### Scenario: manual reply still wins against late abort

- **GIVEN** pending question，使用者按 Submit 送出 reply
- **AND** `Question.reply` 已成功 resolve、`pending[id]` 已 delete
- **WHEN** stream 之後才 abort
- **THEN** abort handler 在 `pending[id]` 找不到該 id，no-op（不可重複 publish `question.rejected`）

#### Scenario: signal already aborted at ask time

- **GIVEN** 呼叫 `Question.ask({ abort })` 時 `abort.aborted === true`
- **WHEN** 進入 ask 函式
- **THEN** 不 publish `question.asked`、不寫入 `pending[id]`、直接 reject 為 `Question.RejectedError`

### Requirement: QuestionDock cache key survives AI re-ask

QuestionDock 在使用者答題中途被 unmount 再 remount 時（特別是 AI 重問同一題的情境），使用者先前打的字 / 選的選項 / 當前 tab 必須能被自動回填。

#### Scenario: AI re-asks identical question after abort

- **GIVEN** webapp 上 QuestionDock 顯示 question Q1（questions array 內容 = `[{question, header, options, multiple, custom}, ...]`）
- **AND** 使用者在 tab=0 的 custom input 輸入 "我的答案草稿"
- **WHEN** stream abort、Q1 被 reject、dialog unmount
- **AND** AI 隨後重新呼叫 question tool 產生 Q2（新 `request.id`，但 `questions` array 深度相等於 Q1）
- **THEN** 新 QuestionDock mount 時 cache 命中
- **AND** `store.custom[0] = "我的答案草稿"`
- **AND** `store.tab = 0`
- **AND** `store.answers` 等於先前記錄的選擇狀態

#### Scenario: different question does not leak into cache

- **GIVEN** 先前 cache 記錄了 Q1 的輸入
- **WHEN** 新 question Q3 的 `questions` array 與 Q1 不相等（任一 question / options / multiple / custom 欄位不同）
- **THEN** cache 不命中，QuestionDock 以預設空白 store 初始化

#### Scenario: cache is per-session

- **GIVEN** session A 的 cache 記錄了 Q1 輸入
- **WHEN** session B 收到內容相同的 Q1'
- **THEN** session B 的 QuestionDock 不會命中 session A 的 cache

### Requirement: prompt-runtime cancel carries reason

`prompt-runtime` 的 AbortController 被 trigger 時必須帶 reason string，log 與 AbortSignal.reason 都可讀到，以利之後 log 快速回答「這次 abort 是誰幹的」。

#### Scenario: manual user stop

- **GIVEN** webapp 上 session busy
- **WHEN** 使用者按 Stop，觸發 `POST /session/:id/abort` → `SessionPrompt.cancel(sessionID, "manual-stop")`
- **THEN** `controller.abort("manual-stop")` 被呼叫
- **AND** log 出現 `cancel {sessionID, reason: "manual-stop", caller: "<stack-top>"}`

#### Scenario: rate-limit fallback rotation

- **GIVEN** LLM stream 回報 rate-limit 錯誤、processor 進入 fallback rotation
- **WHEN** 新 stream 啟動前需中斷舊 stream（目前用 `controller.abort()`）
- **THEN** 改為 `controller.abort("rate-limit-fallback")`
- **AND** 下游 Question abort handler 收到 reason = `"rate-limit-fallback"`
- **AND** log 可搜尋 `grep 'reason="rate-limit-fallback"'`

#### Scenario: reason enum boundary

- **GIVEN** 任何新增的 cancel caller
- **WHEN** 呼叫 `SessionPrompt.cancel(sessionID, reason)`
- **THEN** `reason` 必須屬於已定義 enum `"manual-stop" | "rate-limit-fallback" | "monitor-watchdog" | "instance-dispose" | "replace" | "session-switch" | "unknown"`
- **AND** TypeScript 編譯期阻擋不合法值

## Acceptance Checks

1. `bun test packages/opencode/src/question/` 新增 test case 驗證三個 Question scenarios（stream abort / late abort / pre-aborted signal）全數通過
2. `QuestionDock.test.tsx`（或等價 unit test）驗證 cache key per-session / 內容相等命中 / 內容不同不命中
3. webapp 手動 E2E：
   - 開啟 admin 切到會 trigger rate-limit 的 model
   - 等 AI 呼叫 question tool → 故意拖時間觸發 fallback rotation
   - 確認 dialog 在 abort 當下自動消失（不再顯示紅框讓使用者繼續打字）
   - AI 重問同題時前次輸入自動回填
4. `grep 'reason=' ~/.local/share/opencode/log/debug.log` 可見到帶 reason 的 cancel 紀錄
5. `bun run scripts/plan-validate.ts specs/question-tool-abort-fix/` 在 `planned` state 全部 pass
