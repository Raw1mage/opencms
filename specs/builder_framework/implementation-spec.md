# Implementation Spec

## Goal

- Refactor build-mode so beta-sensitive execution first passes a structured quiz guard admission gate, while redundant hardcoded workflow prompting is reduced and broad hard-guard rule engines are explicitly deferred.

## Scope

### IN

- Introduce a builder admission quiz that tests whether the LLM can restate the authoritative execution contract before build-mode proceeds.
- Use exact or canonicalized answer matching against mission metadata to decide whether build entry is allowed.
- Reduce builder-owned prompt/workflow wording once quiz guard coverage exists.
- Update plan artifacts so implementation can proceed from the quiz-first model.

### OUT

- Building a large rule-based hard-guard framework for many downstream execution scenarios in this slice.
- Replacing the entire autorunner or planner architecture.
- Relying on open-ended natural language self-report without machine-checkable answer validation.
- Inventing fallback mechanisms when the quiz fails or metadata is invalid.

## Assumptions

- Existing `mission.beta` metadata remains the durable source of truth for beta execution context.
- The repo should preserve the current rule that `/plans`, `/specs`, and `docs/events` stay on the authoritative main repo/worktree, but dedicated hard enforcement for every downstream path can be deferred.
- The LLM will reliably answer a bounded admission quiz, and incorrect answers provide high-signal evidence that the session is not calibrated.
- If quiz guard resolves the vast majority of observed workflow drift, the system does not need to pay the complexity cost of a large hard-guard matrix immediately.

## Stop Gates

- Stop if existing mission metadata is insufficient to produce deterministic expected answers.
- Stop if the planned quiz format cannot be validated deterministically without heuristic judging.
- Stop if implementation pressure starts pulling this slice back into a broad rule-based hard-guard system.
- Re-enter planning if later evidence shows quiz guard alone is insufficient and a narrower hard-guard subset must be designed.

## Critical Files

- `packages/opencode/src/session/workflow-runner.ts`
- `packages/opencode/src/session/prompt/runner.txt`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/mission-consumption.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/trigger.ts`
- `packages/opencode/test/session/bootstrap-policy.test.ts`
- `packages/opencode/src/session/workflow-runner.test.ts`
- `specs/architecture.md`
- `docs/events/event_20260323_beta_workflow_skill.md`

## Structured Execution Phases

- Phase 1: audit current builder/build-mode authority surfaces and define the quiz guard schema, timing, answer validation contract, bounded retry policy, and rejection/escalation behavior.
- Phase 2: implement builder admission quiz for beta-sensitive build entry and first continuation, using mission metadata as the authoritative answer key.
- Phase 3: shrink redundant hardcoded workflow prompting so runtime text becomes minimal state/stop narration rather than pseudo-enforcement.
- Phase 4: validate quiz pass/fail behavior, non-beta compatibility, and documentation alignment.
- Phase 5: document deferred hard-guard candidates only if residual gaps remain after quiz validation.

## Validation

- Targeted tests for quiz guard pass on correct mission-aligned answers.
- Targeted tests for quiz guard rejection/escalation on incorrect main repo / base branch / implementation repo / implementation branch / docs write repo answers after the allowed reflection retry.
- Focused review confirming prompt text is no longer the primary enforcement layer.
- Focused validation confirming beta-sensitive entry remains stable when the quiz passes.
- Architecture/event documentation updated to reflect quiz-first authority.

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must implement the admission quiz before deleting or shrinking old prompt wording.
- Build agent must allow reflection-based retry after an incorrect answer; if the model still cannot answer correctly, the flow must stop and ask the user.
- Build agent must defer broad hard-guard expansion unless quiz validation proves a concrete remaining gap.
