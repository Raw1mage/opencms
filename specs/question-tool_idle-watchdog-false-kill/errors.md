# Errors: question-tool_idle-watchdog-false-kill

## Error Catalogue

| Code / Source | Message | When | Recovery | Layer |
|---|---|---|---|---|
| `QuestionRejectedError("aborted: ...")` | "The question was dismissed (aborted: ...)" | A genuine `input.abort` (killswitch/manual-stop/session-switch/instance-dispose) fires while a question is pending | Expected — surfaces to the agent as a tool error; agent should treat as a real interrupt, not advance silently | `question/index.ts:179` |
| ~~`QuestionRejectedError("aborted: stream idle timeout after 90000ms")`~~ | ~~idle-watchdog false kill~~ | **ELIMINATED by this fix** — was the bug; the watchdog no longer fires during a question wait | n/a | (was) `llm.ts:1792` |
| watchdog stuck disarmed | (no error; silent wedge-detection loss) | A tool calls `pauseIdleWatchdog()` but never `resume()` (throws without finally) | R1 mitigation: mandatory try/finally in tool; resume in finally | `tool/question.ts` |

## Notes

- The fix removes one error condition (idle false-kill) and preserves another
  (genuine abort). No new user-facing error code is introduced.
- R1 (disarm-without-resume) is a latent risk, not a user error; guarded by the
  try/finally contract in DD-1.
