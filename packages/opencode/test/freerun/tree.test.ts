import { test, expect, describe } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import type { ContextNode, NodeMode } from "../../src/freerun/types"

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

/**
 * Build a tree like:
 *   root (decomposed)
 *   ├── a (decomposed)
 *   │   ├── a1 (pending-exec)
 *   │   └── a2 (done)
 *   ├── b (pending-plan)
 *   └── c (decomposed)
 *       └── c1 (pending-exec)
 */
async function buildSampleTree(sessionId: string, dataHome: string): Promise<void> {
  const nodes: ContextNode[] = [
    mkNode({ id: "root", children_ids: ["a", "b", "c"], mode: "decomposed" }),
    mkNode({ id: "a", parent_id: "root", children_ids: ["a1", "a2"], mode: "decomposed" }),
    mkNode({ id: "a1", parent_id: "a", mode: "pending-exec" }),
    mkNode({ id: "a2", parent_id: "a", mode: "done" }),
    mkNode({ id: "b", parent_id: "root", mode: "pending-plan" }),
    mkNode({ id: "c", parent_id: "root", children_ids: ["c1"], mode: "decomposed" }),
    mkNode({ id: "c1", parent_id: "c", mode: "pending-exec" }),
  ]
  for (const n of nodes) await NodeFS.write(sessionId, n, dataHome)
}

describe("freerun Tree", () => {
  test("load throws on empty session", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await expect(Tree.load("missing-session", tmp.path)).rejects.toThrow(/no nodes/)
  })

  test("load throws when no root present", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    // Single node but with non-null parent_id → no root.
    await NodeFS.write("s1", mkNode({ id: "orphan", parent_id: "ghost" }), tmp.path)
    await expect(Tree.load("s1", tmp.path)).rejects.toThrow(/no root/)
  })

  test("load rejects two roots", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await NodeFS.write("s2", mkNode({ id: "r1" }), tmp.path)
    await NodeFS.write("s2", mkNode({ id: "r2" }), tmp.path)
    await expect(Tree.load("s2", tmp.path)).rejects.toThrow(/multiple roots/)
  })

  test("load returns snapshot with correct root", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildSampleTree("sample", tmp.path)
    const snap = await Tree.load("sample", tmp.path)
    expect(snap.rootId).toBe("root")
    expect(Tree.size(snap)).toBe(7)
  })

  test("walkDFS preorder respects children_ids order", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildSampleTree("dfs", tmp.path)
    const snap = await Tree.load("dfs", tmp.path)
    const ids = Array.from(Tree.walkDFS(snap)).map((n) => n.id)
    expect(ids).toEqual(["root", "a", "a1", "a2", "b", "c", "c1"])
  })

  test("walkBFS yields by depth", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildSampleTree("bfs", tmp.path)
    const snap = await Tree.load("bfs", tmp.path)
    const layers = new Map<number, string[]>()
    for (const { node, depth } of Tree.walkBFS(snap)) {
      const arr = layers.get(depth) ?? []
      arr.push(node.id)
      layers.set(depth, arr)
    }
    expect(layers.get(0)).toEqual(["root"])
    expect(layers.get(1)).toEqual(["a", "b", "c"])
    expect(layers.get(2)?.sort()).toEqual(["a1", "a2", "c1"])
  })

  test("depthOf, ancestors, siblings, children, subtree", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildSampleTree("rel", tmp.path)
    const snap = await Tree.load("rel", tmp.path)

    expect(Tree.depthOf(snap, "root")).toBe(0)
    expect(Tree.depthOf(snap, "a1")).toBe(2)

    expect(Array.from(Tree.ancestors(snap, "a1")).map((n) => n.id)).toEqual(["a", "root"])
    expect(Array.from(Tree.ancestors(snap, "root")).map((n) => n.id)).toEqual([])

    expect(Tree.siblings(snap, "a1").map((n) => n.id)).toEqual(["a2"])
    expect(Tree.siblings(snap, "root")).toEqual([])

    expect(Tree.children(snap, "root").map((n) => n.id)).toEqual(["a", "b", "c"])
    expect(Tree.subtree(snap, "a").map((n) => n.id)).toEqual(["a", "a1", "a2"])
  })

  test("pickNext Phase A — picks shallowest pending-plan within depth bound", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildSampleTree("pa", tmp.path)
    const snap = await Tree.load("pa", tmp.path)
    // b is pending-plan at depth 1; topLevelsToPlan=3 → Phase A picks it.
    const picked = Tree.pickNext(snap, 3)
    expect(picked?.id).toBe("b")
  })

  test("pickNext Phase B — leftmost unfinished DFS preorder when no pending-plan in bound", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    // Tree where b is done, no pending-plan in bound.
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["a", "b"], mode: "decomposed" }),
      mkNode({ id: "a", parent_id: "root", children_ids: ["a1", "a2"], mode: "decomposed" }),
      mkNode({ id: "a1", parent_id: "a", mode: "pending-exec" }),
      mkNode({ id: "a2", parent_id: "a", mode: "pending-exec" }),
      mkNode({ id: "b", parent_id: "root", mode: "done" }),
    ]
    for (const n of nodes) await NodeFS.write("pb", n, tmp.path)
    const snap = await Tree.load("pb", tmp.path)
    const picked = Tree.pickNext(snap, 3)
    expect(picked?.id).toBe("a1") // leftmost unfinished
  })

  test("pickNext returns null when tree is fully settled", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await NodeFS.write("done", mkNode({ id: "root", mode: "done" }), tmp.path)
    const snap = await Tree.load("done", tmp.path)
    expect(Tree.pickNext(snap, 3)).toBeNull()
  })

  test("pickNext respects topLevelsToPlan bound", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    // Only a deep pending-plan; with bound=1 it should fall through to Phase B
    // (no exec-able node here either → returns the deep pending-plan via DFS unfinished).
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["a"], mode: "decomposed" }),
      mkNode({ id: "a", parent_id: "root", children_ids: ["a1"], mode: "decomposed" }),
      mkNode({ id: "a1", parent_id: "a", children_ids: ["a1x"], mode: "decomposed" }),
      mkNode({ id: "a1x", parent_id: "a1", mode: "pending-plan" }), // depth 3
    ]
    for (const n of nodes) await NodeFS.write("bound", n, tmp.path)
    const snap = await Tree.load("bound", tmp.path)
    // Phase A with bound=1 won't see depth-3 pending-plan; Phase B falls through to "leftmost unfinished".
    expect(Tree.pickNext(snap, 1)?.id).toBe("a1x")
    // With bound=3, Phase A picks it directly.
    expect(Tree.pickNext(snap, 3)?.id).toBe("a1x")
  })

  test("isSubtreeComplete + findByMode", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildSampleTree("modes", tmp.path)
    const snap = await Tree.load("modes", tmp.path)

    expect(Tree.isSubtreeComplete(snap, "a")).toBe(false) // a1 is pending-exec
    expect(Tree.findByMode(snap, "pending-plan" as NodeMode).map((n) => n.id)).toEqual(["b"])
    expect(Tree.findByMode(snap, "done" as NodeMode).map((n) => n.id)).toEqual(["a2"])
  })

  test("isSubtreeComplete: decomposed root with all-terminal children counts as settled", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["x", "y"], mode: "decomposed" }),
      mkNode({ id: "x", parent_id: "root", mode: "done" }),
      mkNode({ id: "y", parent_id: "root", mode: "blocked" }),
    ]
    for (const n of nodes) await NodeFS.write("complete", n, tmp.path)
    const snap = await Tree.load("complete", tmp.path)
    // root is decomposed (work delegated); all children terminal → consolidation can fire.
    expect(Tree.isSubtreeComplete(snap, "root")).toBe(true)
    expect(Tree.isSubtreeComplete(snap, "x")).toBe(true)
    expect(Tree.isSubtreeComplete(snap, "y")).toBe(true)
  })

  test("isSubtreeComplete: still actionable when a descendant is pending", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["x"], mode: "decomposed" }),
      mkNode({ id: "x", parent_id: "root", mode: "pending-exec" }),
    ]
    for (const n of nodes) await NodeFS.write("inflight", n, tmp.path)
    const snap = await Tree.load("inflight", tmp.path)
    expect(Tree.isSubtreeComplete(snap, "root")).toBe(false)
  })

  test("archiveSubtree moves descendants but leaves root in place", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    await buildSampleTree("arch", tmp.path)
    const snap = await Tree.load("arch", tmp.path)
    const stamp = "2026-05-26T22-30-00Z"
    const archived = await Tree.archiveSubtree(snap, "a", stamp, tmp.path)
    expect(archived.sort()).toEqual(["a1", "a2"])
    expect(await NodeFS.exists("arch", "a", tmp.path)).toBe(true) // root of subtree stays
    expect(await NodeFS.exists("arch", "a1", tmp.path)).toBe(false)
    expect(await NodeFS.exists("arch", "a2", tmp.path)).toBe(false)
    const stamps = await Tree.listArchiveStamps("arch", tmp.path)
    expect(stamps).toEqual([stamp])
  })

  test("stale children_ids references are tolerated by walks", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    // root references ghost which never exists.
    await NodeFS.write("stale", mkNode({ id: "root", children_ids: ["ghost", "real"] }), tmp.path)
    await NodeFS.write("stale", mkNode({ id: "real", parent_id: "root", mode: "pending-exec" }), tmp.path)
    const snap = await Tree.load("stale", tmp.path)
    const ids = Array.from(Tree.walkDFS(snap)).map((n) => n.id)
    expect(ids).toEqual(["root", "real"]) // ghost silently skipped
    expect(Tree.children(snap, "root").map((n) => n.id)).toEqual(["real"])
  })
})
