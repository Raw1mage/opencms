# Bug Report: Stale tool/UI state causes duplicate assistant actions and repeated conflict recovery

Status: Resolved (closed 2026-05-29; d21a6fd79, fb26977b3, 174eed7e2)

## 0. Handoff Summary

During a long drawmiat implementation session, several independent-looking symptoms combined into repeated duplicate/conflict behavior. The agent repeatedly encountered non-authoritative or stale state across tool results, file reads, SSE UI replay, compaction continuation, and subagent status. In response, the agent reasonably retried operations, but those retries caused duplicate patches, duplicate plan promotions, duplicated assistant answers, and unnecessary conflict recovery.

This should be treated as a consistency/idempotency problem across runtime surfaces, not only as agent misuse.

## 1. User Impact

- User sees assistant responses missing until web reload, then multiple previously generated replies appear at once.
- User sees subagent timers continue for a long time without meaningful recovery/progress feedback.
- Agent sees `apply_patch` report success but follow-up reads can appear unchanged, causing unsafe retry pressure.
- Long sessions after compaction can contain duplicated summaries/continuation projections.
- Agent may duplicate side effects such as repeated patch attempts, duplicate event/task edits, or duplicate `specbase_plan_advance` calls.

## 2. Observed Symptom Chain

### 2.1 `apply_patch` success vs read-back inconsistency

Observed multiple cases where:

1. `apply_patch` returned success/ok.
2. Immediate `read` appeared to show the old file content.
3. A direct shell/Python read later showed the patch had actually landed, or a later retry caused duplicate insertion/conflict.

This was most visible on Markdown checklist/event files under drawmiat:

- `plans/mcp_output-solution-artifacts/tasks.md`
- `docs/events/event_20260513_mcp_output_solution_artifacts.md`
- `plans/grafcet_validator-compliance-audit/tasks.md`

Result: the agent retried because read-back did not look authoritative, creating duplicate/conflicting edits and sometimes full-file rewrites.

### 2.2 SSE/UI message replay lag

User reported:

- Asked whether an issue was created; no answer appeared.
- Sent `retry`; still no answer appeared.
- Reloaded web UI; both assistant answers appeared.

This indicates the backend had persisted/generated assistant messages, but the active SSE/UI view did not append/replay them until reload.

Result: user and agent operate from different perceived histories, increasing retry/duplicate action risk.

### 2.3 Compaction duplicate summaries / continuation drift

The session experienced duplicated post-compaction summaries and repeated continuation context. After compaction, the active prompt included duplicated prior-context style blocks and durable todo projections.

Result: agent may re-establish already completed steps, duplicate summaries, or repeat promotion/validation steps unless it explicitly recalls raw tool output.

### 2.4 Subagent state stale or delayed

Observed states included:

- Frontend did not show subagent still running, while system tools later confirmed status.
- Rate-limit/quota exhaustion in another concurrent session using the same account caused long waiting with little/no interactive recovery feedback.
- The subagent eventually self-healed by rotating/switching account and completed, but the user experienced a long stale timer period.

Result: main agent may wrongly conclude a subagent is gone/stuck and start overlapping work, causing rework/conflict.

## 3. Why this triggers duplicate agent behavior

The duplicate actions are not just random retries. They follow from a rational but unsafe recovery loop:

1. Tool/UI says operation may not have taken effect.
2. Agent retries to make progress.
3. Original operation had actually taken effect, or later replay shows it had completed.
4. Retry creates duplicate patch/promotion/reply/conflict.

The runtime should provide a single authoritative state path, or expose staleness explicitly, so agents do not have to infer consistency from conflicting surfaces.

## 4. Related Existing Local Issues

This issue aggregates the broader consistency/idempotency failure mode behind these narrower reports:

- `issues/20260513_apply_patch_ok_but_no_effect_and_duplicate_patch.md`
- `issues/20260513_double_compaction_duplicate_summary_stop.md`
- `issues/20260513_mobile_sse_reconnect_subagent_wait_timer.md`
- `issues/20260513_subagent_rate_limit_permanent_timer.md`

## 5. Context Budget Snapshot

User-provided snapshot at issue request:

```text
<context_budget>
window: 272000
used: 2007
ratio: 0.01
status: green
cache_read: 92160
cache_hit_rate: 0.98
as_of: end_of_turn_N-1
</context_budget>
```

## 6. Suggested Debug Angles

### Tool/file state

- Verify whether `read` can return cached/stale content after `apply_patch` success.
- Confirm whether `apply_patch` result is emitted before filesystem write/refresh is fully visible to read tools.
- Add a monotonic file snapshot/version or write sequence to patch/read outputs.

### SSE/replay

- Ensure SSE reconnect replays all persisted assistant/tool-result deltas exactly once.
- Ensure message ordering is monotonic and idempotent across reload/reconnect.
- Detect when UI is behind persisted session state and surface a reconnect/replay indicator.

### Compaction

- Ensure compaction continuation injects exactly one post-compaction summary block.
- Ensure durable todo projection is not duplicated across compaction boundaries.
- Add guardrails to detect repeated prior-context blocks in the same resumed prompt.

### Subagent state

- Make system-manager/subagent store the authoritative source for UI status.
- On rate-limit/quota rotation wait, surface explicit state: account exhausted, retry ETA, rotated account, last worker heartbeat.
- Avoid indefinite generic timer without recovery status.

## 7. Acceptance Criteria

- After `apply_patch` returns success, subsequent file-read tools either read the updated snapshot or explicitly mark the read as stale with snapshot/version metadata.
- SSE reconnect/reload replays persisted assistant messages exactly once; no missing messages before reload and no duplicate append after reload.
- Compaction continuation does not inject duplicate summaries, duplicate todo projections, or duplicate prior-context blocks.
- Subagent UI state reconciles with authoritative system-manager state and does not remain indefinitely on stale timer after completion/rate-limit recovery.
- Agent-visible tool actions expose enough idempotency/sequence metadata to prevent duplicate retries after ambiguous state.
