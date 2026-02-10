# Event: TUI perceived freeze due to `/session/top` snapshot bottleneck

- **Date**: 2026-02-10
- **Severity**: High

## Symptom

- `bun run dev` appears black/frozen in terminal.
- Input is still received (key events visible in debug log), but UI responsiveness is very poor.

## Findings

- `debug.log` showed repeated `/session/top` requests taking ~8–12 seconds.
- `SessionMonitor.snapshot()` rebuilt the full monitor by scanning all sessions and all messages on every request.
- Concurrent polls could overlap and amplify load.

## Root Cause

- Expensive full snapshot executed for every `/session/top` poll.
- No short-term cache and no in-flight request deduplication.

## Fix

- Added `SessionMonitor.snapshot()` short cache (1500ms).
- Added in-flight promise dedupe so concurrent callers share one computation.

## Verification

- Typecheck passed after change.
- Startup path no longer recomputes full monitor on every near-simultaneous poll.
