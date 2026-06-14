# Bug Report: Double compaction produced duplicate summaries and stopped session work

Status: Resolved (closed 2026-05-29; fb26977b3)

## 0. Handoff Summary

During a drawmiat implementation session, the runtime appeared to perform a double compaction for the same conversation boundary. The resumed prompt contained duplicated post-compaction summary blocks, including duplicated `prior_context`, `Post-Compaction Quick Follow-Up`, todolist, working-cache manifest, and `TOOL_INDEX` content.

After the duplicated summaries were injected, the session did not continue the pending plan work from the preserved todo state. User intervention was required to ask what had happened and to request this issue report.

## 1. Environment

- Repo being worked on: `/home/pkcs12/projects/drawmiat`
- Runtime/issue repo: `/home/pkcs12/projects/opencode`
- Date observed: 2026-05-13
- Session behavior involved:
  - compaction / post-compaction context restoration
  - working-cache restoration
  - todo-driven continuation
  - subagent completion notice handling

## 2. Symptoms

Observed in the resumed context:

1. A compaction notice was present.
2. The prior-context summary appeared twice.
3. The `Post-Compaction Quick Follow-Up` section appeared twice.
4. The preserved todolist appeared twice with the same state.
5. The working-cache awareness manifest appeared twice.
6. The agent stopped instead of continuing from the pending todo state.

The duplicated preserved todo state was:

```text
- [x] 讀完兩份 plan 的 spec/design/handoff 並建立 execution ordering
- [x] 推進 MCP output artifacts 到 implementing 並實作/驗證
- [ ] 補齊 Grafcet plan implementing gate artifacts 後推進並實作/驗證
- [ ] 同步 tasks/event/architecture 並做最終 validation
```

## 3. Expected Behavior

- A session should receive a single post-compaction summary for one compaction boundary.
- Rehydrated summary blocks should be deduplicated before model prompt injection.
- If pending todos remain and no stop gate is active, the orchestrator should continue from the next actionable item.
- Duplicate summary injection should not cause the runloop to treat the session as complete or idle.

## 4. Actual Behavior

- Two summary blocks were injected into the same resumed prompt.
- The session context repeated the same summary/todo/cache state.
- The agent did not continue the pending implementation workflow and instead required the user to ask for status.

## 5. Context at Time of Issue

The active task was executing two plan-builder packages in `drawmiat`:

- `plans/mcp_output-solution-artifacts`
- `plans/grafcet_validator-compliance-audit`

Work completed before the issue was noticed:

- Both plans had been read (`spec.md`, `design.md`, `handoff.md`, `tasks.md`).
- Execution order had been established: MCP output artifacts first, Grafcet validator audit second.
- `mcp_output-solution-artifacts` had been advanced to `implementing`.
- A coding subagent had been dispatched for MCP artifact implementation.
- The subagent later finished with `status=success`.
- The parent session read the subagent session output.
- Grafcet plan gate artifacts had been partially updated:
  - `proposal.md`
  - `spec.md`
  - `design.md`
  - `handoff.md`
  - `idef0.json`

Remaining work at the time:

- Review and integrate MCP subagent diff and validation.
- Continue Grafcet plan gate completion / implementation.
- Sync `tasks.md`, event log, and `specs/architecture.md`.
- Run final validation.

## 6. Context Budget Evidence

The user provided the following context budget snapshot while reporting the issue:

```xml
<context_budget>
window: 272000
used: 1076
ratio: 0.00
status: green
cache_read: 33280
cache_hit_rate: 0.97
as_of: end_of_turn_N-1
</context_budget>
```

An earlier related snapshot in the same episode also showed a green/low usage state:

```xml
<context_budget>
window: 272000
used: 931
ratio: 0.00
status: green
cache_read: 31744
cache_hit_rate: 0.97
as_of: end_of_turn_N-1
</context_budget>
```

This suggests the duplicate compaction behavior did not obviously correlate with context exhaustion.

## 7. Impact

- Duplicated summaries increase prompt size and model confusion.
- Pending todo state can be preserved but not acted on.
- User must manually inspect and restart workflow progress.
- Subagent completion and post-compaction continuation become harder to reason about.

## 8. Hypotheses

One or more of the following may be true:

1. The compaction boundary was emitted twice for the same session transition.
2. The prompt assembly path appended both the newly generated summary and an already-preserved summary.
3. The compaction rehydration logic does not deduplicate `prior_context` / quick-follow-up anchors.
4. Todo-driven continuation saw duplicated context and incorrectly decided there was no next action.
5. Subagent completion notice draining and compaction restoration raced, producing duplicate restored state.

## 9. Suggested Investigation Areas

- Compaction trigger logic vs context budget accounting.
- Whether multiple compaction notices can be emitted for the same session boundary.
- Summary reinjection deduplication in prompt assembly.
- Interaction between post-compaction restoration and todo-driven continuation.
- Interaction between subagent completion notice handling and compaction.

## 10. Acceptance Criteria

- A single compaction boundary injects at most one post-compaction summary block.
- Duplicate prior-context / quick-follow-up anchors are detected and suppressed.
- Pending todos survive compaction and continue to drive the next action unless a stop gate is active.
- Regression coverage exists for duplicate summary prevention.
- Regression coverage exists for continuation after compaction with pending todos.
