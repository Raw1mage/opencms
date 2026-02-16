# Event: TUI black-screen/unresponsive caused by title generation retry loop

- **Date**: 2026-02-10
- **Severity**: High (startup/session responsiveness degradation)

## Symptom

- `bun run dev` enters TUI but terminal appears black and unresponsive.
- `debug.log` shows repeated LLM errors every few seconds for `agent: title`.

## Evidence

- Repeated error pattern in debug log:
  - `AI_APICallError: No payment method ...`
  - followed by `No output generated. Check the stream for errors.`
- Errors recur continuously for the same session/message.

## Root Cause

- `session/summary.ts` attempts to generate message title when `summary.title` is missing.
- On title-model failure, error was thrown without persisting a fallback title.
- Because title remained empty, subsequent summary passes retried indefinitely.
- Retry loop produced repeated failures/logging and degraded TUI responsiveness.

## Fix

- Add try/catch around title generation in `summarizeMessage`.
- On failure, set deterministic fallback title from first user-text line (truncated).
- Persist fallback via `Session.updateMessage(userMsg)` to break retry loop.

## Verification

- Typecheck passed (`bun turbo typecheck --force`).
- Logic now guarantees `summary.title` is set even when title model fails.
