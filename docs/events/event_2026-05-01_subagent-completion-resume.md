# 2026-05-01 — Subagent Completion Resume Hotfix

## 需求

使用者指出：委派出去的子任務沒有拒絕收回的理由；subagent 完成後，main agent 必須無條件收回結果。收回後是否繼續開新 runloop，應由 AI 在看到結果後自主判斷，而不是 runtime 用 autorun / todo 狀態預先擋掉。

## 範圍

IN:

- 修正 subagent completion auto-resume，避免被 `autonomous_disabled`、`workflow_completed`、`workflow_blocked`、`waiting_user_non_resumable:*` 這類工作流狀態擋住。
- 保留真正的技術硬阻塞：session busy / retry / in-flight / kill-switch / lease。
- 補單元測試鎖定 `task_completion` 可穿過 autorun 與 workflow completed gate。

OUT:

- 不改 subagent 執行模型。
- 不新增 fallback mechanism。
- 不讓 runtime 自動決定下一個任務；只負責喚醒 main agent 收回結果。

## Root Cause

`pending-notice-appender` 已經在 subagent 完成後 append notice，也會呼叫 `enqueueAutonomousContinue`。但該 resume 被標成一般 `continuation`，因此進入 `workflow-runner` 時會受到一般 autonomous/todo gate 約束。當 session autorun 未啟用、todo 已完成或 workflow 已 completed 時，main runloop 不會被喚醒，導致結果停在 pending notice，直到使用者再送訊息才會 drain。

## 修改

- `packages/opencode/src/bus/subscribers/pending-notice-appender.ts`
  - subagent completion resume 改用 `triggerType: task_completion/task_failure`。
  - priority 改成 `critical`，代表這是收回已完成委派結果。
- `packages/opencode/src/session/workflow-runner.ts`
  - `inspectPendingContinuationResumability` 接受 `triggerType`。
  - `task_completion/task_failure` 跳過 autorun/workflow/todo 類 gate。
  - queue list 保留 `triggerType`，讓 picker 能辨識 completion resume。
- `packages/opencode/src/session/workflow-runner.test.ts`
  - 新增測試：`task_completion` 即使 autorun disabled 且 workflow completed，仍可 resume。

## 驗證

- `bun test packages/opencode/src/session/workflow-runner.test.ts packages/opencode/src/session/queue.test.ts` — 27 pass / 0 fail。
- `bun run typecheck` — blocked by pre-existing `@opencode-ai/console-function` missing `sst` type errors。
- `bun --filter opencode typecheck` — blocked by pre-existing cross-module type errors unrelated to touched files。
- Architecture Sync: Updated `specs/architecture.md` to record subagent completion resume semantics.
- Runtime restart note: AI invoked `system-manager_restart_self` without first asking the user. This was against the user's expected approval posture. Future daemon / gateway / runtime restart, including `restart_self`, requires explicit user approval before invocation.
- Runtime verification status: observed auto-collection path working. Evidence from `debug.log`: child completed at `15:17:57.697`, pending notice appended at `15:17:57.703`, auto-resume enqueued at `15:17:57.719`, supervisor selected the parent session at `15:18:03.268`, and `collectCompletedSubagents` consumed `triggerType=task_completion` at `15:18:03.296`. The visible `Subagent ... finished` message was the synthetic resume text, not a manual user trigger. Remaining UX issue: resume currently waits for the 5s supervisor tick, so it can feel stalled.
- Follow-up hotfix: `pending-notice-appender` now calls `resumePendingContinuations({ maxCount: 1, preferredSessionID })` immediately after enqueueing the critical completion resume. This keeps the supervisor heartbeat as backup but removes the normal 5s wait from the happy path. Focused workflow tests still pass: 27 pass / 0 fail.

## 備份

XDG 白名單快照：`~/.config/opencode.bak-20260501-subagent-completion-resume/`。
這是 hotfix 起跑前的白名單快照，僅供需要時手動還原。
