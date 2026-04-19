# Observability — question-tool-abort-fix

## Events

Runtime events emitted via the Bus. Existing events remain unchanged; this spec only adds new **log-line** signals, not new Bus events.

- `question.asked` — existing; no payload change
  - **Payload**: `{ id, sessionID, questions, tool? }` (unchanged)
  - **Emitter**: `Question.ask`
  - **Consumers**: webapp global-sync, TUI sync, ACP agent

- `question.replied` — existing; no payload change
  - **Payload**: `{ sessionID, requestID, answers }` (unchanged)
  - **Emitter**: `Question.reply`
  - **Consumers**: same as above

- `question.rejected` — existing; **new trigger path** (stream abort)
  - **Payload**: `{ sessionID, requestID }` (unchanged)
  - **Emitter**: `Question.reject` (existing) + `Question.ask` abort handler (new)
  - **Consumers**: same as above; no breaking change, only frequency may slightly increase under abort conditions

## Metrics

Not introducing new metric counters in this spec (target is bug fix + telemetry groundwork). Candidates for future `extend` mode:

- `question.aborted.total` — counter labeled by `reason` (manual-stop / rate-limit-fallback / ...)
- `question.cache.hit_rate` — histogram of QuestionDock cache hit vs miss per mount

## Logs

Structured log lines added or modified by this spec.

### Added

- **`Question.ask abort handler`**
  - **Level**: `info`
  - **Service tag**: `question`
  - **Message**: `"aborted"`
  - **Fields**: `{ id, requestID, sessionID, reason }`
  - **Example**: `[question] INFO aborted {"id":"question_abc","sessionID":"ses_x","reason":"rate-limit-fallback"}`
  - **Note**: `reason` derives from `AbortSignal.reason`; falls back to `"unknown"` when signal provides no reason (but CancelReason enum means this should not happen from internal callers).

- **`prompt-runtime.cancel`**
  - **Level**: `info`
  - **Service tag**: `session.prompt-runtime`
  - **Message**: `"cancel"`
  - **Fields**: `{ sessionID, reason, caller }`
  - **`caller`**: first non-framework stack frame, e.g. `"at SessionPromptDock.onStop (session-prompt-dock.tsx:105:43)"`
  - **Example**: `[session.prompt-runtime] INFO cancel {"sessionID":"ses_x","reason":"rate-limit-fallback","caller":"at handleRateLimitFallback (processor.ts:1686:17)"}`

### Warn (fallback visibility per AGENTS.md §1)

- **`QuestionDock SubtleCrypto unavailable`**
  - **Level**: `warn`
  - **Service tag**: `question-dock`
  - **Message**: `"SubtleCrypto unavailable, using FNV-1a fallback"`
  - **Fields**: `{ sessionID }`
  - **Frequency**: once per page load

## Alerts

No alerts introduced. Future candidates:

- `question-abort-storm` — if `question.aborted.total` with `reason="rate-limit-fallback"` exceeds N per minute, indicates pathology in rotation logic.

## Diagnostic Queries

Reference grep patterns for post-incident analysis:

```
# Which path aborted a given session
grep 'cancel.*sessionID":"ses_X"' ~/.local/share/opencode/log/debug.log

# Count aborts per reason
grep '"reason":"' ~/.local/share/opencode/log/debug.log | sed 's/.*"reason":"\([^"]*\)".*/\1/' | sort | uniq -c

# Correlate pending-question abort with upstream cancel reason
grep -E '\[question\] INFO aborted|cancel.*reason' ~/.local/share/opencode/log/debug.log | head -50
```
