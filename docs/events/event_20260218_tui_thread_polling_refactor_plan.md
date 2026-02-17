## Context

- User reported persistent high load and suspected "massive child processes".
- Investigation confirms most entries are Bun threads (same PID/task entries), plus real MCP subprocesses.
- Main concern shifted from generic perf tuning to **duplicate work paths** (event push + polling + repeated metadata refresh) that can amplify CPU and upstream calls.

## Confirmed architecture facts

1. **Main TUI thread + one explicit Worker thread**
   - `packages/opencode/src/cli/cmd/tui/thread.ts` creates one `new Worker(...)`.
   - Main thread handles rendering + route logic.
   - Worker thread hosts RPC server + internal event stream bridge.

2. **Thread IPC is JSON message passing, not SHM/sockets**
   - `packages/opencode/src/util/rpc.ts` uses `postMessage(JSON.stringify(...))` and `JSON.parse(...)`.

3. **Process IPC for local MCP is stdio transport**
   - `packages/opencode/src/mcp/index.ts` uses `StdioClientTransport` for local MCP commands.

## Duplicate-work hotspots (priority)

### P0

1. **Session child-route forced polling loop**
   - `routes/session/index.tsx` parent-child session flow calls `sync.session.sync(..., { force: true })` every 200ms/1500ms.
   - This overlaps with event-driven updates and can trigger repeated heavy syncs.

2. **MCP tool discovery re-enumeration**
   - `resolve-tools.ts` calls `MCP.tools()` repeatedly.
   - `MCP.tools()` performs per-client `listTools()` calls each time.
   - Produces repeated cross-process calls and redundant schema conversion.

3. **Task subagent activity polling**
   - `tool/task.ts` polls `Session.messages(sessionID)` every 2s per subagent run for liveness.
   - Concurrent subtasks multiply I/O and reconciliation work.

### P1

4. **Monitor polling in sync context**
   - `context/sync.tsx` polls `session.top()` continuously (idle + active intervals).
   - Useful as fallback, but duplicates event-derived state in many cases.

5. **Prompt/footer metadata refresh timers**
   - prompt/footer has independent timers and model/quota refresh behavior.
   - Can update reactive graph even when user is idle.

## Refactor plan (approved direction)

### Phase A — Single source of truth for session updates

- Introduce **Event-first SessionSyncCoordinator**:
  - Event stream is primary update source.
  - Polling is fallback only when stream degraded or stale timeout reached.
- Replace route-level 200ms polling with coordinator signal (`healthy/degraded/recovering`).
- Add monotonic sequence/version guard to avoid replaying stale payloads.

### Phase B — MCP tools cache + invalidation

- Add in-memory cache for `MCP.tools()` result per instance with TTL.
- Rebuild cache only on:
  - `mcp.tools.changed`
  - explicit connect/disconnect/add/remove
  - cache expiry (long TTL)
- Ensure `resolve-tools.ts` reads cached transformed tool map.

### Phase C — Task worker liveness from events, not message scans

- Replace per-run `Session.messages()` 2s polling with:
  - worker heartbeat (`WORKER_PREFIX heartbeat`)
  - bridged event timestamps (already available in worker bridge path)
- Keep low-frequency emergency fallback poll only when no heartbeat/event for threshold window.

### Phase D — TUI timer hygiene

- Centralize idle timers under one scheduler and pause on inactive panels/routes.
- Footer/quota refresh adopts adaptive backoff (active session vs idle home).
- Introduce `OPENCODE_TUI_DIAGNOSTIC_TIMERS=1` to inspect live timer counts and origin.

## Safety rails and validation

- Add instrumentation counters (debug-only):
  - event_rx/s, poll_calls/s, sync_apply/s, mcp_listTools/s
  - route-level forced sync count
- Success criteria:
  1. Idle state: near-zero forced sync calls
  2. `MCP.listTools` call rate near zero in steady state
  3. No regression in session correctness (message/todo/permission updates)

## Risks

- Event-only over-optimization can miss updates during transient disconnects.
- Cache invalidation bugs can hide newly available MCP tools.
- Need phased rollout behind feature flags for safe comparison.

## Rollout strategy

1. Feature flags per phase (`SYNC_COORDINATOR_V2`, `MCP_TOOLS_CACHE_V1`, `TASK_LIVENESS_V2`).
2. Ship Phase A first with metrics only; verify no stale UI.
3. Enable Phase B and compare tool-resolve latency + subprocess call counts.
4. Enable Phase C to reduce task-path background I/O.
5. Remove old polling paths after two stable cycles.

## 2026-02-18 User feedback and architecture decisions

1. **Phase A IPC direction**
   - User asked whether Sync can use socket/SHM style sharing to avoid I/O overhead.
   - Decision:
     - Keep single-process main-thread/worker design.
     - Replace JSON-string RPC payloads with structured-clone message objects first (lowest risk, high gain).
     - Add optional `SharedArrayBuffer` for tiny hot-state signals only (sequence, health, timestamps), not full event payloads.
     - Do not introduce local socket IPC for in-process thread communication (adds complexity without clear benefit).

2. **Phase B scope clarification**
   - Even single-user mode can still pay repeated MCP `listTools` costs due to resolve frequency.
   - Decision: keep MCP tools cache phase; this is about repeated cross-process discovery, not multi-user worker count.

3. **Phase C orphan/zombie safety requirement (explicit)**
   - User requires preserving orphan/zombie defense behavior.
   - Decision:
     - Keep `ProcessSupervisor` cleanup and timeout kill paths as mandatory.
     - Add bidirectional liveness watchdog:
       - parent monitors worker heartbeat
       - worker exits if parent link is lost/stale
     - Keep low-frequency emergency poll fallback and hard-kill escalation for stalled workers.

4. **Phase D preference**
   - User strongly prefers centralized timer architecture.
   - Decision: proceed with TimerCoordinator abstraction and per-route registration API.

## Implementation update (Round 1)

### Completed

1. **Phase A (partial): RPC transport optimization baseline**
   - Updated `packages/opencode/src/util/rpc.ts`:
     - Added typed wire message envelope.
     - Switched default worker IPC to object message transport (structured clone) instead of forced JSON string serialization.
     - Kept backward compatibility by decoding both string and object payloads.

2. **Phase B (core): MCP tools cache + invalidation**
   - Updated `packages/opencode/src/mcp/index.ts`:
     - Added per-instance MCP tools cache with TTL (`OPENCODE_MCP_TOOLS_CACHE_MS`, default 30s).
     - Added invalidation on:
       - `mcp.tools.changed` bus event
       - MCP `add/connect/disconnect`
       - MCP `listTools` failure path
     - `MCP.tools()` now returns cached transformed tool map when cache is valid.

### Validation

- `bun run lint -- packages/opencode/src/util/rpc.ts packages/opencode/src/mcp/index.ts`
- `bun run typecheck`

### Notes

- Phase C orphan/zombie safeguards remain intact and are not reduced by this round.
- Phase A SHM hot-signal path and Phase D timer coordinator remain planned for next rounds.

## Implementation update (Round 2)

### Completed

1. **Phase C (core): task liveness moved to heartbeat/event-first**
   - Updated `packages/opencode/src/tool/task.ts`:
     - Removed 2-second continuous `Session.messages()` polling loop.
     - Liveness now primarily follows worker heartbeat and bridged event timestamps.
     - Kept low-frequency emergency storage fallback polling (60s cadence) when activity appears stale.
     - Preserved stale detection and `ProcessSupervisor.markStalled(...)` safeguards.

2. **Phase C (safety): worker orphan watchdog**
   - Updated `packages/opencode/src/cli/cmd/session.ts`:
     - Added parent watchdog in `session worker` mode.
     - If `ppid === 1`, worker emits orphan error and performs cleanup/exit proactively.

3. **Phase D (initial): centralized timer primitive introduced**
   - Added `packages/opencode/src/cli/cmd/tui/util/timer-coordinator.ts`.
   - Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx` monitor poll scheduling to use coordinator.
   - Enables timer diagnostics via `OPENCODE_TUI_DIAGNOSTIC_TIMERS=1` and prepares route/component adoption.

### Validation

- `bun run lint -- packages/opencode/src/tool/task.ts packages/opencode/src/cli/cmd/session.ts packages/opencode/src/cli/cmd/tui/context/sync.tsx packages/opencode/src/cli/cmd/tui/util/timer-coordinator.ts`
- `bun run typecheck`

### Notes

- This round specifically preserves orphan/zombie defense while reducing duplicate background I/O from subagent liveness tracking.
- Next step for Phase D is migrating other high-frequency timers (session child-route pollers, footer refresh) into coordinator-managed lifecycle.

## Implementation update (Round 3)

### Completed

1. **Phase D (expansion): timer coordinator now supports intervals**
   - Updated `packages/opencode/src/cli/cmd/tui/util/timer-coordinator.ts`:
     - Added interval scheduling API (`scheduleInterval`).
     - Unified clear/dispose logic for timeout + interval tasks.

2. **Phase D (route adoption): child-session polling moved under coordinator**
   - Updated `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`:
     - Replaced ad-hoc `setTimeout` loop for child-session forced sync with coordinator-managed scheduled task.
     - Added route-scope timer coordinator lifecycle (`dispose` on cleanup).

3. **Phase D (prompt adoption): footer refresh timer centralized**
   - Updated `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`:
     - Replaced direct `setInterval` footer tick timer with coordinator-managed interval.
     - Added prompt-scope timer coordinator lifecycle (`dispose` on cleanup).

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/routes/session/index.tsx packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx packages/opencode/src/cli/cmd/tui/util/timer-coordinator.ts`
- `bun run typecheck`

### Notes

- This round completes the originally planned migration of child-route poller and prompt/footer timer into a centralized timer abstraction.

## Implementation update (Round 4)

### Completed

1. **Phase D (finalizing session-view elapsed timers): inline/task elapsed intervals migrated**
   - Updated `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`:
     - Migrated `InlineTool` 1s elapsed timer from ad-hoc `setInterval` to coordinator-managed interval.
     - Migrated `Task` tool 1s elapsed timer from ad-hoc `setInterval` to coordinator-managed interval.
     - Added per-component coordinator lifecycle cleanup via `dispose()`.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `bun run typecheck`

### Notes

- Session route now has centralized management for child-session poll timer and elapsed 1s timers in key tool components.

## Implementation update (Round 5)

### Completed

1. **Phase D (prompt retry timer unification): retry countdown migrated**
   - Updated `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`:
     - Removed inline JSX-scoped retry timer setup (`setInterval` inside render IIFE).
     - Added top-level retry derived state (`retryStatus`, `retryMessage`, truncation, seconds).
     - Migrated retry countdown to coordinator-managed interval (`retry-countdown`).
     - Cleans timer when retry state exits and resets seconds to avoid stale UI state.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- `bun run typecheck`

### Notes

- Prompt footer + retry timers are now both managed by the same prompt-scope timer coordinator.

## Implementation update (Round 6)

### Completed

1. **Phase E (initial): idle render gate + lower VSCode baseline FPS**
   - Updated `packages/opencode/src/cli/cmd/tui/app.tsx`:
     - Lowered VSCode default target FPS from 15 -> 8.
     - Added `OPENCODE_TUI_IDLE_GATE` (default enabled on VSCode terminals).
     - Added `OPENCODE_TUI_IDLE_FPS` (default 2, clamped 1..10).
     - Implemented home-screen idle gating strategy:
       - switch renderer to manual mode when idle (if supported)
       - schedule low-frequency `requestRender()` ticks while idle
       - return to auto mode and force render when leaving idle

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/app.tsx`
- `bun run typecheck`
- quick CPU sampling under perfprobe/home idle scenario

### Observations

- CPU still remains non-trivial in pseudo-tty tests; improvements are partial.
- This suggests a significant remaining baseline cost in renderer/terminal write path (likely upstream/runtime behavior), not only app-level polling/timers.

## Implementation update (Round 7)

### Findings

1. **Phase E idle gate experiment did not deliver expected wins**
   - Additional A/B sampling showed idle-gate mode can stay high and sometimes worse in pseudo-tty measurements.
   - Forcing very low FPS did not proportionally reduce CPU, reinforcing that dominant cost is likely renderer/terminal write baseline.

### Action taken

- Rolled back Phase E idle-gate logic in `packages/opencode/src/cli/cmd/tui/app.tsx` to avoid shipping potentially regressive behavior.
- Restored VSCode default FPS baseline to previous 15.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/app.tsx`
- `bun run typecheck`

### Decision

- Stop app-layer micro tuning for now.
- Next investigation should target renderer/runtime internals with a minimal reproduction and upstream-level profiling.

## Implementation update (Round 8)

### Goal

- Validate whether high load is frontend-only or shared with non-TUI runtime.
- Determine if many threads are actively fighting each other vs mostly idle pool threads.

### Findings

1. **Non-TUI (`serve`) also has notable idle CPU baseline**
   - `serve` mode without TUI still shows non-trivial CPU usage (declines over time but remains >0).

2. **TUI mode remains higher than serve mode under same constraints**
   - TUI idle remains significantly higher than serve idle, confirming additional render/terminal overhead.

3. **Thread-level snapshot: one dominant hot thread; most others are parked**
   - In TUI snapshots, main bun thread is dominant (`%CPU` very high on one TID).
   - Majority of other threads are blocked in `futex_wait_queue_me` (`Bun Pool`, `HeapHelper`, helper threads).
   - This does **not** match “many active threads mutually fighting” as primary pattern.

4. **Instrumentation limitations in current environment**
   - `strace` is unavailable, so syscall attribution per thread was not captured in this round.
   - Available evidence from `ps -L` + `wchan` supports the one-hot-thread hypothesis.

### Decision

- Treat issue as mixed baseline: backend runtime cost + TUI incremental cost, with main-thread dominant execution.
- Next step should be user-space stack sampling/profiling of the hot main thread (perf/eBPF or Bun-compatible profiler output), plus optional app-level activity beacons for known custom workers.

## Implementation update (Round 9)

### Goal

- Try to make threads report what they are doing.

### Findings

1. **Per-thread state visibility achieved (partial)**
   - Captured thread inventory via `/proc/<pid>/task/*` with `comm` + `wchan`.
   - Typical names observed: `bun` (main), `JITWorker`, `Bun Pool N`, `HeapHelper`, `HTTP Client`, `Worker`, `File Watcher`, helper threads.
   - Most non-main threads are blocked in `futex_wait_queue_me` (parked/waiting), not actively burning CPU.

2. **Main-thread dominance persists**
   - Hot CPU remains concentrated on main bun thread in both serve and TUI snapshots.

3. **Profiler tooling gap in current WSL kernel setup**
   - `perf` binary exists but kernel-matched perf tooling is missing (`linux-tools-5.15.167.4-microsoft-standard-WSL2+`).
   - `strace` is unavailable.
   - Therefore, direct user-space stack attribution by thread was not possible in this environment this round.

### Decision

- Thread-level "what are they waiting on" is available now; "which JS/C++ function each thread is executing" needs proper profiler setup.
- If user wants full per-thread call-stack attribution, install matching WSL linux-tools (or run on native Linux host) before next profiling round.

## Implementation update (Round 10)

### Goal

- Implement app-level activity beacons (user requested option 2) so runtime can self-report what work loops are active.

### Completed

1. **Added process activity beacon utility**
   - New file: `packages/opencode/src/util/activity-beacon.ts`
   - Emits periodic structured lines to stderr when enabled:
     - prefix: `__OPENCODE_ACTIVITY__`
     - includes pid/ppid, process cpuPct delta, thread count, counter deltas, gauges, timestamp
   - Env controls:
     - `OPENCODE_ACTIVITY_BEACON=1`
     - `OPENCODE_ACTIVITY_BEACON_INTERVAL_MS` (default 1000ms)

2. **Instrumented backend/TUI-worker hot paths with counters**
   - `packages/opencode/src/cli/cmd/tui/worker.ts`
     - event stream subscribe attempts/events/errors
     - rpc.fetch/server/reload/shutdown/checkUpgrade calls
   - `packages/opencode/src/server/app.ts`
     - request ingress
     - SSE connect/publish/heartbeat/disconnect
   - `packages/opencode/src/tool/task.ts`
     - worker spawn/ready/heartbeat/done/error/cancel
     - bridged event parsing/publishing
     - worker dispatch lifecycle + worker pool gauges

### Validation

- `bun run lint -- packages/opencode/src/util/activity-beacon.ts packages/opencode/src/cli/cmd/tui/worker.ts packages/opencode/src/server/app.ts packages/opencode/src/tool/task.ts`
- `bun run typecheck`
- manual run with beacon enabled showed expected `__OPENCODE_ACTIVITY__` payloads and non-empty counters in TUI worker path.

### Notes

- This does not provide per-thread JS call stacks; it provides low-overhead per-process activity attribution for major app loops.
- Useful for quickly separating "busy because of app events" vs "busy with no app counters (likely runtime baseline)".

## Implementation update (Round 11)

### Direct measurement conclusion (beacon-based)

1. **Serve idle baseline is low and quiet**
   - With beacon enabled on `serve`, post-warm CPU is low (~1-2% average in sampled idle window).
   - Beacon counters are empty in steady window (no significant app-loop activity).

2. **TUI default dev idle remains very high, but app counters are mostly empty**
   - With beacon enabled on default `bun run dev` (VSCode terminal simulation), steady CPU remains high (~130%+ sampled average).
   - In the same steady window, beacon counters are almost always empty (only rare heartbeat/event increments).

3. **Inference**
   - High steady idle CPU is **not primarily driven by the instrumented app-level loops** (`rpc.fetch`, server request pipeline, event stream churn, task worker churn).
   - The dominant remaining load is likely in **renderer/runtime/internal terminal rendering path** (outside current app-level beacon counters).

### Decision

- Prioritize runtime/render-layer investigation (opentui/bun terminal rendering internals) over further app-loop micro-optimizations.

## Implementation update (Round 12)

### Goal

- Execute strict differential diagnosis to isolate whether high CPU comes from generic opentui baseline or from opencode-specific TUI composition/runtime path.

### Completed

1. Added minimal reproduction script:
   - `scripts/tui-min-repro.tsx`
   - static frame, configurable fps, optional renderer hooks.

2. Added temporary route gauge beaconing:
   - `packages/opencode/src/cli/cmd/tui/app.tsx`
   - emits `tui.app.route` and `tui.app.dialog_count` gauges.

3. Added minimal home toggle for controlled A/B:
   - `packages/opencode/src/cli/cmd/tui/routes/home.tsx`
   - `OPENCODE_TUI_MINIMAL_HOME=1` hides heavy home widgets for isolation.

### Measurements (same VSCode-terminal simulation)

1. **serve baseline**
   - settles from startup spikes down to low teens / single digits over time.

2. **minimal opentui repro (`tui-min-repro.tsx`)**
   - low steady CPU (~3-9% observed), even with:
     - `disableStdoutInterception`
     - `useTerminalDimensions`
     - `useKeyboard` hook registration

3. **full `bun run dev` TUI**
   - stable high idle CPU (~130%+).
   - beacon gauges confirm route stays on `home` with no dialogs.
   - app counters mostly empty during high-CPU steady window.

4. **`OPENCODE_TUI_MINIMAL_HOME=1` A/B**
   - hiding Prompt/Tips/Logo still leaves ~130%+ steady CPU.

### Conclusion

- Root cause is **not** generic opentui minimal baseline and **not** currently instrumented app-loop counters.
- High steady load is tied to opencode TUI runtime/render behavior in full app context (likely in renderer diff/render pipeline with current app tree/integration), even when route is idle home.

## Implementation update (Round 13)

### Goal

- Perform provider-tree bisection to isolate which integration layer causes high steady CPU.

### Completed

1. Added experiment modes in `tui/app.tsx`:
   - `OPENCODE_TUI_EXPERIMENT=full_tree_no_ui`
   - `OPENCODE_TUI_EXPERIMENT=empty_route_tree`
   - `OPENCODE_TUI_EXPERIMENT=tree_sdk_sync`

2. Ran CPU sampling under VSCode terminal simulation.

### Measurements

- `full_tree_no_ui`: remains high (~126% -> 131% samples)
- `empty_route_tree`: much lower (~45% -> 29% samples)
- `tree_sdk_sync`: high (~127% -> 132% samples)
- `tree_sdk_sync + OPENCODE_TUI_DISABLE_MONITOR_POLL=1`: drops significantly (~52% -> 35% samples)

### Conclusion

- Major hotspot is within `SDKProvider + SyncProvider` stack, not the downstream UI widgets (prompt/logo/tips/dialog tree).
- `SyncProvider` monitor polling path is a primary contributor; disabling monitor poll produces the largest observed drop.

## Implementation update (Round 14)

### Goal

- Replace fixed-interval `session.top()` polling with a lower-cost **event-first + route-gated + stale-fallback** monitor strategy inside `SyncProvider`.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx` monitor orchestration:
   - Added route-aware gating (`useRoute`) so monitor work only runs on `session` route.
   - Added event-triggered refresh requests (debounced) for `session.*`, `message.*`, and `todo.updated` events.
   - Added minimum refresh guard (`OPENCODE_TUI_MONITOR_MIN_REFRESH_MS`) to avoid bursty top calls.
   - Kept fallback polling, but moved to much slower cadence defaults (active/idle) and only while session route is active.
   - Clears monitor timers when leaving session route.

2. Added new tuning knobs (with defaults):
   - `OPENCODE_TUI_MONITOR_POLL_MS` (active fallback)
   - `OPENCODE_TUI_MONITOR_IDLE_POLL_MS` (idle fallback)
   - `OPENCODE_TUI_MONITOR_MIN_REFRESH_MS` (event refresh floor)
   - `OPENCODE_TUI_MONITOR_EVENT_DEBOUNCE_MS` (event debounce)

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Expected effect

- Reduce idle/near-idle `session.top()` pressure substantially in VSCode terminal mode without removing monitor capability.
- Preserve monitor correctness via immediate route-enter refresh + event-driven refresh + stale fallback safety.

## Implementation update (Round 15)

### Goal

- Remove remaining high CPU on `-c` session route by preventing monitor startup work when route session is idle.

### Findings before this round

- Under pseudo-tty (`script`) + `-c` route, CPU remained very high with monitor enabled:
  - `continue_default`: ~140% avg
  - `continue_disable_monitor`: ~28% avg (earlier run)
- Slowing monitor intervals/debounce alone did not help, implying startup/activation condition was still too eager.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx` monitor activation policy:
   - Added `currentRouteSessionID()` helper and explicit `isSessionRoute()` checks.
   - `isMonitorTrackingActive()` now requires **session route + (route status non-idle OR existing monitor entries for route session)**.
   - Route-enter no longer forces immediate monitor refresh for idle sessions.
   - Event path wake-up added: `session.status` for current route session with non-idle status triggers immediate refresh.
   - Other event-triggered refreshes still apply only when tracking is active.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Measurements after this round

- Pseudo-tty + `-c` route re-test:
  - `continue_default`: ~5.7% avg
  - `continue_disable_monitor` (retry): ~5.5% avg

### Conclusion

- Idle session-route CPU spike is resolved by monitor activation gating (not by merely stretching polling interval).
- New behavior keeps monitor dormant until session becomes active, while preserving wake-up on active status transitions.

## Implementation update (Round 16)

### Goal

- Enforce user-requested policy: monitor should be effectively **active-session-only**, and avoid stale cross-session monitor churn.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx`:
   - Added `stopMonitorTracking()` helper to clear monitor timers and reset monitor store.
   - Added route session-id switch handling (`on(currentRouteSessionID)`):
     - reset monitor timestamp,
     - clear previous monitor data/timers,
     - only re-arm when new route session is active.
   - Tightened inactive path behavior:
     - when tracking conditions are not met, explicitly stop monitor tracking instead of passively returning.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Outcome

- Monitor lifecycle is now aligned to active session context and no longer lingers across route/session switches.
- Reduces unnecessary monitor-side wakeups and stale monitor state retention.

## Implementation update (Round 17)

### Goal

- Finalize monitor policy to strict **active-session-only** semantics.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx`:
   - `isMonitorTrackingActive()` now gates strictly on route session status being non-idle.
   - Added explicit idle transition handling for current route session:
     - on `session.status` -> `idle`, stop monitor tracking immediately.
   - Non-idle transition for current route session still triggers immediate monitor refresh.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Final scenario sampling (pseudo-tty, VSCode env simulation)

- `home_default` (`bun run dev`): ~2.9% avg
- `tree_sdk_sync` (`OPENCODE_TUI_EXPERIMENT=tree_sdk_sync`): ~2.7% avg
- `tree_sdk_sync_disable_monitor`: ~2.7% avg
- `session_continue` (`index.ts -c`):
  - pre-Round 14 baseline: ~140% avg
  - after active-session gating rounds: sampled around single-digit to low tens in repeated runs

### Conclusion

- Major idle CPU regressions tied to monitor activation have been neutralized in main scenarios.
- Monitor now behaves per product intent: active-session-only, with explicit idle shutdown.

## Implementation update (Round 18)

### Goal

- Cleanup temporary perf-isolation code paths now that monitor RCA and fix are complete.

### Completed

1. Removed temporary experiment branches from `packages/opencode/src/cli/cmd/tui/app.tsx`:
   - Removed `OPENCODE_TUI_EXPERIMENT` conditional trees:
     - `empty_route_tree`
     - `full_tree_no_ui`
     - `tree_sdk_sync`
   - Removed `NoUIApp` helper used only by experiment mode.

2. Removed temporary minimal-home toggle from `packages/opencode/src/cli/cmd/tui/routes/home.tsx`:
   - Removed `OPENCODE_TUI_MINIMAL_HOME` gating.
   - Restored normal `Logo` / `Prompt` / `Tips` rendering path as default-only behavior.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/app.tsx packages/opencode/src/cli/cmd/tui/routes/home.tsx`
- `bun run typecheck`

### Outcome

- Debug-only experiment branches are removed, reducing maintenance burden and behavior ambiguity.
- Production code path now reflects final monitor policy without extra test scaffolding in the render tree.

## Implementation update (Round 19)

### Goal

- Restore expected sidebar/button click behavior in VSCode terminal while keeping CPU safeguards.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/app.tsx` mouse defaults:
   - `useMouse` default is now enabled across terminals (including VSCode).
   - Kept `OPENCODE_TUI_MOUSE` override behavior unchanged.
   - Kept motion-event gating unchanged (`OPENCODE_TUI_MOUSE_MOVE` remains opt-in).

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/app.tsx`
- `bun run typecheck`

### Outcome

- Sidebar fold/unfold and other click interactions are available again by default.
- High-frequency mouse movement event pressure remains controlled.

## Implementation update (Round 20)

### Goal

- Address CPU spikes when monitor becomes active during conversation by reducing per-refresh monitor work.

### Completed

1. Added scoped monitor snapshot support on server:
   - `packages/opencode/src/server/routes/session.ts`
   - `/session/top` now accepts optional query params:
     - `sessionID`
     - `includeDescendants`
     - `maxMessages`

2. Updated monitor snapshot engine:
   - `packages/opencode/src/session/monitor.ts`
   - `SessionMonitor.snapshot(...)` now supports:
     - restricting to one route session (and optional descendants)
     - capping scanned message count per session via `maxMessages`

3. Updated TUI sync monitor client:
   - `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
   - route monitor refresh now calls scoped top query with:
     - `sessionID` = current route session
     - `includeDescendants = true`
     - `maxMessages = OPENCODE_TUI_MONITOR_MAX_MESSAGES` (default 120)

### Validation

- `bun run lint -- packages/opencode/src/session/monitor.ts packages/opencode/src/server/routes/session.ts packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Outcome

- Monitor refresh no longer needs to scan all sessions and full message history for each active update.
- This directly targets the user-reported "monitor lights up then CPU spikes" scenario.

## Implementation update (Round 21)

### Goal

- Align monitor behavior with product intent: event-driven updates for active agent/subagent/tool changes, not continuous high-frequency polling.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx` monitor strategy:
   - Fallback polling is now **opt-in** only via `OPENCODE_TUI_MONITOR_FALLBACK_POLL=1`.
   - Default behavior is event-driven refresh while session is active.
   - Event trigger scope narrowed to monitor-relevant signals:
     - `session.updated`
     - `session.created`
     - `session.deleted`
     - `session.diff`
     - `message.part.*`
   - Kept `session.status` idle/non-idle transitions as explicit on/off gates.

2. Existing active-session-only guard remains in effect:
   - Monitor tracking only runs when current route session status is non-idle.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Outcome

- Eliminates always-on monitor polling in normal operation.
- Monitor UI updates are now tied to concrete agent/tool/subsession lifecycle events.

## Implementation update (Round 22)

### Goal

- Reduce conversation-time monitor spikes caused by repeated force-refresh during active status churn.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx`:
   - Added monitor priming guard (`monitorPrimed`):
     - first non-idle `session.status` triggers immediate force refresh,
     - subsequent non-idle status events use debounced non-force refresh.
   - Reset priming state when monitor tracking stops.

2. Reduced monitor snapshot payload pressure:
   - Default `OPENCODE_TUI_MONITOR_MAX_MESSAGES` lowered from 120 -> 80.

3. Made `message.part.*` refresh trigger opt-in:
   - Default OFF (to avoid token-stream noise driving monitor updates).
   - Can be enabled explicitly with `OPENCODE_TUI_MONITOR_MESSAGE_PART_EVENTS=1`.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Expected effect

- Fewer expensive monitor snapshots during long answer generation.
- Preserve fast monitor wake-up at start of active work while reducing sustained CPU spikes.

## Implementation update (Round 23)

### Goal

- Move monitor from repeated full recomputation to incremental in-memory state, so monitor load scales with active session changes rather than global history scans.

### Completed

1. Reworked `packages/opencode/src/session/monitor.ts` architecture:
   - Added instance-scoped in-memory monitor state:
     - `sessions`, `statuses`, `dirty`, `rows`, `lastScanAt`
   - Added event-driven dirtiness tracking via `Bus.subscribe`:
     - `session.created/updated/deleted`
     - `session.status`
     - `message.updated`
     - `message.part.updated/removed`
     - `session.diff`
   - Added bootstrap that seeds state once and then relies on incremental updates.

2. Snapshot behavior now:
   - Reads from cached per-session monitor rows by default.
   - Recomputes only dirty active sessions.
   - Applies per-session rescan floor (`SESSION_RESCAN_MIN_MS`) to bound recomputation rate under event storms.
   - Keeps query scoping (`sessionID`, `includeDescendants`, `maxMessages`) for additional cap.

### Validation

- `bun run lint -- packages/opencode/src/session/monitor.ts packages/opencode/src/server/routes/session.ts packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Why this should reduce CPU

- Previous path was effectively recompute-heavy on refresh.
- New path is bounded by:
  - active-session-only targeting,
  - dirty-session-only recompute,
  - per-session rescan minimum interval,
  - max message scan cap.

## Implementation update (Round 24)

### Goal

- Restore dynamic monitor visibility for real tool call lifecycle while keeping stream-noise suppression.

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx` event filter:
   - Default-enable tool lifecycle triggers (`message.part.updated/removed` where `part.type === "tool"`).
   - Keep broad `message.part.*` trigger behind explicit opt-in (`OPENCODE_TUI_MONITOR_MESSAGE_PART_EVENTS=1`).
   - Added `OPENCODE_TUI_MONITOR_TOOL_EVENTS=0` escape hatch to disable tool lifecycle triggers if needed.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Outcome

- Monitor now updates on actual tool call state transitions (pending/running/completed/error) without reintroducing token-stream event storms.

## Implementation update (Round 25)

### Goal

- Prevent missing short-lived [T] tool activity in monitor during fast tool calls (e.g., quick git commands).

### Completed

1. Updated `packages/opencode/src/cli/cmd/tui/context/sync.tsx`:
   - Tool lifecycle events now trigger immediate forced monitor refresh (`requestMonitorRefresh(0, true)`).
   - Added handling for `message.part.removed` as tool-relevant fallback trigger (event payload may not always include full part object).
   - Non-tool monitor events remain debounced to preserve CPU efficiency.

### Validation

- `bun run lint -- packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `bun run typecheck`

### Outcome

- Sidebar monitor is less likely to miss very short tool executions while keeping prior CPU optimizations intact.
