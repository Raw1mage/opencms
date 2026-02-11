# Event: Explore Follow-up Technical Debt

Date: 2026-02-11
Status: Open
Scope: Subagent workflow, session monitor behavior

## Context

Current baseline (`b93da7d86` + incremental cherry-pick) has passed `@explore` regression checks.
During validation, two structural issues were identified and should be handled after subagent/child-process lifecycle is stabilized.

## TD-1: Allow controlled nested `task` invocation for subagents

### Symptom

Subagent reports it has no permission to call `task` (spawn further subagents), which limits decomposition quality for complex multi-step work.

### Risk

- Reduced delegation depth for large tasks.
- More orchestration burden forced back to main agent.
- Lower quality for workflows that naturally need layered specialization.

### Direction

- Introduce policy-based nested `task` permission (bounded depth, bounded fan-out, explicit allowlist by agent).
- Keep hard guardrails to avoid runaway recursion and monitor explosion.
- Implement only after child process lifecycle/state accounting is proven stable.

### Acceptance Criteria

- Subagent can spawn allowed sub-subagents under policy.
- Max depth/fan-out is enforced.
- Monitor and session lifecycle remain accurate under nested calls.

## TD-2: Sidebar Monitor shows stale/inactive subsessions

### Symptom

Monitor lists many subsessions that no longer have active work, diluting the original top-like "currently active" intent.

### Risk

- Loss of signal in operational view.
- Harder to diagnose truly stuck sessions.
- User confidence drops due to noisy status panel.

### Direction

- Define strict "active" criteria (recent progress timestamp + running state + unresolved tool activity).
- Add stale aging/expiry and stronger pruning of completed idle subsessions.
- Keep one optional fallback row only when no active items exist.

### Acceptance Criteria

- Monitor highlights only currently active/stuck-relevant sessions by default.
- Completed idle subsessions age out quickly.
- Top-like view remains concise and diagnostic.
