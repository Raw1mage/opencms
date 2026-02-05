# Global Agent Instructions

---

## Workflow State Machine

Maintain and label your **current state** at all times. Never skip states.

### State Definitions

1. **[ANALYSIS]** (default initial state)
   - Allowed: `read`, `glob`, `grep`, `ls`, `cat` (read-only tools)
   - Forbidden: `edit`, `write`, `rm`, `task` (modification tools)
   - Goal: Gather information, locate issues.

2. **[PLANNING]**
   - Allowed: `todowrite`, text output
   - Forbidden: `edit`, `write`, `rm`, `task`
   - Goal: Produce a plan in `event_*.md` format.

3. **[WAITING_APPROVAL]**
   - All tools forbidden
   - Goal: Wait for user to confirm with "OK", "Proceed", etc.

4. **[EXECUTION]**
   - All tools unlocked
   - Goal: Execute the confirmed plan.

### State Transitions

1. New task -> enter **[ANALYSIS]**
2. Analysis complete -> enter **[PLANNING]** and output plan
3. Plan output -> enter **[WAITING_APPROVAL]**
4. Receive "OK" -> enter **[EXECUTION]**

---

## Tool Usage Guardrails

### `Task` Tool Restrictions

- **NO GHOST CONVERSATIONS**: Never use `Task` for requirement clarification or communication. All communication in **Main Session**.
- **STOP BEFORE CODING**: If no confirmed plan exists, do not call `Task` for coding.
- **Applicable Scenarios**: `Task` may only be used for:
  - Heavy implementation work
  - Deep file exploration
  - Automated testing

---

## Knowledge Record

- Main knowledge index: `docs/DIARY.md`
- Development records (PLANNING / DEBUGLOG / CHANGELOG): `docs/events/event_$date.md`
- DIARY serves only as an event index with dates, summaries, and links.

---

## Debugging

This project implements a unified `debugCheckpoint` framework for centralized system diagnostics.

- **Log location**: `~/.opencode/logs/debug.log`
- **Mechanism**: Critical system components write structured logs via `debugCheckpoint`.
- **Agent guidance**: When encountering issues, check this log file first for execution traces.

---

## Safety SOP

### rm Safety Procedure

1. List targets -> 2. Confirm real paths -> 3. Double-confirm -> 4. Execute -> 5. Verify result.

### File Search Procedure

1. Narrow scope (glob) -> 2. Avoid blind search -> 3. grep if needed -> 4. Report paths before modifying.

### Patch / Modify Procedure

1. Read first -> 2. Minimal changes -> 3. Re-read to verify -> 4. Confirm write.
