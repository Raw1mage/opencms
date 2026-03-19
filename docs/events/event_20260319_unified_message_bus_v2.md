# Event: Unified Message Bus v2 Re-implementation

**Date**: 2026-03-19
**Branch**: message-bus-v2 (based on cms HEAD 3ddde82e82)
**Plan**: specs/20260318_unified-message-bus/

## Background

Previous `message-bus` branch was based on incorrect commits and discarded.
This is a clean re-implementation based on the same spec, on a fresh branch from cms HEAD.

## Scope

### IN (This Session)
- Phase 1: broadcast-first directory routing in global-sync.tsx
- Phase 2: subscriber infrastructure (globalSubscriptions, Bus.subscribeGlobal, log-level, debug-writer)
- Phase 3: debugCheckpoint integration (Bus.debug, thin wrapper, Log.ts migration)
- Phase 4: GlobalBus.emit cleanup (11 call sites → Bus.publish with BusContext)
- SSE payload normalization (server/app.ts)
- Circular dependency fix (bus-event.ts Log import removal)

### OUT
- Toast hack removal (kept as fallback until rotation.executed confirmed stable)
- tui-toaster.ts extraction (functionality works via existing SDK listener)
- TuiEvent.ToastShow refactor (kept as-is, functional)
- Runtime validation (needs build + deploy)

## Key Decisions

1. **BusContext envelope**: Added `{ directory, worktree, projectId, sessionId? }` to all Bus.publish calls. Enables directory-aware dispatch and future context-based filtering.
2. **Global vs instance subscribers**: `globalSubscriptions` map survives across instance lifecycles. Used by debug-writer and future cross-cutting subscribers.
3. **Bus.debug stays lightweight**: Does NOT emit to GlobalBus/SSE — debug events are backend-only. Avoids flooding frontend with 432+ debug checkpoints.
4. **Instance dispose order changed**: `Bus.publish(InstanceDisposed)` now fires BEFORE `State.dispose()`, ensuring local subscribers can receive the event.
5. **Toast hack preserved**: The toast `->` parsing in global-sync.tsx is kept as a secondary rotation history source until the Bus event path is confirmed stable.
6. **debug-writer file gate**: Writing to debug.log requires explicit `OPENCODE_DEBUG_LOG=1` or `OPENCODE_LOG_LEVEL` set. Without this, logLevel defaults to 2 but no file is written.

## Files Changed

### New Files
- `packages/opencode/src/bus/bus-context.ts` — BusContext interface
- `packages/opencode/src/bus/log-level.ts` — OPENCODE_LOG_LEVEL env reader with backward compat
- `packages/opencode/src/bus/subscribers/debug-writer.ts` — Sole debug.log writer (moved from util/debug.ts)

### Modified (Core)
- `packages/opencode/src/bus/index.ts` — globalSubscriptions, Bus.debug, Bus.subscribeGlobal, BusContext in publish/subscribe
- `packages/opencode/src/bus/global.ts` — BusContext in event type
- `packages/opencode/src/bus/bus-event.ts` — Removed Log import (circular dep fix)
- `packages/opencode/src/util/debug.ts` — Rewritten as thin wrapper → Bus.debug
- `packages/opencode/src/util/log.ts` — Bus.debug instead of debugCheckpoint
- `packages/opencode/src/index.ts` — registerDebugWriter instead of debugInit

### Modified (GlobalBus.emit cleanup)
- `packages/opencode/src/config/config.ts` — Bus.publish(Event.Disposed)
- `packages/opencode/src/project/instance.ts` — Bus.publish(InstanceDisposed) before State.dispose
- `packages/opencode/src/project/project.ts` — 4× Bus.publish(Event.Updated) with directory:"global"
- `packages/opencode/src/worktree/index.ts` — 3× Bus.publish(Event.Failed/Ready)
- `packages/opencode/src/server/routes/global.ts` — Bus.publish(GlobalDisposedEvent)
- `packages/opencode/src/server/app.ts` — SSE payload normalization {type, properties, context}

### Modified (Frontend)
- `packages/app/src/context/global-sync.tsx` — broadcast-first directory routing with fallback

## Verification

### Type Check
- `npx tsc --noEmit` passes with only pre-existing errors (cron/*, session routes, workflow-runner, tool/plan)
- No new type errors introduced

### GlobalBus.emit Audit
- Direct calls reduced to 1 (bus/index.ts internal SSE transport) — matches spec target
- GlobalBus.on listeners: server/routes/global.ts (SSE endpoint) + tui/worker.ts (TUI bridge) — correct

### Remaining Validation (Needs Runtime)
- [ ] Build + deploy webapp
- [ ] Trigger rate limit rotation → verify LLM card shows chain
- [ ] Verify session/message events don't regress
- [ ] Verify debug.log output format with OPENCODE_DEBUG_LOG=1
- [ ] Verify logLevel=0 suppresses all subscribers

## Architecture Sync

Architecture changes from this task:
- Bus now has dual subscriber registries: instance-scoped (per-directory) and global (cross-instance)
- BusContext envelope on all published events
- debug.log writing consolidated into single subscriber (debug-writer)
- GlobalBus reduced to pure SSE transport adapter
- Circular dependency Log→debug→Bus broken

**Architecture Sync: Pending** — will sync specs/architecture.md after runtime validation confirms stability.
