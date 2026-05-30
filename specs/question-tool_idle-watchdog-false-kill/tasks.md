# Tasks: question-tool_idle-watchdog-false-kill

## 1. Watchdog pause/resume mechanism (llm.ts)

- [x] 1.1 Add `paused` guard to `armIdleWatchdog` so a re-arm while paused is a no-op
- [x] 1.2 Implement `pauseIdleWatchdog()` in `LLM.stream`: disarm idle timer, set paused, return idempotent `resume()` that clears paused + re-arms
- [x] 1.3 Inject `pauseIdleWatchdog` into the tool execution `ctx` (where ctx is built for streamText tools)

## 2. Tool.Context interface (tool.ts)

- [x] 2.1 Add optional `pauseIdleWatchdog?: () => () => void` to `Tool.Context`
- [x] 2.2 Add taxonomy doc-comment per design.md (MUST NOT cancel stream abort / disable input.abort)

## 3. Wire question tool (question.ts)

- [x] 3.1 Wrap `Question.ask` with `const resume = ctx.pauseIdleWatchdog?.(); try { ... } finally { resume?.() }`

## 4. Regression tests

- [x] 4.1 Test: question awaiting > 90s with paused watchdog is NOT aborted (per test-vectors TV-1)
- [x] 4.2 Test: genuine input.abort during pending question still rejects (TV-2)
- [x] 4.3 Test: resume() re-arms; subsequent idle still fires for real wedge (TV-3)
- [x] 4.4 Test: pause/resume idempotency — double resume is safe (TV-4)

## 5. Docs sync

- [x] 5.1 Correct `issues/bug_20260530_question_tool_retracted_treated_as_answered.md` Root Cause to v3 (watchdog)
- [x] 5.2 Architecture sync check: `specs/architecture.md` (note watchdog pause hook or mark Verified No-doc-changes)
- [x] 5.3 Event log `docs/events/event_20260530_question-idle-watchdog.md`

## 6. Validation

- [x] 6.1 `bun test packages/opencode/test/` for new tests — all green (TV-1..TV-4 6/6 pass; related session/tool 57/57 pass; pre-existing task.test.ts fail unrelated to this plan)
- [x] 6.2 typecheck/lint clean on touched files (0 errors on 6 touched files via `tsc --noEmit`)
