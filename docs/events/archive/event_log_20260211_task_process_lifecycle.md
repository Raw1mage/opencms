# Event: Task Process Lifecycle Management

**Date**: 2026-02-11
**Severity**: Medium
**Status**: Completed

## Summary

Implemented comprehensive lifecycle management for subagent child processes to prevent zombie processes and ensure proper cleanup on application shutdown.

## Problem

Previously, subagent processes spawned via `Bun.spawn()` in `task.ts` had no:
1. Explicit lifecycle tracking
2. Shutdown integration
3. Timeout protection for hung processes
4. Activity monitoring to detect stalled processes

This could lead to zombie processes accumulating when:
- Application crashes without cleanup
- Subagent hangs indefinitely
- User force-quits the application

## Solution

### 1. TaskProcessManager (task.ts:21-67)

New namespace for explicit process management:

```typescript
export namespace TaskProcessManager {
  const active = new Map<string, Bun.Subprocess>()

  export function register(id: string, proc: Bun.Subprocess)
  export function kill(id: string)
  export async function disposeAll()
}
```

- `register()` - Track subprocess with auto-cleanup on exit
- `kill()` - Terminate specific process
- `disposeAll()` - Clean all active processes on shutdown

### 2. Shutdown Integration (worker.ts:137-145)

Integrated into application lifecycle:

```typescript
async shutdown() {
  await TaskProcessManager.disposeAll()  // Kill subagents first
  await Instance.disposeAll()            // Then dispose instances
}
```

### 3. Timeout & Heartbeat Mechanism (task.ts:346-398)

Added zombie detection and prevention:

- **Timeout**: Default 10 minutes (configurable via `experimental.task_timeout`)
- **Heartbeat**: Check every 30 seconds, warn if no activity for 2 minutes
- **Auto-kill**: Terminate and throw error on timeout

```typescript
const SUBAGENT_TIMEOUT_MS = config.experimental?.task_timeout ?? 10 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_STALE_MS = 120_000
```

### 4. Session Dialog Log Communication

Main agent and subagent communicate via session storage:

1. Main agent creates user message in session → `Storage.write()`
2. Subagent executes via `session step <sessionID>` command
3. Subagent writes results to session → `Storage.write()`
4. Main agent reads results after process exits → `Session.messages()`
5. Progress tracked via `Bus.subscribe(MessageV2.Event.PartUpdated)`

## Files Changed

| File | Changes |
|------|---------|
| `src/tool/task.ts` | TaskProcessManager + timeout/heartbeat |
| `src/cli/cmd/tui/worker.ts` | Shutdown integration |
| `src/cli/cmd/session.ts` | SessionStepCommand for subagent execution |
| `src/cli/cmd/tui/thread.ts` | Terminal cleanup on exit |
| `src/config/config.ts` | `experimental.task_timeout` config option |
| `src/plugin/antigravity/plugin/request-helpers.ts` | JsonSchema type improvements |

## Configuration

New config option in `experimental`:

```json
{
  "experimental": {
    "task_timeout": 600000  // 10 minutes in milliseconds
  }
}
```

## Related

- [event_20260209_zombie_process_rca.md](event_20260209_zombie_process_rca.md) - Previous zombie process issue
