import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import { NavigationBand } from "../../src/freerun/render/navigation-band"
import { NodeDetail } from "../../src/freerun/render/node-detail"
import { PromptTemplate } from "../../src/freerun/render/prompt-template"
import { ToolFilter } from "../../src/freerun/render/tool-filter"
import type { ContextNode } from "../../src/freerun/types"

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

async function buildPathTree(sessionId: string, dataHome: string) {
  // root → a → a1 (current), with sibling a2 (consolidated) and b (sibling of a)
  const nodes: ContextNode[] = [
    mkNode({
      id: "root",
      title: "Build the storage layer",
      body: "Implement freerun-mode's per-node markdown store and tree ops.",
      children_ids: ["a", "b"],
      mode: "decomposed",
    }),
    mkNode({
      id: "a",
      parent_id: "root",
      title: "node-fs",
      body: "Per-node atomic writes.",
      children_ids: ["a1", "a2"],
      mode: "decomposed",
    }),
    mkNode({
      id: "a1",
      parent_id: "a",
      title: "Atomic write helper",
      body: "Write tempfile, rename to target.",
      mode: "pending-exec",
      iteration_count: 1,
      observations: ["temp pattern picked: <target>.<pid>.<ts>.tmp"],
      decisions: [{ decision: "use Bun.write + fs.rename", rationale: "matches existing config.ts atomic pattern" }],
      next_intent: "implement archive helper next",
      relevant_tools: ["read", "edit"],
    }),
    mkNode({
      id: "a2",
      parent_id: "a",
      title: "Read helper",
      mode: "done",
      consolidated_summary: "Implemented read() with ContextNode.parse validation. 11 tests pass.",
    }),
    mkNode({
      id: "b",
      parent_id: "root",
      title: "tree.ts",
      body: "Tree-level operations over nodes.",
      mode: "pending-plan",
    }),
  ]
  for (const n of nodes) await NodeFS.write(sessionId, n, dataHome)
}

// ============================================================================
// NavigationBand
// ============================================================================

describe("freerun NavigationBand", () => {
  test("policy=off returns empty string", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildPathTree("nav-off", tmp.path)
    const snap = await Tree.load("nav-off", tmp.path)
    const r = NavigationBand.render(snap, "a1", { policy: "off", tokenBudget: 500 })
    expect(r.text).toBe("")
    expect(r.approxTokens).toBe(0)
    expect(r.trimmed).toBe(false)
  })

  test("policy=minimal includes root title + parent → current line", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildPathTree("nav-min", tmp.path)
    const snap = await Tree.load("nav-min", tmp.path)
    const r = NavigationBand.render(snap, "a1", { policy: "minimal", tokenBudget: 500 })
    expect(r.text).toContain("Build the storage layer")
    expect(r.text).toContain("node-fs → Atomic write helper")
  })

  test("policy=parent-only emits goal + path but no siblings section", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildPathTree("nav-po", tmp.path)
    const snap = await Tree.load("nav-po", tmp.path)
    const r = NavigationBand.render(snap, "a1", { policy: "parent-only", tokenBudget: 500 })
    expect(r.text).toContain("# Goal (root)")
    expect(r.text).toContain("# Path to current node")
    expect(r.text).not.toContain("# Siblings")
  })

  test("policy=full emits all three sections including sibling summary", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildPathTree("nav-full", tmp.path)
    const snap = await Tree.load("nav-full", tmp.path)
    const r = NavigationBand.render(snap, "a1", { policy: "full", tokenBudget: 500 })
    expect(r.text).toContain("# Goal (root)")
    expect(r.text).toContain("# Path to current node")
    expect(r.text).toContain("# Siblings")
    expect(r.text).toContain("Read helper")
    expect(r.text).toContain("Implemented read()") // consolidated_summary surfaces
  })

  test("token budget enforcement trims when over", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    // Build a tree with a HUGE root body and many siblings, then check trim.
    const bigBody = "x".repeat(2000)
    await NodeFS.write(
      "nav-tight",
      mkNode({ id: "root", title: "Huge", body: bigBody, children_ids: ["a", "b", "c"], mode: "decomposed" }),
      tmp.path,
    )
    await NodeFS.write(
      "nav-tight",
      mkNode({ id: "a", parent_id: "root", title: "current", mode: "pending-exec" }),
      tmp.path,
    )
    await NodeFS.write(
      "nav-tight",
      mkNode({ id: "b", parent_id: "root", title: "sibB", body: "y".repeat(400), mode: "doing", next_intent: "z".repeat(400) }),
      tmp.path,
    )
    await NodeFS.write(
      "nav-tight",
      mkNode({ id: "c", parent_id: "root", title: "sibC", consolidated_summary: "w".repeat(400), mode: "done" }),
      tmp.path,
    )
    const snap = await Tree.load("nav-tight", tmp.path)
    const r = NavigationBand.render(snap, "a", { policy: "full", tokenBudget: 100 }) // ~400 char budget
    expect(r.trimmed).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(400 + 10) // small slack for truncation marker
  })
})

// ============================================================================
// NodeDetail
// ============================================================================

describe("freerun NodeDetail", () => {
  test("includes id, title, mode, iteration_count headers", () => {
    const node = mkNode({ id: "x.y", title: "Test", mode: "pending-exec", iteration_count: 5 })
    const r = NodeDetail.render(node)
    expect(r.text).toContain("**id**: `x.y`")
    expect(r.text).toContain("**title**: Test")
    expect(r.text).toContain("**mode**: `pending-exec`")
    expect(r.text).toContain("**iteration_count**: 5")
  })

  test("renders observations/decisions/blockers/results/next_intent sections", () => {
    const node = mkNode({
      observations: ["obs1", "obs2"],
      decisions: [{ decision: "use Foo", rationale: "Bar reason" }],
      blockers: ["waiting on net"],
      results: { value: 42 },
      next_intent: "do the next thing",
    })
    const r = NodeDetail.render(node)
    expect(r.text).toContain("## Observations\n- obs1\n- obs2")
    expect(r.text).toContain("- **use Foo**")
    expect(r.text).toContain("rationale: Bar reason")
    expect(r.text).toContain("## Blockers\n- waiting on net")
    expect(r.text).toContain('"value": 42')
    expect(r.text).toContain("## Last iteration's next_intent\ndo the next thing")
  })

  test("omits empty sections", () => {
    const node = mkNode() // all empty
    const r = NodeDetail.render(node)
    expect(r.text).not.toContain("## Observations")
    expect(r.text).not.toContain("## Decisions")
    expect(r.text).not.toContain("## Blockers")
    expect(r.text).not.toContain("## Results")
    expect(r.text).not.toContain("Last iteration's next_intent")
  })

  test("renders relevant_tools / relevant_skills when present", () => {
    const node = mkNode({ relevant_tools: ["bash", "read"], relevant_skills: ["doc-workflow"] })
    const r = NodeDetail.render(node)
    expect(r.text).toContain("**relevant_tools**: bash, read")
    expect(r.text).toContain("**relevant_skills**: doc-workflow")
  })

  test("renders plan task binding when present", () => {
    const node = mkNode({
      goal_binding: {
        source: "plan-task",
        plan_slug: "freerun-icom",
        task_id: "T1",
        task_text: "Implement safeguards",
        acceptance_criteria: [],
      },
    })
    const r = NodeDetail.render(node)
    expect(r.text).toContain("**goal_source**: plan-task")
    expect(r.text).toContain("**plan_task**: freerun-icom#T1")
  })
})

// ============================================================================
// PromptTemplate
// ============================================================================

describe("freerun PromptTemplate", () => {
  test("planning mode emits PlanningOutcome schema name + planning charge", () => {
    const out = PromptTemplate.render({
      navBandText: "# Goal (root)\nFoo",
      nodeDetailText: "# Current node\n...",
      mode: "planning",
      strictness: "medium",
    })
    expect(out.responseSchemaName).toBe("PlanningOutcome")
    expect(out.systemPrompt).toContain("MODE: planning")
    expect(out.systemPrompt).toContain("decompose")
    expect(out.systemPrompt).toContain("conversation-goal")
    expect(out.systemPrompt).toContain("runtime commit protocol")
    expect(out.userMessage).toContain("# Goal (root)")
    expect(out.userMessage).toContain("# Current node")
    expect(out.userMessage).toContain("PlanningOutcome JSON")
  })

  test("execution mode emits ExecutionOutcome schema + tool charge", () => {
    const out = PromptTemplate.render({
      navBandText: "",
      nodeDetailText: "# Current node\n...",
      mode: "execution",
      strictness: "medium",
    })
    expect(out.responseSchemaName).toBe("ExecutionOutcome")
    expect(out.systemPrompt).toContain("MODE: execution")
    expect(out.systemPrompt).toContain("observations")
    expect(out.systemPrompt).toContain("next_mode")
  })

  test("strictness=strict tightens schema-only language; loose relaxes it", () => {
    const strict = PromptTemplate.render({
      navBandText: "",
      nodeDetailText: "x",
      mode: "execution",
      strictness: "strict",
    })
    const loose = PromptTemplate.render({
      navBandText: "",
      nodeDetailText: "x",
      mode: "execution",
      strictness: "loose",
    })
    expect(strict.systemPrompt).toContain("ONLY a JSON object")
    expect(loose.systemPrompt).toContain("matching the response schema")
    expect(loose.systemPrompt).not.toContain("ONLY a JSON object")
  })

  test("responseSchema is structurally a JSON schema with required field", () => {
    const out = PromptTemplate.render({
      navBandText: "",
      nodeDetailText: "x",
      mode: "planning",
      strictness: "medium",
    })
    const schema = out.responseSchema as { type?: string; required?: string[]; properties?: Record<string, unknown> }
    expect(schema.type).toBe("object")
    expect(schema.required).toContain("children")
    expect(schema.properties?.children).toBeDefined()
  })
})

// ============================================================================
// ToolFilter
// ============================================================================

describe("freerun ToolFilter", () => {
  const catalog = [
    { name: "bash" },
    { name: "read" },
    { name: "edit" },
    { name: "grep" },
  ]

  test("undefined relevant_tools → full catalog passes through", () => {
    const r = ToolFilter.filter(catalog, { relevantTools: undefined })
    expect(r.tools.length).toBe(4)
    expect(r.suppressAll).toBe(false)
    expect(r.unknown).toEqual([])
  })

  test("empty relevant_tools array → suppressAll=true, no tools returned", () => {
    const r = ToolFilter.filter(catalog, { relevantTools: [] })
    expect(r.tools).toEqual([])
    expect(r.suppressAll).toBe(true)
  })

  test("filtered catalog respects relevant_tools order", () => {
    const r = ToolFilter.filter(catalog, { relevantTools: ["grep", "bash"] })
    expect(r.tools.map((t) => t.name)).toEqual(["grep", "bash"])
    expect(r.suppressAll).toBe(false)
    expect(r.unknown).toEqual([])
  })

  test("unknown tool names are reported via callback and excluded from result", () => {
    const unknownCalls: string[] = []
    const r = ToolFilter.filter(catalog, {
      relevantTools: ["bash", "ghost", "edit", "nope"],
      onUnknown: (n) => unknownCalls.push(n),
    })
    expect(r.tools.map((t) => t.name)).toEqual(["bash", "edit"])
    expect(r.unknown).toEqual(["ghost", "nope"])
    expect(unknownCalls).toEqual(["ghost", "nope"])
  })
})
