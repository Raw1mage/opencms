import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import { PickNext } from "../../src/freerun/policy/pick-next"
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

describe("freerun PickNext (policy wrapper)", () => {
  test("returns {kind:'settled'} on fully terminal tree", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await NodeFS.write("s", mkNode({ id: "root", mode: "done" }), tmp.path)
    const snap = await Tree.load("s", tmp.path)
    expect(PickNext.pick(snap, { top_levels_to_plan: 3 })).toEqual({ kind: "settled" })
  })

  test("returns {kind:'node', node} on actionable tree", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await NodeFS.write("s", mkNode({ id: "root", mode: "pending-plan" }), tmp.path)
    const snap = await Tree.load("s", tmp.path)
    const out = PickNext.pick(snap, { top_levels_to_plan: 3 })
    expect(out.kind).toBe("node")
    if (out.kind === "node") expect(out.node.id).toBe("root")
  })

  test("top_levels_to_plan threads through to Tree.pickNext", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["a"], mode: "decomposed" }),
      mkNode({ id: "a", parent_id: "root", children_ids: ["a1"], mode: "decomposed" }),
      mkNode({ id: "a1", parent_id: "a", mode: "pending-plan" }), // depth 2
    ]
    for (const n of nodes) await NodeFS.write("t", n, tmp.path)
    const snap = await Tree.load("t", tmp.path)
    // With bound=1, depth-2 pending-plan falls outside Phase A but caught by Phase B as actionable.
    const tight = PickNext.pick(snap, { top_levels_to_plan: 1 })
    expect(tight.kind === "node" && tight.node.id).toBe("a1")
    // With bound=3, Phase A picks the same node directly.
    const loose = PickNext.pick(snap, { top_levels_to_plan: 3 })
    expect(loose.kind === "node" && loose.node.id).toBe("a1")
  })
})
