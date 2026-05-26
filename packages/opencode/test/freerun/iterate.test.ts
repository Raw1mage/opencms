import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import { Iterate } from "../../src/freerun/runtime/iterate"
import { ExperimentConfig, type ContextNode, type ExperimentConfig as ExperimentConfigT } from "../../src/freerun/types"

function mkNode(overrides: Partial<ContextNode> = {}): ContextNode {
  return {
    id: "root",
    parent_id: null,
    children_ids: [],
    title: "node",
    body: "",
    mode: "pending-plan",
    created_at: "2026-05-26T22:00:00.000Z",
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

function defaultConfig(): ExperimentConfigT {
  return ExperimentConfig.parse({})
}

const TOOL_CATALOG = [{ name: "bash" }, { name: "read" }, { name: "edit" }]

/** Mock LlmClient — records calls + returns programmable responses. */
function mockLlm(handlers: {
  planning?: (req: any) => Promise<any> | any
  execution?: (req: any) => Promise<any> | any
}) {
  const planningCalls: any[] = []
  const executionCalls: any[] = []
  return {
    planningCalls,
    executionCalls,
    client: {
      async callPlanning(req: any) {
        planningCalls.push(req)
        if (!handlers.planning) throw new Error("planning handler not configured")
        return await handlers.planning(req)
      },
      async callExecution(req: any) {
        executionCalls.push(req)
        if (!handlers.execution) throw new Error("execution handler not configured")
        return await handlers.execution(req)
      },
    },
  }
}

describe("freerun Iterate.once — planning path", () => {
  test("planning iteration writes children + flips parent to decomposed", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-plan"
    await NodeFS.write(sessionId, mkNode({ id: "root", body: "Build the storage layer" }), tmp.path)

    const llm = mockLlm({
      planning: () => ({
        children: [
          { id: "root.a", title: "Design", body: "Sketch the API.", mode: "pending-exec" },
          { id: "root.b", title: "Implement", body: "Code it up.", mode: "pending-plan" },
        ],
      }),
    })

    const result = await Iterate.once({
      sessionId,
      dataHome: tmp.path,
      config: defaultConfig(),
      llm: llm.client,
      toolCatalog: TOOL_CATALOG,
      nowIso: () => "2026-05-26T23:00:00.000Z",
    })

    expect(result.kind).toBe("advanced")
    expect(llm.planningCalls.length).toBe(1)
    expect(llm.executionCalls.length).toBe(0)

    const snap = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(snap, "root")
    expect(root.mode).toBe("decomposed")
    expect(root.children_ids).toEqual(["root.a", "root.b"])
    expect(root.iteration_count).toBe(1)

    const a = Tree.get(snap, "root.a")
    expect(a.title).toBe("Design")
    expect(a.parent_id).toBe("root")
    expect(a.mode).toBe("pending-exec")

    const b = Tree.get(snap, "root.b")
    expect(b.mode).toBe("pending-plan")
  })

  test("planning request carries server-enforced schema (responseSchema present)", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-plan-schema"
    await NodeFS.write(sessionId, mkNode({ id: "root" }), tmp.path)
    const llm = mockLlm({
      planning: () => ({ children: [{ id: "root.x", title: "x", body: "" }] }),
    })
    await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(llm.planningCalls[0].responseSchema).toBeDefined()
    expect(llm.planningCalls[0].responseSchemaName).toBe("PlanningOutcome")
    expect(llm.planningCalls[0].systemPrompt).toContain("MODE: planning")
  })

  test("planning failure blocks the node with reason", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-plan-fail"
    await NodeFS.write(sessionId, mkNode({ id: "root" }), tmp.path)
    const llm = mockLlm({
      planning: () => { throw new Error("LLM 5xx") },
    })
    const result = await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
      nowIso: () => "2026-05-26T23:00:00.000Z",
    })
    expect(result.kind).toBe("blocked")
    if (result.kind === "blocked") expect(result.reason).toContain("LLM 5xx")

    const snap = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(snap, "root")
    expect(root.mode).toBe("blocked")
    expect(root.blockers[0]).toContain("LLM 5xx")
  })

  test("planning child id auto-namespaced when LLM emits bare id", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-plan-ns"
    await NodeFS.write(sessionId, mkNode({ id: "root" }), tmp.path)
    const llm = mockLlm({
      planning: () => ({ children: [{ id: "leaf", title: "L", body: "" }] }),
    })
    await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    const snap = await Tree.load(sessionId, tmp.path)
    expect(Tree.get(snap, "root").children_ids).toEqual(["root.leaf"])
  })
})

describe("freerun Iterate.once — execution path (Option D)", () => {
  test("execution iteration writes outcome + advances mode based on next_mode", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec"
    await NodeFS.write(sessionId, mkNode({ id: "root", mode: "pending-exec", body: "List /tmp" }), tmp.path)

    const llm = mockLlm({
      execution: () => ({
        toolCallCount: 1,
        finalContent: JSON.stringify({
          observations: ["ran ls /tmp", "saw 3 files"],
          decisions: [{ decision: "use ls", rationale: "simplest tool for the job" }],
          blockers: [],
          results: { files: ["a", "b", "c"] },
          next_intent: "done",
          next_mode: "done",
        }),
      }),
    })

    const result = await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
      nowIso: () => "2026-05-26T23:00:00.000Z",
    })

    expect(result.kind).toBe("advanced")
    if (result.kind === "advanced") expect(result.mode).toBe("execution")

    const snap = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(snap, "root")
    expect(root.mode).toBe("done")
    expect(root.observations).toEqual(["ran ls /tmp", "saw 3 files"])
    expect(root.decisions.length).toBe(1)
    expect(root.results).toEqual({ files: ["a", "b", "c"] })
    expect(root.next_intent).toBe("done")
    expect(root.iteration_count).toBe(1)
  })

  test("execution preserves prior observations (append, not replace)", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec-append"
    await NodeFS.write(
      sessionId,
      mkNode({
        id: "root",
        mode: "pending-exec",
        observations: ["prior obs from earlier iteration"],
        decisions: [{ decision: "earlier dec", rationale: "earlier rationale" }],
      }),
      tmp.path,
    )
    const llm = mockLlm({
      execution: () => ({
        toolCallCount: 0,
        finalContent: JSON.stringify({
          observations: ["new obs"],
          decisions: [],
          blockers: [],
          results: null,
          next_intent: "still going",
          next_mode: "pending-plan", // surprise → re-plan
        }),
      }),
    })
    await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    const snap = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(snap, "root")
    expect(root.observations).toEqual(["prior obs from earlier iteration", "new obs"])
    expect(root.decisions.length).toBe(1) // earlier preserved
    expect(root.mode).toBe("pending-plan") // re-plan flip
  })

  test("execution tolerates fenced ```json block", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec-fenced"
    await NodeFS.write(sessionId, mkNode({ id: "root", mode: "pending-exec" }), tmp.path)
    const validJson = JSON.stringify({
      observations: [],
      decisions: [],
      blockers: [],
      results: null,
      next_intent: "",
      next_mode: "done",
    })
    const llm = mockLlm({
      execution: () => ({ toolCallCount: 0, finalContent: `Sure, here's the result:\n\n\`\`\`json\n${validJson}\n\`\`\`\n` }),
    })
    const result = await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(result.kind).toBe("advanced")
    const snap = await Tree.load(sessionId, tmp.path)
    expect(Tree.get(snap, "root").mode).toBe("done")
  })

  test("execution retries once on first-attempt JSON parse failure", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec-retry"
    await NodeFS.write(sessionId, mkNode({ id: "root", mode: "pending-exec" }), tmp.path)
    let calls = 0
    const llm = mockLlm({
      execution: () => {
        calls++
        if (calls === 1) return { toolCallCount: 0, finalContent: "not valid json, sorry" }
        return {
          toolCallCount: 0,
          finalContent: JSON.stringify({
            observations: ["recovered"],
            decisions: [],
            blockers: [],
            results: null,
            next_intent: "",
            next_mode: "done",
          }),
        }
      },
    })
    const result = await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(result.kind).toBe("advanced")
    expect(llm.executionCalls.length).toBe(2)
    expect(llm.executionCalls[1].userMessage).toContain("Retry — output format violation")
    const snap = await Tree.load(sessionId, tmp.path)
    expect(Tree.get(snap, "root").observations).toEqual(["recovered"])
  })

  test("execution blocks node after 2 consecutive parse failures", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec-block"
    await NodeFS.write(sessionId, mkNode({ id: "root", mode: "pending-exec" }), tmp.path)
    const llm = mockLlm({
      execution: () => ({ toolCallCount: 0, finalContent: "garbage" }),
    })
    const result = await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(result.kind).toBe("blocked")
    expect(llm.executionCalls.length).toBe(2) // first + retry
    const snap = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(snap, "root")
    expect(root.mode).toBe("blocked")
    expect(root.blockers.some((b) => b.includes("did not parse"))).toBe(true)
  })

  test("execution tool-filter: undefined relevant_tools sends full catalog", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec-tools-full"
    await NodeFS.write(sessionId, mkNode({ id: "root", mode: "pending-exec" }), tmp.path)
    const llm = mockLlm({
      execution: () => ({
        toolCallCount: 0,
        finalContent: JSON.stringify({
          observations: [], decisions: [], blockers: [], results: null, next_intent: "", next_mode: "done",
        }),
      }),
    })
    await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(llm.executionCalls[0].tools.length).toBe(3)
    expect(llm.executionCalls[0].toolsSuppressed).toBe(false)
  })

  test("execution tool-filter: empty relevant_tools suppresses tools (think-only)", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec-tools-empty"
    await NodeFS.write(
      sessionId,
      mkNode({ id: "root", mode: "pending-exec", relevant_tools: [] }),
      tmp.path,
    )
    const llm = mockLlm({
      execution: () => ({
        toolCallCount: 0,
        finalContent: JSON.stringify({
          observations: [], decisions: [], blockers: [], results: null, next_intent: "", next_mode: "done",
        }),
      }),
    })
    await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(llm.executionCalls[0].tools).toEqual([])
    expect(llm.executionCalls[0].toolsSuppressed).toBe(true)
  })

  test("execution tool-filter: relevant_tools subset preserves order", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-exec-tools-subset"
    await NodeFS.write(
      sessionId,
      mkNode({ id: "root", mode: "pending-exec", relevant_tools: ["read", "bash"] }),
      tmp.path,
    )
    const llm = mockLlm({
      execution: () => ({
        toolCallCount: 0,
        finalContent: JSON.stringify({
          observations: [], decisions: [], blockers: [], results: null, next_intent: "", next_mode: "done",
        }),
      }),
    })
    await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(llm.executionCalls[0].tools.map((t: any) => t.name)).toEqual(["read", "bash"])
  })
})

describe("freerun Iterate.once — settled / scheduler edges", () => {
  test("returns settled when tree is fully terminal", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "iter-settled"
    await NodeFS.write(sessionId, mkNode({ id: "root", mode: "done" }), tmp.path)
    const llm = mockLlm({})
    const result = await Iterate.once({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: llm.client, toolCatalog: TOOL_CATALOG,
    })
    expect(result.kind).toBe("settled")
    expect(llm.planningCalls.length + llm.executionCalls.length).toBe(0)
  })
})
