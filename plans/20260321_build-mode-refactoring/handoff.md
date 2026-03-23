# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding.
- Materialize tasks.md into runtime todos before coding.
- Implement the quiz admission gate before deleting or shrinking old prompt wording.
- Treat prompt/skill/MCP surfaces as advisory only.
- Defer broad hard-guard expansion unless validation produces a concrete uncovered failure that justifies a narrow follow-up guard.

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md
- specs/architecture.md
- docs/events/event_20260323_beta_workflow_skill.md

## Current State

- The active plan root existed only as template placeholders before the recent planning pass.
- A beta-workflow skill and related builder wiring already landed, but the user has now clarified that guidance surfaces are not a reliable enforcement strategy.
- The current requirement revision makes quiz guard the primary builder admission mechanism and explicitly defers broad hard-guard expansion.
- The retry policy is now fixed: one reflection-based retry is allowed; repeated failure must stop and ask the user.
- The next build step is to define the exact quiz schema and insertion point, then reduce prompt redundancy.

## Stop Gates In Force

- Stop if quiz evaluation cannot be made deterministic from current mission/mainline metadata.
- Stop if implementation requires heuristic judging of open-ended answers.
- Stop if the implementation starts drifting toward a broad rule-engine instead of the agreed quiz-first slice.
- Stop and ask the user if the model still fails the quiz after the allowed retry.

## Build Entry Recommendation

- Start with Task 1.1–1.3: define the quiz fields, answer key source, pass/fail evaluator, and retry policy before editing runtime flow.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
