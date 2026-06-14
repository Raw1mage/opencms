import { describe, expect, test } from "bun:test"
import { NodeFS } from "../../src/freerun/storage/node-fs"
import { Tree } from "../../src/freerun/storage/tree"
import { FreerunTodoProjection } from "../../src/freerun/todo-projection"
import type { ContextNode } from "../../src/freerun/types"
import { tmpdir } from "../fixture/fixture"

function mkNode(overrides: Partial<ContextNode> = {}): ContextNode {
  return {
    id: "root",
    parent_id: null,
    children_ids: [],
    title: "Root",
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

describe("FreerunTodoProjection", () => {
  test("projects top-level ICOM nodes into visible todos", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "todo-projection"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", title: "A0", children_ids: ["root.a1", "root.a2", "root.a3"], mode: "decomposed" }),
      mkNode({ id: "root.a1", parent_id: "root", title: "探查現況", mode: "done" }),
      mkNode({ id: "root.a2", parent_id: "root", title: "修改實作", mode: "pending-plan" }),
      mkNode({ id: "root.a3", parent_id: "root", title: "驗證", mode: "pending-exec" }),
    ]
    for (const node of nodes) await NodeFS.write(sessionId, node, tmp.path)
    const tree = await Tree.load(sessionId, tmp.path)
    const todos = FreerunTodoProjection.project(tree)
    expect(todos.map((todo) => todo.content)).toEqual(["root.a1 探查現況", "root.a2 修改實作", "root.a3 驗證"])
    expect(todos.map((todo) => todo.status)).toEqual(["completed", "in_progress", "pending"])
  })

  test("projects active branch children without dumping the whole tree", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "todo-projection-active-branch"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["root.a1", "root.a2"], mode: "decomposed" }),
      mkNode({ id: "root.a1", parent_id: "root", title: "Done branch", mode: "done" }),
      mkNode({
        id: "root.a2",
        parent_id: "root",
        title: "Active branch",
        children_ids: ["root.a2.b1", "root.a2.b2"],
        mode: "decomposed",
      }),
      mkNode({ id: "root.a2.b1", parent_id: "root.a2", title: "Current leaf", mode: "pending-exec" }),
      mkNode({ id: "root.a2.b2", parent_id: "root.a2", title: "Sibling leaf", mode: "pending-exec" }),
      mkNode({ id: "root.a2.b1.c1", parent_id: "root.a2.b1", title: "Too deep", mode: "pending-exec" }),
    ]
    for (const node of nodes) await NodeFS.write(sessionId, node, tmp.path)
    const tree = await Tree.load(sessionId, tmp.path)
    const todos = FreerunTodoProjection.project(tree)

    expect(todos.map((todo) => todo.id)).toEqual([
      "freerun:root.a1",
      "freerun:root.a2",
      "freerun:root.a2.b1",
      "freerun:root.a2.b2",
    ])
    expect(todos.some((todo) => todo.id === "freerun:root.a2.b1.c1")).toBe(false)
  })

  test("distinguishes blocked decision and approval stops", async () => {
    await using tmp = await tmpdir({ init: async () => {} })
    const sessionId = "todo-projection-stops"
    const nodes: ContextNode[] = [
      mkNode({ id: "root", children_ids: ["root.a1", "root.a2", "root.a3"], mode: "decomposed" }),
      mkNode({ id: "root.a1", parent_id: "root", title: "Blocked", mode: "blocked" }),
      mkNode({
        id: "root.a2",
        parent_id: "root",
        title: "Decision",
        mode: "blocked",
        blockers: ["Need user decision"],
      }),
      mkNode({ id: "root.a3", parent_id: "root", title: "Approval", mode: "blocked", blockers: ["Requires approval"] }),
    ]
    for (const node of nodes) await NodeFS.write(sessionId, node, tmp.path)
    const tree = await Tree.load(sessionId, tmp.path)
    const todos = FreerunTodoProjection.project(tree)

    expect(todos.map((todo) => todo.status)).toEqual(["blocked", "decision", "approval"])
    expect(todos.map((todo) => todo.action?.kind)).toEqual(["wait", "decision", "approval"])
  })
})
