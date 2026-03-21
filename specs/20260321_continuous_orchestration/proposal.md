# Continuous Orchestration — Proposal

## Problem Statement

When the Orchestrator dispatches a subagent via `task()`, the entire Orchestrator turn is blocked until the subagent completes. During this period:

1. **UI is frozen** — The chat area shows "Delegating to coding..." with no further updates. The user sees no progress for minutes.
2. **False-positive timeouts** — The `INACTIVITY_TIMEOUT_MS` (default 3 min) fires if the subagent's LLM API response is slow (e.g., GPT-5.4 long thinking), killing a healthy subagent mid-work.
3. **No interactivity** — The user cannot send messages, ask questions, or redirect the Orchestrator while a subagent is running.
4. **Sequential bottleneck** — Only one subagent can run at a time because the Orchestrator's turn is occupied.

## Root Cause

`task()` in `tool/task.ts` is a **synchronous tool call**: it dispatches the subagent, then `await`s its completion via `Promise.race([dispatchToWorker(), timeoutPromise])`. The LLM tool-use contract requires the tool to return a result before the model can continue generating.

## Proposed Solution: Fire-and-Dispatch + Event-Driven Continuation

Change `task()` from a blocking tool call to an **async dispatch** that returns immediately. Subagent completion triggers a bus event that resumes the Orchestrator via the existing `RunQueue` continuation mechanism.

### Current Flow (Blocking)

```
Orchestrator turn:
  text: "Delegating to coding..."
  tool_call: task()           ← BLOCKS for minutes
  tool_result: "..."          ← returns only after subagent completes
  text: "Task done, next..."
```

### Proposed Flow (Non-Blocking)

```
Orchestrator turn 1:
  text: "Dispatching task X..."
  tool_call: task()           ← returns IMMEDIATELY with { taskID, sessionID, status: "dispatched" }
  text: "Task dispatched."    ← turn ends, UI responsive

[subagent works in background]

[subagent completes] → bus event → inject synthetic message → enqueue parent

Orchestrator turn 2 (auto-triggered):
  synthetic_user_msg: "[Task X completed] Result: ..."
  text: "Result received. Dispatching next..."
```

## Existing Infrastructure (What We Already Have)

| Component | Location | Role in Solution |
|-----------|----------|-----------------|
| `Bus.publish()` / `Bus.subscribe()` | `bus/index.ts` | In-process pub/sub backbone |
| `task.worker.done` / `task.worker.failed` | `bus/index.ts` | Subagent lifecycle events (already defined) |
| `Session.updateMessage()` | `session/index.ts` | Inject messages into any session |
| `RunQueue.enqueue()` | `session/queue.ts` | Schedule async session resumption |
| Synthetic messages (`synthetic: true`) | `session/message-v2.ts` | System-generated messages, non-user |
| Event bridge (stdout → bus) | `tool/task.ts` | Worker cross-process event relay |
| `CronDeliveryAnnounce` pattern | `cron/delivery.ts` | Cross-session message injection precedent |

## Implementation Outline

### Phase 1: task() Async Dispatch

**File**: `packages/opencode/src/tool/task.ts`

- Split current `task()` into two phases:
  - **Dispatch phase** (synchronous): create child session, spawn worker, return immediately with `{ taskID, sessionID, status: "dispatched" }`.
  - **Completion phase** (event-driven): handled by a new bus subscriber, not by the tool itself.
- Remove `Promise.race([dispatchToWorker(), timeoutPromise])` blocking pattern.
- Keep the worker subprocess launch and event bridge as-is.

### Phase 2: Completion Subscriber

**File**: new `packages/opencode/src/bus/subscribers/task-completion.ts`

- Subscribe to `task.worker.done` and `task.worker.failed`.
- On completion:
  1. Collect subagent's final output (last assistant message, result summary).
  2. Inject a synthetic user message into the **parent** (Orchestrator) session via `Session.updateMessage()`.
  3. Enqueue the parent session via `RunQueue.enqueue()` with reason `"task_completed"`.
- On failure:
  1. Inject error summary into parent session.
  2. Enqueue with reason `"task_failed"`.

### Phase 3: Orchestrator Prompt Adaptation

**File**: `packages/opencode/src/session/prompt.ts` + `templates/prompts/SYSTEM.md`

- Prompt loop already reads `RunQueue` and resumes with synthetic messages — no code change needed for the resume path.
- Update SYSTEM.md §2.3 to teach the Orchestrator the new tool semantics:
  - `task()` returns immediately with dispatch confirmation.
  - Task results arrive as system messages in subsequent turns.
  - Orchestrator should end its turn after dispatching (no "waiting" text).

### Phase 4: Monitor & UI Polish

**File**: `packages/app/src/pages/session/session-side-panel.tsx`

- Monitor cards already show subagent status — no change needed.
- The `@coding` hyperlink (just added) lets users navigate to the subsession.
- Consider adding an inline progress indicator in the Orchestrator's chat area showing "Task X running... [click to view]".

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Bus event lost (subagent completes but event not delivered) | Add a periodic reconciliation sweep: check active tasks against session status, re-inject if missed |
| Orchestrator context window bloat (many turn boundaries) | Each continuation turn is minimal (task result + next dispatch). Net token cost similar to current approach |
| Backward compatibility (existing SYSTEM.md prompts expect blocking task) | Feature-flag the async mode; default to blocking initially, opt-in via `config.experimental.async_task` |
| Parallel dispatch complexity | Phase 1 stays sequential (dispatch one, wait for completion event, dispatch next). Parallel dispatch is a future extension |
| Subagent timeout handling | Move from inactivity-based timeout to a configurable hard deadline on the subagent session itself, decoupled from the Orchestrator |

## Out of Scope

- **Parallel subagent dispatch** — Future extension. This proposal keeps sequential dispatch but removes the blocking wait.
- **Cross-process bus** — Current in-process pub/sub is sufficient. All sessions run in the same server process.
- **Subagent narration streaming to Orchestrator chat** — Possible future enhancement but orthogonal to this refactor.

## Success Criteria

1. Orchestrator's chat area updates immediately after dispatching a task (no multi-minute freeze).
2. Subagent completion triggers Orchestrator continuation without user intervention.
3. Subagent failures are surfaced to the Orchestrator as actionable error messages.
4. No regression in existing task dispatch, monitoring, or abort functionality.
5. Inactivity timeout false positives eliminated for normal LLM API latency.

## Dependencies

- `RunQueue.drain()` must be reliable and timely (currently polled by server).
- Bus event delivery must be synchronous within the process (already guaranteed).
- `task.worker.done` event must carry enough context to identify the parent session and task ID.
