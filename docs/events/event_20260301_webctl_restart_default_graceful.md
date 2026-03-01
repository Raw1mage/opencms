# Event: make webctl restart default graceful

Date: 2026-03-01
Status: Done

## Decision

- Change `webctl.sh restart` default behavior to `graceful=1`.
- Keep detached worker as default execution mode.

## Reason

- Some sessions/agents may still call `webctl.sh restart` without extra flags.
- For self-evolution scenarios, safest default must be no-extra-arg behavior.

## Changes

1. `webctl.sh`
   - `do_restart()` now initializes `graceful=1` by default.
   - Help text updated to state `restart` is default detached + graceful.

2. `README.md`
   - Restart section updated to describe default mode as detached + graceful.

## Expected Outcome

- Plain `./webctl.sh restart` now runs through preflight-protected graceful path by default.
