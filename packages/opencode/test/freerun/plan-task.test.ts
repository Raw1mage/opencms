import { describe, expect, test } from "bun:test"
import type { ContextNode } from "../../src/freerun/types"
import {
  buildPlanTaskSeedInput,
  evaluatePlanTaskCompletionGate,
  evaluatePlanTaskStopGate,
  parsePlanTaskCandidates,
  selectPlanTaskCandidate,
} from "../../src/freerun/plan-task"

describe("freerun plan-task admission", () => {
  const markdown = `# Tasks

- [x] 7.3 Already done
- [ ] 7.4 Add parser selector
  - acceptance: finds unchecked tasks
  - acceptance: preserves plan boundary
- [~] 7.5 Partial should not be admitted
- [ ] 7.6 Completion gate
`

  test("parses unchecked tasks only", () => {
    const candidates = parsePlanTaskCandidates({ markdown, planSlug: "harness_freerun-mode" })

    expect(candidates.map((candidate) => candidate.taskId)).toEqual(["7.4", "7.6"])
    expect(candidates[0]).toMatchObject({
      planSlug: "harness_freerun-mode",
      taskText: "Add parser selector",
      acceptanceCriteria: ["acceptance: finds unchecked tasks", "acceptance: preserves plan boundary"],
    })
  })

  test("selects by task id or text", () => {
    const candidates = parsePlanTaskCandidates({ markdown, planSlug: "harness_freerun-mode" })

    expect(selectPlanTaskCandidate(candidates, { taskId: "7.6" })?.taskText).toBe("Completion gate")
    expect(selectPlanTaskCandidate(candidates, { taskTextIncludes: "parser" })?.taskId).toBe("7.4")
    expect(selectPlanTaskCandidate(candidates)?.taskId).toBe("7.4")
  })

  test("builds seed input with plan-task goal binding", () => {
    const candidate = parsePlanTaskCandidates({ markdown, planSlug: "harness_freerun-mode" })[0]
    const seed = buildPlanTaskSeedInput(candidate)

    expect(seed.title).toBe("7.4 Add parser selector")
    expect(seed.body).toContain("Plan task harness_freerun-mode#7.4")
    expect(seed.goalBinding).toEqual({
      source: "plan-task",
      plan_slug: "harness_freerun-mode",
      task_id: "7.4",
      task_text: "Add parser selector",
      acceptance_criteria: ["acceptance: finds unchecked tasks", "acceptance: preserves plan boundary"],
    })
  })

  test("ticks source task only when root is done with validation evidence", () => {
    const root = mkNode({ mode: "done" })

    expect(evaluatePlanTaskCompletionGate(root, ["bun test passed"])).toEqual({
      kind: "tick",
      planSlug: "harness_freerun-mode",
      taskId: "7.4",
      validationEvidence: ["bun test passed"],
    })
    expect(evaluatePlanTaskCompletionGate(mkNode({ mode: "pending-exec" }), ["bun test passed"])).toEqual({
      kind: "wait",
      reason: "root-not-done",
    })
    expect(evaluatePlanTaskCompletionGate(root, [])).toEqual({
      kind: "wait",
      reason: "missing-validation-evidence",
    })
  })

  test("returns control for blocked decision or approval stops", () => {
    const root = mkNode({ mode: "decomposed" })

    expect(
      evaluatePlanTaskStopGate(root, [root, mkNode({ id: "a1", mode: "blocked", blockers: ["Need user decision"] })]),
    ).toEqual({
      kind: "return-control",
      stop: "decision",
      nodeId: "a1",
      message: "Need user decision",
    })
    expect(
      evaluatePlanTaskStopGate(root, [root, mkNode({ id: "a2", blockers: ["Requires approval before deploy"] })]),
    ).toEqual({
      kind: "return-control",
      stop: "approval",
      nodeId: "a2",
      message: "Requires approval before deploy",
    })
    expect(evaluatePlanTaskStopGate(root, [root, mkNode({ id: "a3", mode: "blocked" })])).toEqual({
      kind: "return-control",
      stop: "blocked",
      nodeId: "a3",
      message: "Blocked",
    })
  })
})

function mkNode(overrides: Partial<ContextNode> = {}): ContextNode {
  return {
    id: "root",
    parent_id: null,
    children_ids: [],
    title: "Plan task root",
    body: "",
    mode: "pending-plan",
    created_at: "2026-06-14T00:00:00.000Z",
    iteration_count: 0,
    observations: [],
    decisions: [],
    blockers: [],
    results: null,
    next_intent: "",
    consolidated_summary: null,
    goal_binding: {
      source: "plan-task",
      plan_slug: "harness_freerun-mode",
      task_id: "7.4",
      task_text: "Add parser selector",
      acceptance_criteria: [],
    },
    ...overrides,
  }
}
