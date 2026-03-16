Update: agent-workflow requires explicit Validation Agent delegation

## Summary

This document augments the existing `agent-workflow` skill with an explicit requirement: after delegating a coding implementation subagent, the main agent MUST delegate a Validation Agent (subagent_type: `review` or `testing`) to verify the coding work against the plan/specs before marking implementation tasks as completed.

## Motivation

The agent-workflow skill currently mandates documentation delegation for non-trivial tasks and requires "Validation" items in plans, but it does not explicitly require a dedicated validation subagent to be run after coding changes. This gap can allow coding agents to complete changes without an automated verification step.

## New Requirement

1. For any non-trivial coding task (action.kind == 'implement' or 'architecture_change') that was delegated to a coding subagent, the main agent MUST:
   - Create and delegate a Validation Agent (subagent_type: `review` or `testing`) with a clear validation prompt that includes:
     - the spec/plan reference (absolute paths under `specs/`) and the list of changed files (absolute paths),
     - exact validation commands (unit/integration/manual checks),
     - expected artifacts (audit entries, snapshot_url, ack semantics), and
     - a pass/fail criterion per spec item.
   - The Validation Agent must return a concise `Validation Report` structured as: `Result / Changes / Validation / Next(optional)`.

2. The main agent must NOT mark the implementation todo as `completed` until the Validation Agent returns `Result: pass` or the user explicitly overrides.

3. If validation fails, the Validation Agent MUST list reproducible failure steps and suggested remediations. The main agent should then either:
   - re-delegate coding fixes to a coding agent (with a new todo), or
   - escalate for human review depending on `risk` and `needsApproval` metadata.

## Integration

- Add a `validation` step in the structured todo lifecycle: pending -> in_progress (coding) -> waitingOn=validation -> completed. The `waitingOn` must explicitly reference the validation task id.
- Log validation invocation as an audit event: `{ action: 'validation.invoked', request_id?, initiator, validator_subagent, timestamp }`.

## Example

1. Main agent delegates coding agent to implement A-phase changes.
2. On coding completion, main agent creates todo `tX-validation` and delegates a `review` agent with prompt containing specs and changed files.
3. `review` agent runs tests/manual checks and returns Validation Report.
4. If pass, mark `tX` as completed; if fail, create `tX-fix` and loop.

Document updated by: opencode autonomous governor
Date: 2026-03-16
