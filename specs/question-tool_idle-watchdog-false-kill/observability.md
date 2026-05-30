# Observability: question-tool_idle-watchdog-false-kill

## Events

- `idle-watchdog paused` — emitted when an interactive tool (question/permission)
  calls `pauseIdleWatchdog()`. Fields: `tool`, `sessionID`.
- `idle-watchdog resumed` — emitted on `resume()`. Fields: `tool`, `sessionID`,
  `pausedMs`.

## Logs

- Keep existing `llm.ts:1785` `l.warn("stream idle timeout — aborting", {...})` —
  after the fix it should ONLY fire for genuine wedge, never during a question
  wait. Its absence during long question waits is the positive signal.
- Add (optional, low-noise): when `pauseIdleWatchdog()` is invoked, a
  `log.info("idle-watchdog paused", { tool, sessionID })`, and on resume
  `log.info("idle-watchdog resumed", { tool, sessionID, pausedMs })`. This makes
  the pause window auditable (traceability requirement from user: "有可溯性就好").

## Metrics

- `idle_watchdog_paused_total` — count of pause invocations (should correlate
  with question/permission calls)
- `idle_watchdog_pause_duration_ms` — distribution; long tails = users taking
  long to answer (expected, not a problem after fix)

## Alerts

- None required. The bug's signature (`reason="stream idle timeout"` with
  `durationMs ≈ 90000` immediately after a `question.asked`) should no longer
  appear; if it reappears, the fix regressed.

## Verification signal

- Before fix: debug.log shows `[question] aborted reason="stream idle timeout
  after 90000ms"` after `question.asked`.
- After fix: no such pairing; question waits complete on user answer regardless
  of duration.
