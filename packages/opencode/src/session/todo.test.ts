import { describe, expect, it } from "bun:test"
import { Todo } from "./todo"

describe("Session todo action metadata", () => {
  it("infers approval-gated actions from freeform todo content", () => {
    expect(Todo.inferActionFromContent({ content: "push release branch", status: "pending" })).toEqual({
      kind: "push",
      risk: "high",
      needsApproval: true,
    })

    expect(Todo.inferActionFromContent({ content: "delete old snapshots", status: "pending" })).toEqual({
      kind: "destructive",
      risk: "high",
      needsApproval: true,
    })

    expect(Todo.inferActionFromContent({ content: "schema migration refactor", status: "pending" })).toEqual({
      kind: "architecture_change",
      risk: "high",
      needsApproval: true,
    })
  })

  it("infers waiting and delegation actions for autonomous planning", () => {
    expect(Todo.inferActionFromContent({ content: "waiting on subagent review", status: "pending" })).toEqual({
      kind: "wait",
      waitingOn: "subagent",
    })

    expect(Todo.inferActionFromContent({ content: "delegate API audit to subagent", status: "pending" })).toEqual({
      kind: "delegate",
      canDelegate: true,
    })
  })

  it("enriches todos with inferred action metadata when missing", () => {
    expect(
      Todo.enrichAll([
        { id: "a", content: "push release branch", status: "pending", priority: "high" },
        { id: "b", content: "implement settings panel", status: "in_progress", priority: "medium" },
      ]),
    ).toEqual([
      {
        id: "a",
        content: "push release branch",
        status: "pending",
        priority: "high",
        action: { kind: "push", risk: "high", needsApproval: true },
      },
      {
        id: "b",
        content: "implement settings panel",
        status: "in_progress",
        priority: "medium",
        action: { kind: "implement", canDelegate: undefined },
      },
    ])
  })

  it("persists enriched action metadata through Todo.update and Todo.get", async () => {
    const sessionID = "session_todo_action_enrich"
    await Todo.update({
      sessionID,
      todos: [{ id: "a", content: "push release branch", status: "pending", priority: "high" }],
    })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "push release branch",
        status: "pending",
        priority: "high",
        action: { kind: "push", risk: "high", needsApproval: true },
      },
    ])
  })

  it("promotes the next dependency-ready todo after linked task completion", async () => {
    const sessionID = "session_todo_reconcile_success"
    await Todo.update({
      sessionID,
      todos: [
        { id: "a", content: "delegate API audit", status: "in_progress", priority: "high" },
        {
          id: "b",
          content: "implement fixes",
          status: "pending",
          priority: "high",
          action: { kind: "implement", dependsOn: ["a"] },
        },
      ],
    })

    await Todo.reconcileProgress({ sessionID, linkedTodoID: "a", taskStatus: "completed" })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "delegate API audit",
        status: "completed",
        priority: "high",
        action: { kind: "delegate", canDelegate: true },
      },
      {
        id: "b",
        content: "implement fixes",
        status: "in_progress",
        priority: "high",
        action: { kind: "implement", dependsOn: ["a"] },
      },
    ])
  })

  it("marks linked todo as waiting on subagent when task errors", async () => {
    const sessionID = "session_todo_reconcile_error"
    await Todo.update({
      sessionID,
      todos: [{ id: "a", content: "delegate API audit", status: "in_progress", priority: "high" }],
    })

    await Todo.reconcileProgress({ sessionID, linkedTodoID: "a", taskStatus: "error" })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "delegate API audit",
        status: "in_progress",
        priority: "high",
        action: { kind: "delegate", canDelegate: true, waitingOn: "subagent" },
      },
    ])
  })

  it("keeps linked todo in progress when subagent returns to parent for review", async () => {
    const sessionID = "session_todo_reconcile_returned"
    await Todo.update({
      sessionID,
      todos: [
        {
          id: "a",
          content: "delegate API audit",
          status: "in_progress",
          priority: "high",
          action: { kind: "delegate", canDelegate: true, waitingOn: "subagent" },
        },
        {
          id: "b",
          content: "implement fixes",
          status: "pending",
          priority: "high",
          action: { kind: "implement", dependsOn: ["a"] },
        },
      ],
    })

    await Todo.reconcileProgress({ sessionID, linkedTodoID: "a", taskStatus: "returned" })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "delegate API audit",
        status: "in_progress",
        priority: "high",
        action: { kind: "delegate", canDelegate: true },
      },
      {
        id: "b",
        content: "implement fixes",
        status: "pending",
        priority: "high",
        action: { kind: "implement", dependsOn: ["a"] },
      },
    ])
  })

  it("can promote a host-adopted replan target into the next in-progress todo", () => {
    const result = Todo.applyHostAdoptedReplan(
      [
        { id: "a", content: "original next step", status: "pending", priority: "high" },
        { id: "b", content: "reprioritized fix", status: "pending", priority: "high" },
      ],
      {
        targetTodoID: "b",
        proposedAction: "replan_todos",
        policy: {
          adoptionMode: "host_adoptable",
          requiresUserConfirm: false,
          requiresHostReview: true,
        },
      },
    )

    expect(result).toEqual({
      adopted: true,
      adoptedTodoID: "b",
      reason: "adopted",
      todos: [
        {
          id: "a",
          content: "original next step",
          status: "pending",
          priority: "high",
          action: { kind: "implement", canDelegate: true },
        },
        {
          id: "b",
          content: "reprioritized fix",
          status: "in_progress",
          priority: "high",
          action: { kind: "implement", canDelegate: true },
        },
      ],
    })
  })

  it("refuses host-adopted replans that would bypass user confirmation or gated work", () => {
    expect(
      Todo.applyHostAdoptedReplan([{ id: "a", content: "push release", status: "pending", priority: "high" }], {
        targetTodoID: "a",
        proposedAction: "replan_todos",
        policy: {
          adoptionMode: "host_adoptable",
          requiresUserConfirm: false,
          requiresHostReview: true,
        },
      }).reason,
    ).toBe("approval_gate")

    expect(
      Todo.applyHostAdoptedReplan([{ id: "a", content: "safe next step", status: "pending", priority: "high" }], {
        targetTodoID: "a",
        proposedAction: "replan_todos",
        policy: {
          adoptionMode: "host_adoptable",
          requiresUserConfirm: true,
          requiresHostReview: true,
        },
      }).reason,
    ).toBe("user_confirm_required")

    expect(
      Todo.applyHostAdoptedReplan(
        [
          { id: "a", content: "current work", status: "in_progress", priority: "high" },
          { id: "b", content: "safe next step", status: "pending", priority: "high" },
        ],
        {
          targetTodoID: "b",
          proposedAction: "replan_todos",
          policy: {
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        },
      ).reason,
    ).toBe("active_todo_in_progress")
  })

  it("can adopt a host-proposed todo completion for the current actionable todo", () => {
    const result = Todo.applyHostAdoptedCompletion(
      [{ id: "a", content: "finish current slice", status: "in_progress", priority: "high" }],
      {
        targetTodoID: "a",
        proposedAction: "mark_todo_complete",
        policy: {
          adoptionMode: "host_adoptable",
          requiresUserConfirm: false,
          requiresHostReview: true,
        },
      },
    )

    expect(result).toEqual({
      adopted: true,
      adoptedTodoID: "a",
      reason: "adopted",
      todos: [
        {
          id: "a",
          content: "finish current slice",
          status: "completed",
          priority: "high",
          action: { kind: "implement", canDelegate: undefined },
        },
      ],
    })
  })

  it("refuses host-proposed todo completion when the target is not the current actionable work", () => {
    expect(
      Todo.applyHostAdoptedCompletion(
        [
          { id: "a", content: "current work", status: "in_progress", priority: "high" },
          { id: "b", content: "other pending work", status: "pending", priority: "high" },
        ],
        {
          targetTodoID: "b",
          proposedAction: "mark_todo_complete",
          policy: {
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        },
      ).reason,
    ).toBe("target_not_active")
  })

  it("preserves completed todos when a follow-up plan rewrites overlapping items", async () => {
    const sessionID = "session_todo_merge_completed_preserved"
    await Todo.update({
      sessionID,
      todos: [
        {
          id: "a",
          content: "read restart docs and confirm scope",
          status: "completed",
          priority: "high",
        },
        { id: "b", content: "implement restart API", status: "completed", priority: "high" },
        { id: "c", content: "validate restart flow", status: "in_progress", priority: "high" },
      ],
    })

    await Todo.update({
      sessionID,
      todos: [
        { id: "a", content: "read restart docs and confirm scope", status: "pending", priority: "high" },
        { id: "b", content: "implement restart API", status: "pending", priority: "high" },
        { id: "c", content: "validate restart flow", status: "pending", priority: "high" },
        { id: "d", content: "update event sync notes", status: "pending", priority: "medium" },
      ],
    })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "read restart docs and confirm scope",
        status: "completed",
        priority: "high",
        action: { kind: "implement", canDelegate: undefined },
      },
      {
        id: "b",
        content: "implement restart API",
        status: "completed",
        priority: "high",
        action: { kind: "implement", canDelegate: undefined },
      },
      {
        id: "c",
        content: "validate restart flow",
        status: "in_progress",
        priority: "high",
        action: { kind: "implement", canDelegate: undefined },
      },
      {
        id: "d",
        content: "update event sync notes",
        status: "pending",
        priority: "medium",
        action: { kind: "implement", canDelegate: true },
      },
    ])
  })

  it("reprojects todo structure from planner seed while preserving matching progress", async () => {
    const sessionID = "session_todo_plan_seed_projection"
    await Todo.update({
      sessionID,
      mode: "replan_adoption",
      todos: [
        { id: "old", content: "stale leftover item", status: "pending", priority: "low" },
        { id: "a", content: "active seeded item", status: "in_progress", priority: "high" },
      ],
    })

    await Todo.update({
      sessionID,
      mode: "plan_materialization",
      todos: [
        { id: "a", content: "active seeded item", status: "pending", priority: "high" },
        { id: "b", content: "new planner item", status: "pending", priority: "medium" },
      ],
    })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "active seeded item",
        status: "in_progress",
        priority: "high",
        action: { kind: "implement", canDelegate: undefined },
      },
      {
        id: "b",
        content: "new planner item",
        status: "pending",
        priority: "medium",
        action: { kind: "implement", canDelegate: true },
      },
    ])
  })

  it("status_update changes progress without altering todo structure", async () => {
    const sessionID = "session_todo_status_overlay_only"
    await Todo.update({
      sessionID,
      mode: "plan_materialization",
      todos: [
        { id: "a", content: "seeded item", status: "in_progress", priority: "high" },
        { id: "b", content: "next item", status: "pending", priority: "medium" },
      ],
    })

    await Todo.update({
      sessionID,
      mode: "status_update",
      todos: [
        { id: "a", content: "seeded item", status: "completed", priority: "high" },
        { id: "c", content: "should not be added by status update", status: "pending", priority: "low" },
      ],
    })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "seeded item",
        status: "completed",
        priority: "high",
        action: { kind: "implement", canDelegate: undefined },
      },
      {
        id: "b",
        content: "next item",
        status: "pending",
        priority: "medium",
        action: { kind: "implement", canDelegate: true },
      },
    ])
  })

  it("preserves cancelled todos when overlapping plans are rewritten", async () => {
    const sessionID = "session_todo_merge_cancelled_preserved"
    await Todo.update({
      sessionID,
      todos: [
        { id: "a", content: "obsolete path", status: "cancelled", priority: "low" },
        { id: "b", content: "active path", status: "in_progress", priority: "high" },
      ],
    })

    await Todo.update({
      sessionID,
      todos: [
        { id: "a", content: "obsolete path", status: "pending", priority: "low" },
        { id: "b", content: "active path", status: "pending", priority: "high" },
      ],
    })

    await expect(Todo.get(sessionID)).resolves.toEqual([
      {
        id: "a",
        content: "obsolete path",
        status: "cancelled",
        priority: "low",
        action: { kind: "implement", canDelegate: undefined },
      },
      {
        id: "b",
        content: "active path",
        status: "in_progress",
        priority: "high",
        action: { kind: "implement", canDelegate: undefined },
      },
    ])
  })
})
