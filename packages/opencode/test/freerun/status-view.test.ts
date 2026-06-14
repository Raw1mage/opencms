import { describe, expect, test } from "bun:test"
import { renderFreerunStatusView } from "../../src/freerun/status-view"
import type { ContextNode } from "../../src/freerun/types"

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

describe("renderFreerunStatusView", () => {
  test("renders current path projected todos and metrics", () => {
    const root = mkNode({ id: "root", children_ids: ["root.a1"], mode: "decomposed" })
    const child = mkNode({ id: "root.a1", parent_id: "root", title: "Implement", mode: "pending-exec" })
    const output = renderFreerunStatusView({
      sessionID: "status-session",
      tree: {
        sessionId: "status-session",
        rootId: "root",
        byId: new Map([
          [root.id, root],
          [child.id, child],
        ]),
      },
      projectedTodos: [
        {
          id: "freerun:root.a1",
          content: "root.a1 Implement",
          status: "in_progress",
          priority: "high",
        },
      ],
      metrics: {
        planningValidationFailures: 1,
        noMetaIcomRejects: 1,
        pickNextDecisions: 2,
        nodeTransitions: 3,
        consolidationEvents: 4,
        recentValidationErrors: ["missing meta-ICOM section"],
      },
    })

    expect(output).toContain("session: status-session")
    expect(output).toContain("current_path: root > root.a1")
    expect(output).toContain("- [in_progress] freerun:root.a1 root.a1 Implement")
    expect(output).toContain("- no_meta_icom_rejects: 1")
    expect(output).toContain("- missing meta-ICOM section")
  })
})
