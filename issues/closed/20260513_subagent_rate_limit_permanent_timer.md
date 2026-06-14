# Bug Report: Subagent rate limit leaves permanent waiting timer and no response

Status: Resolved (closed 2026-05-29; 174eed7e2, event_2026-05-21_rate-limit-exhaustion-autocontinue.md)

## 0. Handoff Summary

During a drawmiat plan execution session, a coding subagent appeared to become stuck behind a rate-limit/quota condition while running. Follow-up clarification: the quota was not necessarily consumed by this active session itself; other concurrent sessions using the same account exhausted the shared quota. After waiting a long time, the condition eventually self-healed: the system switched/rotated to another account, completed the work, and surfaced the subagent success report. The bug is therefore not a permanent deadlock, but an interaction bottleneck: the user sees an apparently endless timer with no timely explanation, progress state, or ETA while recovery is pending.

## 1. Environment

- Runtime repo: `/home/pkcs12/projects/opencode`
- Active work repo: `/home/pkcs12/projects/drawmiat`
- Date observed: 2026-05-13
- Affected workflow:
  - Main orchestrator dispatching coding subagent
  - Subagent execution encountering provider/account rate limit
  - UI/session waiting state and completion notice handling

## 2. Observed Behavior

- A subagent was dispatched for ongoing drawmiat MCP output artifacts work.
- The subagent encountered or was affected by a rate limit during execution.
- Clarification: the rate limit/quota exhaustion was caused by other sessions concurrently using the same account, not by the currently visible session alone.
- After that, the session showed a seemingly permanent subagent waiting timer for a long period.
- No useful completion/error/rate-limit/recovery notice was surfaced back to the user during the wait.
- The user had to manually report that the subagent looked stuck.
- Later observation: the wait eventually self-healed; the system changed account, completed the work, and returned a success report.

## 3. Expected Behavior

- If a subagent hits rate limit, the parent session should receive a terminal or actionable status such as `rate_limited` / `quota_low` with reset timing and account guidance.
- The UI should stop treating the subagent as normally running once a non-progressing rate-limit state is known.
- The waiting timer should not run forever without an explicit stuck/rate-limited state.
- The orchestrator should be able to drain a pending notice and decide whether to rotate account, retry later, or stop for user decision.

## 4. Actual Behavior

- The UI remained in a permanent waiting state.
- The subagent timer continued indefinitely.
- No response was delivered to the user after the rate-limit condition.
- The parent session did not visibly receive an actionable completion notice.

## 5. Context at Time of Report

Active drawmiat task had just dispatched a coding subagent for the MCP output artifacts remaining implementation:

```text
task: Finish MCP artifacts
session: ses_1df000254ffeFpUh6zZ2Ar1Mgg
jobId: call_xcBtW1pZehLcOXvuGjk8RHvA
scope: /files token API, input_token, MCP response/tests, README examples, tasks/event/architecture sync
```

The user reported: "subagent執行中發生rate limit，進入永久讀秒不會再回應。"

Follow-up clarification: "發生rate limit的不是執行中的這個session，而是其他session在同時使用同一帳號用光了quota。"

Second follow-up: after a long wait, the stuck-looking timer eventually recovered. The worker completed after account rotation/switching and returned the success report. The remaining product issue is the long silent interval: the user cannot distinguish recoverable backoff/account rotation from a real hang.

## 6. Context Budget Evidence

```xml
<context_budget>
window: 272000
used: 46365
ratio: 0.17
status: green
cache_read: 18944
cache_hit_rate: 0.29
as_of: end_of_turn_N-1
</context_budget>
```

This suggests the poor interaction was not caused by context pressure; it occurred while the session context budget was green. The cache hit rate had dropped compared with the initial report, but the main symptom was still missing/late progress feedback during rate-limit recovery.

## 7. Impact

- Users cannot tell whether a subagent is still running, rate-limited, crashed, waiting for retry, or actively recovering via account rotation.
- Long-running autonomous workflows can appear stalled for a long time even if they will eventually self-heal.
- Parent orchestrator cannot reliably continue without manual status checks or user intervention.
- The UI communicates progress only via elapsed time even when the meaningful state is backoff/retry/account rotation.

## 8. Hypotheses

1. Subagent rate-limit errors are not being converted into a terminal `rate_limited` pending-subagent notice.
2. The subagent lifecycle state remains `running` after provider 429 / quota failure.
3. UI timer state depends on stale `running` state and lacks stale/no-heartbeat detection.
4. Rate-limit retry/backoff/account rotation may be happening inside the worker without emitting progress or parent-visible state.
5. Parent session notice draining does not cover rate-limit failures emitted before/after SSE disconnect windows.
6. Account-level quota exhaustion caused by other sessions is not propagated to active subagents as an actionable shared-account quota state.

## 9. Suggested Investigation Areas

- Subagent worker error handling for provider 429 / quota errors.
- `SessionActiveChild` state transitions for rate-limited workers.
- PendingSubagentNotice generation for `rate_limited` / `quota_low`.
- UI subagent timer clearing logic for non-running terminal states.
- Heartbeat/stale-running/recovering detection for workers with no user-visible progress after rate-limit.
- Shared account quota accounting across concurrent sessions, including how quota exhaustion from another session is relayed to already-running subagents.

## 10. Acceptance Criteria

- Rate-limited subagents surface an actionable parent notice with reset/account details where available.
- UI shows a clear rate-limited/recovering/stalled state instead of a bare infinite running timer.
- Parent orchestrator can drain the notice and decide next action.
- Long rate-limit recovery emits periodic or state-change feedback, including account rotation/retry status where applicable.
- No subagent remains indefinitely `running` after an unrecoverable or externally blocked rate-limit condition.
- If another session exhausts the same account quota, affected active sessions/subagents receive a clear shared-account quota notice instead of appearing locally hung.
