# Bug Report: Mobile SSE reconnect leaves UI permanently waiting on subagent timer

Status: Resolved (closed 2026-05-29; 174eed7e2)

## 0. Handoff Summary

On mobile, when the SSE connection is interrupted and later reconnects, the UI can remain in a permanent waiting state showing the subagent elapsed timer. The backend subagent may still be running or may already have completed, but the mobile UI does not recover the correct state after reconnect.

## 1. Environment

- Runtime repo: `/home/pkcs12/projects/opencode`
- Date observed: 2026-05-13
- Client surface: mobile web UI
- Affected behavior:
  - SSE disconnect/reconnect
  - subagent running/completion state display
  - elapsed waiting timer in session UI

## 2. Symptoms

- Mobile client loses or interrupts SSE connection.
- After reconnect, the session view continues to show waiting-on-subagent status.
- The subagent timer keeps counting indefinitely.
- The UI does not reliably reconcile with authoritative subagent state.
- Assistant responses can be produced server-side but not rendered in the mobile/web UI until a manual page reload.
- In the observed case, the user asked `issue發好了嗎` and saw no answer, then sent `retry` and still saw no answer; after web reload, both assistant replies appeared.
- User must manually ask/check whether the subagent is still running or reload the page to reveal already-produced messages.

## 3. Expected Behavior

- After SSE reconnect, the client should resync authoritative session/subagent state.
- If the subagent is still running, the timer may continue, but it should be based on confirmed backend state.
- If the subagent finished while disconnected, the UI should drain/reflect the completion notice and stop the waiting timer.
- Reconnect should not leave stale local waiting state permanently active.

## 4. Actual Behavior

- Mobile UI can remain stuck in a permanent waiting state.
- The subagent elapsed timer continues even when the frontend may no longer reflect backend authoritative state.
- Assistant replies may be missing from the live UI even though they are persisted and appear after reload.
- Manual system-manager inspection is needed to confirm the true state.

## 5. Context at Time of Report

The active session was working in `/home/pkcs12/projects/drawmiat` on the Grafcet compliance audit plan. A coding subagent had been dispatched:

```text
session: ses_1df3e47beffe73s0htMZ8I0m8r
job: Implement Grafcet audit (@coding)
status from system-manager at check time: running
```

The user reported the mobile SSE reconnect problem while this subagent was active. The concern is specifically that the mobile UI can display a permanent subagent wait timer after SSE interruption/reconnect, independent of the backend authoritative state.

## 6. Context Budget Evidence

```xml
<context_budget>
window: 272000
used: 2033
ratio: 0.01
status: green
cache_read: 50176
cache_hit_rate: 0.96
as_of: end_of_turn_N-1
</context_budget>
```

This suggests the symptom was not caused by context pressure; it happened while the session had a green context budget and high cache hit rate.

## 7. Impact

- Mobile users cannot trust the session UI after network interruption.
- Long-running subagent work appears hung even when backend state may differ.
- Users must manually request system-level subagent status checks.
- The orchestrator workflow becomes harder to resume because UI state and backend state diverge.

## 8. Hypotheses

One or more of the following may be true:

1. SSE reconnect does not trigger a full session/subagent state refresh.
2. Pending subagent wait state is maintained only client-side and not reconciled after reconnect.
3. Completion notices emitted during disconnect are not replayed or drained on reconnect.
4. The mobile client misses the event that clears the waiting timer.
5. The UI timer has no stale-state timeout or authoritative backend revalidation path.
6. Message append/render state can diverge from persisted session state after SSE interruption, so replies are only visible after full reload.

## 9. Suggested Investigation Areas

- Mobile SSE reconnect lifecycle.
- Session event replay after reconnect.
- Subagent state hydration in the client store.
- Whether completion notices are persisted and replayed after client disconnect.
- Timer clearing logic for subagent wait UI.
- Message stream append/replay behavior after reconnect.
- Whether the client performs a full message reconciliation after SSE resumes.

## 10. Acceptance Criteria

- Mobile SSE reconnect performs an authoritative session/subagent state sync.
- If a subagent completed during disconnect, the UI clears the waiting timer after reconnect.
- If a subagent is still running, the UI shows running state based on backend data, not stale local state.
- Completion notices are not lost across disconnect/reconnect.
- Regression coverage or a manual test plan covers mobile disconnect/reconnect while a subagent is running.
- Replies produced during the disconnect/reconnect window are rendered without requiring manual page reload.
