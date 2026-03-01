# Event: guard inline restart with policy fallback

Date: 2026-03-01
Status: Done

## Problem

- Some sessions/agents still invoked `./webctl.sh restart --inline`.
- In web-backed execution contexts this can stop the active server before start completes, causing self-termination.

## Decision

- Keep `restart` default as detached+graceful.
- Add policy guard: inline restart is disabled by default.

## Implementation

1. `webctl.sh`
   - In `do_restart`, if `--inline` is requested and `OPENCODE_ALLOW_INLINE_RESTART != 1`, auto-fallback to detached+graceful.
   - Emit warning to operator and policy fallback event in restart JSONL ledger.
   - Added help env var: `OPENCODE_ALLOW_INLINE_RESTART`.

2. `README.md`
   - Inline restart section now documents policy fallback and explicit env unlock.

## Expected Outcome

- Legacy/incorrect invocations of `restart --inline` no longer self-kill by default.
- Inline path remains available only when deliberately unlocked for maintenance.
