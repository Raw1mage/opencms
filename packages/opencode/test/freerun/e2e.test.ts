import { describe, expect, test } from "bun:test"
import { Engine } from "../../src/freerun/runtime/engine"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import { FreerunTodoProjection } from "../../src/freerun/todo-projection"
import {
  buildPlanTaskSeedInput,
  evaluatePlanTaskCompletionGate,
  parsePlanTaskCandidates,
  selectPlanTaskCandidate,
} from "../../src/freerun/plan-task"
import {
  ExperimentConfig,
  hashExperimentConfig,
  type ContextNode,
  type ExperimentConfig as ExperimentConfigT,
} from "../../src/freerun/types"
import { tmpdir } from "../fixture/fixture"

describe("freerun Phase 7E e2e", () => {
  test("conversation goal seeds A0, decomposes A1/A2/A3, executes leaves, and refreshes projection", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "phase7e-goal"
    await NodeFS.write(
      sessionId,
      mkNode({
        id: "root",
        title: "A0 goal",
        body: "Decompose into A1/A2/A3 then complete tiny leaves.",
        goal_binding: { source: "conversation-goal", goal_text: "Decompose into A1/A2/A3 then complete tiny leaves." },
      }),
      tmp.path,
    )

    const config = defaultConfig()
    const summary = await Engine.run({
      sessionId,
      dataHome: tmp.path,
      config,
      llm: scriptedLlm(),
      toolCatalog: [],
      providerId: "test-provider",
      userId: "test-user",
      triggerMode: "goal",
      rootNodeId: "root",
      experimentConfigId: hashExperimentConfig(config),
      iterationCapOverride: 5,
    })

    expect(summary.finalStatus).toBe("done")
    expect(summary.totalIterations).toBe(4)

    const tree = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(tree, "root")
    expect(root.mode).toBe("done")
    expect(root.children_ids).toEqual([])
    expect(root.consolidated_summary).toContain("A1/A2/A3 complete")

    const todos = FreerunTodoProjection.project(tree)
    expect(todos).toEqual([
      expect.objectContaining({ id: "freerun:root", status: "completed", content: "root A0 goal" }),
    ])
  })

  test("plan-task seed completes subtree and ticks only with validation evidence", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "phase7e-plan-task"
    const candidate = selectPlanTaskCandidate(
      parsePlanTaskCandidates({
        planSlug: "harness_freerun-mode",
        markdown: `# Tasks\n\n- [ ] 7.16 Run plan-task e2e\n  - validation evidence required\n`,
      }),
      { taskId: "7.16" },
    )!
    const seed = buildPlanTaskSeedInput(candidate)
    await NodeFS.write(
      sessionId,
      mkNode({ id: "root", title: seed.title, body: seed.body, goal_binding: seed.goalBinding }),
      tmp.path,
    )

    const config = defaultConfig()
    await Engine.run({
      sessionId,
      dataHome: tmp.path,
      config,
      llm: scriptedLlm(),
      toolCatalog: [],
      providerId: "test-provider",
      userId: "test-user",
      triggerMode: "goal",
      rootNodeId: "root",
      experimentConfigId: hashExperimentConfig(config),
      iterationCapOverride: 5,
    })

    const tree = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(tree, "root")
    expect(evaluatePlanTaskCompletionGate(root, [])).toEqual({
      kind: "wait",
      reason: "missing-validation-evidence",
    })
    expect(
      evaluatePlanTaskCompletionGate(root, ["bun test packages/opencode/test/freerun/e2e.test.ts passed"]),
    ).toEqual({
      kind: "tick",
      planSlug: "harness_freerun-mode",
      taskId: "7.16",
      validationEvidence: ["bun test packages/opencode/test/freerun/e2e.test.ts passed"],
    })
  })
})

function defaultConfig(): ExperimentConfigT {
  return ExperimentConfig.parse({})
}

function mkNode(overrides: Partial<ContextNode> = {}): ContextNode {
  return {
    id: "root",
    parent_id: null,
    children_ids: [],
    title: "root",
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
    ...overrides,
  }
}

function scriptedLlm() {
  return {
    async callPlanning() {
      return {
        children: [
          { id: "a1", title: "A1 plan", body: "Complete A1.", mode: "pending-exec" as const },
          { id: "a2", title: "A2 implement", body: "Complete A2.", mode: "pending-exec" as const },
          { id: "a3", title: "A3 validate", body: "Complete A3.", mode: "pending-exec" as const },
        ],
      }
    },
    async callExecution() {
      return {
        toolCallCount: 0,
        finalContent: JSON.stringify({
          observations: ["leaf completed"],
          decisions: [],
          blockers: [],
          results: { ok: true },
          next_intent: "done",
          next_mode: "done",
        }),
      }
    },
    async summarize() {
      return "A1/A2/A3 complete with validation evidence."
    },
  }
}
