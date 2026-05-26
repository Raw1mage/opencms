import { test, expect, describe } from "bun:test"
import * as path from "path"
import { tmpdir } from "../fixture/fixture"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import { Consolidate } from "../../src/freerun/runtime/consolidate"
import {
  ExperimentConfig,
  sessionStorageDir,
  type ContextNode,
  type ExperimentConfig as ExperimentConfigT,
} from "../../src/freerun/types"

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

function mockSummarizer(handler: (req: any) => Promise<string> | string) {
  const calls: any[] = []
  return {
    calls,
    client: {
      async summarize(req: any) {
        calls.push(req)
        return await handler(req)
      },
    },
  }
}

describe("freerun Consolidate", () => {
  test("noop when subtree not complete (actionable descendant exists)", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "cs-inflight"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["x"], mode: "decomposed" }),
      mkNode({ id: "x", parent_id: "root", mode: "pending-exec" }),
    ]
    for (const n of nodes) await NodeFS.write(sessionId, n, tmp.path)

    const sum = mockSummarizer(() => "should not be called")
    const r = await Consolidate.consolidate({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: sum.client, seedNodeId: "x",
    })
    expect(r.consolidatedCount).toBe(0)
    expect(sum.calls.length).toBe(0)
  })

  test("consolidates a one-level-deep decomposed subtree", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "cs-onelevel"
    const nodes: ContextNode[] = [
      mkNode({
        id: "root",
        title: "Implement node-fs",
        body: "Atomic writes for ContextNode.",
        children_ids: ["root.a", "root.b"],
        mode: "decomposed",
      }),
      mkNode({
        id: "root.a", parent_id: "root", title: "atomic write helper",
        mode: "done",
        observations: ["Bun.write + rename pattern works"],
        results: { fn: "writeAtomic" },
      }),
      mkNode({
        id: "root.b", parent_id: "root", title: "read helper",
        mode: "done",
        observations: ["read uses Bun.file.text()"],
      }),
    ]
    for (const n of nodes) await NodeFS.write(sessionId, n, tmp.path)

    const sum = mockSummarizer((req) => {
      expect(req.parent.id).toBe("root")
      expect(req.children.length).toBe(2)
      expect(req.maxTokens).toBe(defaultConfig().summary_token_cap_consolidation)
      return "Implemented node-fs with atomic write + read helpers."
    })

    const r = await Consolidate.consolidate({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: sum.client, seedNodeId: "root.b",
      nowIso: () => "2026-05-26T23-30-00Z",
    })
    expect(r.consolidatedCount).toBe(1)
    expect(r.archiveStamp).toBeDefined()
    expect(sum.calls.length).toBe(1)

    // Re-load: children archived, root now done with summary.
    const snap = await Tree.load(sessionId, tmp.path)
    const root = Tree.get(snap, "root")
    expect(root.mode).toBe("done")
    expect(root.consolidated_summary).toBe("Implemented node-fs with atomic write + read helpers.")
    expect(root.children_ids).toEqual([])
    expect(snap.byId.size).toBe(1) // only root remains

    // Verify archived files exist.
    expect(await NodeFS.exists(sessionId, "root.a", tmp.path)).toBe(false)
    expect(await NodeFS.exists(sessionId, "root.b", tmp.path)).toBe(false)
    const archiveDir = path.join(sessionStorageDir(sessionId, tmp.path), "tree", ".archive", r.archiveStamp!)
    expect(await Bun.file(path.join(archiveDir, "root.a.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(archiveDir, "root.b.md")).exists()).toBe(true)
  })

  test("recurses upward when grandparent also becomes complete", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "cs-recurse"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["a"], mode: "decomposed" }),
      mkNode({ id: "a", parent_id: "root", children_ids: ["a1"], mode: "decomposed" }),
      mkNode({ id: "a1", parent_id: "a", mode: "done" }),
    ]
    for (const n of nodes) await NodeFS.write(sessionId, n, tmp.path)

    const sum = mockSummarizer((req) => `summary of ${req.parent.id}`)
    const r = await Consolidate.consolidate({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: sum.client, seedNodeId: "a1",
    })
    // a (single done child) → done; then root (single done child a) → done.
    expect(r.consolidatedCount).toBe(2)
    expect(sum.calls.map((c) => c.parent.id)).toEqual(["a", "root"])
    const snap = await Tree.load(sessionId, tmp.path)
    expect(Tree.get(snap, "root").mode).toBe("done")
    expect(Tree.get(snap, "root").consolidated_summary).toBe("summary of root")
    expect(snap.byId.size).toBe(1)
  })

  test("stops walking when an ancestor has other actionable siblings", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "cs-stop"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["a", "b"], mode: "decomposed" }),
      mkNode({ id: "a", parent_id: "root", children_ids: ["a1"], mode: "decomposed" }),
      mkNode({ id: "a1", parent_id: "a", mode: "done" }),
      mkNode({ id: "b", parent_id: "root", mode: "pending-exec" }), // keeps root non-settled
    ]
    for (const n of nodes) await NodeFS.write(sessionId, n, tmp.path)

    const sum = mockSummarizer((req) => `s:${req.parent.id}`)
    const r = await Consolidate.consolidate({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: sum.client, seedNodeId: "a1",
    })
    // a consolidates; root stops because b is still actionable.
    expect(r.consolidatedCount).toBe(1)
    expect(sum.calls.length).toBe(1)
    expect(sum.calls[0].parent.id).toBe("a")
    const snap = await Tree.load(sessionId, tmp.path)
    expect(Tree.get(snap, "root").mode).toBe("decomposed")
    expect(Tree.get(snap, "a").mode).toBe("done")
    expect(Tree.get(snap, "b").mode).toBe("pending-exec")
  })

  test("non-decomposed seed walks to parent before considering candidate", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "cs-leaf"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["x"], mode: "decomposed" }),
      mkNode({ id: "x", parent_id: "root", mode: "done" }), // leaf
    ]
    for (const n of nodes) await NodeFS.write(sessionId, n, tmp.path)
    const sum = mockSummarizer(() => "rolled up")
    // Seed is a leaf (mode=done, not decomposed); engine should still consolidate root.
    const r = await Consolidate.consolidate({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: sum.client, seedNodeId: "x",
    })
    expect(r.consolidatedCount).toBe(1)
    expect(sum.calls[0].parent.id).toBe("root")
  })

  test("LLM failure leaves subtree untouched and returns count=0", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "cs-llm-fail"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["x"], mode: "decomposed" }),
      mkNode({ id: "x", parent_id: "root", mode: "done" }),
    ]
    for (const n of nodes) await NodeFS.write(sessionId, n, tmp.path)
    const sum = mockSummarizer(() => { throw new Error("LLM down") })
    const r = await Consolidate.consolidate({
      sessionId, dataHome: tmp.path, config: defaultConfig(),
      llm: sum.client, seedNodeId: "x",
    })
    expect(r.consolidatedCount).toBe(0)
    // root and x both still on disk.
    expect(await NodeFS.exists(sessionId, "root", tmp.path)).toBe(true)
    expect(await NodeFS.exists(sessionId, "x", tmp.path)).toBe(true)
    const snap = await Tree.load(sessionId, tmp.path)
    expect(Tree.get(snap, "root").mode).toBe("decomposed") // not flipped to done
  })
})
