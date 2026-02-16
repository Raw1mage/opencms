# Event: Zombie Process RCA - debug-normalize.ts

**Date**: 2026-02-09
**Severity**: Medium
**Status**: Resolved

## Summary

Multiple `bun run scripts/debug-normalize.ts` processes accumulated over days, consuming 1900+ minutes of CPU time.

## Root Cause

`scripts/debug-normalize.ts` was designed as a daemon with no exit mechanism:

```typescript
// Permanent watch
fs.watch(file, { persistent: true }, () => schedule())

// Permanent interval
setInterval(() => normalize(), 500)
```

**Issues**:
1. `persistent: true` + `setInterval` = never exits
2. No singleton mechanism to prevent multiple instances
3. Hardcoded path `/home/pkcs12/opencode/logs` doesn't match actual log path `~/.local/share/opencode/log/`

## Resolution

**Action**: Deleted `scripts/debug-normalize.ts`

**Reason**: Functionality already built into `src/util/debug.ts`:
- `normalizeFile()` function (line 80)
- `process.on("exit", ...)` hook (line 191)
- Scheduled normalization (lines 120-124)

## Prevention

1. Daemon scripts must include:
   - Singleton lock mechanism (e.g., pidfile)
   - Signal handlers for graceful shutdown
   - `unref()` on timers/watchers where appropriate

2. Avoid duplicate functionality - check existing code before adding scripts
