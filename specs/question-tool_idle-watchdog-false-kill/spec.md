# Spec: question-tool_idle-watchdog-false-kill

## Purpose

Prevent the stream-idle watchdog from killing a `question` tool that is
legitimately awaiting a human answer, while preserving the watchdog's
0-byte-wedge detection for genuine stream stalls.

## Requirements

### Requirement: idle watchdog must not kill an interactive tool awaiting human input

#### Scenario: user takes longer than 90s to answer a question
- **GIVEN** the agent has called the `question` tool and is awaiting an answer
- **AND** no LLM token chunks are flowing (the model has paused for the human)
- **WHEN** more than `STREAM_IDLE_TIMEOUT_MS` (90,000ms) elapses
- **THEN** the stream-idle watchdog MUST NOT abort the stream
- **AND** the question remains pending until the user answers or a genuine
  abort occurs

#### Scenario: genuine user/session abort still interrupts a pending question
- **GIVEN** a `question` is pending (watchdog paused)
- **WHEN** a real abort fires (killswitch / manual-stop / session-switch /
  instance-dispose — i.e. `input.abort`, not the idle watchdog)
- **THEN** the question is rejected as before (RejectedError) and the stream
  aborts

#### Scenario: 0-byte wedge detection preserved outside interactive waits
- **GIVEN** the stream is genuinely wedged (provider produces no chunk, no
  interactive tool is awaiting input)
- **WHEN** `STREAM_IDLE_TIMEOUT_MS` elapses
- **THEN** the watchdog fires and aborts the stream as designed

#### Scenario: watchdog resumes after the question resolves
- **GIVEN** a question was answered (or rejected) and the stream continues
- **WHEN** the next LLM step runs
- **THEN** the idle watchdog is re-armed and counts down normally again

## Acceptance Checks

- A `question` awaiting input for > 90s is not aborted by the idle watchdog
  (verified by unit test simulating watchdog pause/resume around `Question.ask`).
- A genuine `input.abort` during a pending question still rejects it.
- The first-chunk watchdog and the post-resume idle watchdog behave unchanged
  for non-interactive stream segments.
- `issues/bug_20260530_question_tool_retracted_treated_as_answered.md` Root
  Cause section corrected to the confirmed (v3) watchdog cause.
