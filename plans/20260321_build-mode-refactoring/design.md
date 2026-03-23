# Design

## Context

- The current build-mode runtime already has some real authority through mission approval and continuation control.
- Recent beta-workflow wiring added reusable guidance text and a dedicated skill, but real-world behavior showed that stronger wording does not create stable obedience.
- The user proposed a stronger admission strategy: require the model to answer a bounded execution-contract quiz before build-mode proceeds.
- The user also explicitly judged broad hard-guard engineering as low-value for now because it risks turning into a huge rule-based matrix across many scenarios.
- A concrete product bug was found while trying to kick off build from plan mode: `plan_exit` exists in code but is not exposed in web runtime because tool registration is gated to `app|cli|desktop`, while the real product surface runs as per-user daemon + webapp.

## Goals / Non-Goals

**Goals:**
- Introduce a high-confidence admission gate for beta-sensitive execution.
- Use deterministic answer checking rather than heuristic prose interpretation.
- Reduce prompt redundancy once quiz guard exists.
- Keep future hard-guard work explicitly deferred unless later evidence justifies it.

**Non-Goals:**
- Removing all build-mode narration.
- Building a large rule-based downstream hard-guard framework in the current slice.
- Allowing unlimited retries that dilute the value of calibration.

## Decisions

- Quiz guard becomes the primary admission mechanism for beta-sensitive build entry.
- Quiz schema should be structured and bounded, not freeform.
- Expected answers must come from `mission.beta` and authoritative mainline metadata.
- Wrong answers produce explicit mismatch evidence; the model gets one reflection-based retry, and repeated failure escalates to user clarification.
- Prompt/skill/MCP surfaces remain useful but are classified as advisory support only.
- Broad hard-guard expansion is deferred until empirical evidence shows quiz guard leaves a meaningful uncovered failure mode.

## Data / State / Control Flow

- Planner approval produces mission metadata, including beta context where applicable.
- Before beta-sensitive build-mode execution proceeds, runtime generates the expected answer key from mission/mainline metadata.
- LLM returns a structured quiz response.
- Runtime compares each field against the expected answer key.
- Any mismatch -> reject admission and stop.
- Full match -> allow progression to normal build-mode execution.
- After quiz coverage exists, build-mode narration is reduced to minimal state/stop text.
- Residual failures, if observed later, become inputs to a narrower follow-up hard-guard design rather than preemptive rule explosion.

## Risks / Trade-offs

- If quiz schema is too open-ended, validation becomes fuzzy -> mitigate by requiring fixed structured fields.
- If retries are unlimited, the model can brute-force calibration -> mitigate by allowing only one reflection-based retry.
- If mission metadata is incomplete, expected answers cannot be generated -> mitigate by treating missing metadata as a hard stop.
- Deferring hard guards may leave some rare uncovered failures -> mitigate by instrumenting quiz outcomes and only designing targeted guards from real evidence.

## Critical Files

- `packages/opencode/src/session/workflow-runner.ts`
- `packages/opencode/src/session/prompt/runner.txt`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/session/trigger.ts`
- `packages/opencode/src/session/workflow-runner.test.ts`
- `packages/opencode/test/session/bootstrap-policy.test.ts`
