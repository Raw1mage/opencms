# Event: Worker Pool GC (Garbage Collection)

**Date**: 2026-03-20
**Type**: Bug Fix
**Scope**: `packages/opencode/src/tool/task.ts`

## Requirement

Per-user daemon running multiple sessions across different projects caused worker process leak.
Workers were allocated but never freed, leading to CPU exhaustion (4 workers * 35% CPU = 140% total)
and cascading 504 errors on the web server.

## Root Cause Analysis

### Bug 1: No idle worker reaping
- `spawnWorker()` creates processes, `ensureStandbyWorker()` eagerly spawns standby after each task
- After task completion, `worker.busy = false` but process stays alive forever
- Pool only grows, never shrinks

### Bug 2: No pool size cap
- No upper bound on concurrent workers
- Each task completion triggers `ensureStandbyWorker()` which spawns a new one
- Cross-project sessions compound the problem

### Bug 3: Idle workers CPU spin (~920GB read/4h)
- All 4 idle workers in R (running) state, consuming 35% CPU each
- Full opencode runtime (`bootstrap()`) keeps internal event loops active
- Workers burning ~230GB/hour of read IO while doing nothing useful

### Evidence
- `strace -c`: 99.99% time in `read` syscalls on idle workers
- `/proc/*/io`: ~920-990 GB rchar per worker over 4 hours
- `/proc/*/status`: 3 of 4 workers in R state (wchan=0), 1 in S state
- `/session/top` API: only 1 session visible, 4 workers running
- All 4 workers had identical env (no session-specific context)

## Fix (IN)

1. **Idle worker reaper**: `WORKER_IDLE_TIMEOUT_MS = 60_000`
   - Worker becomes idle → `scheduleIdleReap()` starts 60s timer
   - Timer fires → `killIdleWorker()` kills process and removes from pool
   - Timer cancelled if worker gets new task assignment (`cancelIdleReap()`)
   - Timer unref'd to not block process exit

2. **Worker pool cap**: `WORKER_POOL_MAX = 3`
   - `ensureStandbyWorker()` skips spawn if at capacity
   - `getReadyWorker()` waits for busy worker to free up if at cap
   - Last-resort fallback: spawn over cap if no worker frees within timeout

3. **UI: Subagent kill button on monitor cards** (`session-side-panel.tsx`)
   - Sub-session / sub-agent cards now show a ✕ button (top-right)
   - Calls existing `session.abort()` API — no new backend endpoint needed
   - Only visible when status is not idle
   - Shows "…" during abort request

4. **UI: Elapsed time on monitor cards** (`session-side-panel.tsx`)
   - Status line now shows how long the subagent has been running (e.g. `Working · 3m · openai/gpt-5.4 · 12 reqs`)
   - Helps users identify stale/stuck subagents

5. **TUI: Session list project prefix** (`dialog-session-list.tsx`)
   - Root sessions now show `[project] title` prefix
   - Project name derived from `session.project?.name` → fallback `path.basename(session.directory)`
   - Only root sessions get the prefix; child sessions inherit parent's category

6. **TUI: Collapsible sub-session trees** (`dialog-session-list.tsx`)
   - Sub-sessions default to collapsed state
   - Root sessions with children show ▸/▾ arrow indicator + child count `[N]`
   - Space key toggles expand/collapse (works on both root and child selection)
   - Tree lines: `├─` for intermediate, `└─` for last child
   - Children sorted by creation time (oldest first)

## Out of Scope

- Project context isolation (workers inherit web server CWD)
- Root cause of idle worker CPU spin in Bun runtime
- Worker session affinity / cross-project worker routing

## Validation

- Backend: `bun build --no-bundle` passes
- Frontend: `vite build` succeeds (12.88s)
- Code review: all `busy = false` paths have `scheduleIdleReap()`, `assignWorker` has `cancelIdleReap()`
- Kill button: guarded by `canAbort()` — only for sub-session/sub-agent with non-idle status
- TUI session list: `bun build --no-bundle` passes; project prefix uses directory basename fallback (SDK Session type has no `project` field)

## Architecture Sync

Architecture Sync: Verified (No doc changes) — this fix adds internal GC to the existing
worker pool in task.ts and a kill affordance to existing monitor cards. No module boundary,
data flow, or state machine changes.
