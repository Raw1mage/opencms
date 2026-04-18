import { describe, expect, it } from "bun:test"
import { Session } from "./index"
import { Todo } from "./todo"
import {
  classifyResumeFailure,
  computeResumeBackoffMs,
  computeResumeRetryAt,
  describeAutonomousNextAction,
  evaluateAutonomousContinuation,
  planAutonomousNextAction,
  shouldInterruptAutonomousRun,
  buildContinuationTrigger,
  buildApiTrigger,
  type QueueEntry,
  type Lane,
  LANE_CONFIGS,
  LANES_BY_PRIORITY,
  triggerPriorityToLane,
  laneHasCapacity,
} from "./workflow-runner"

// Build a Session.Info without calling Session.defaultWorkflow() — when
// workflow-runner.test.ts runs alongside other session tests in the same
// bun process, the circular Session ↔ prompt ↔ workflow-runner import
// graph can leave Session.* undefined at module-load time. An inline
// literal side-steps the TDZ window.
function baseSession(overrides?: Partial<Session.Info>): Session.Info {
  return {
    id: "ses_1" as any,
    slug: "test",
    projectID: "proj_1",
    directory: "/tmp/test",
    title: "test",
    version: "local",
    time: { created: 1, updated: 1 },
    workflow: {
      autonomous: {
        enabled: true,
        stopOnTestsFail: true,
        requireApprovalFor: ["push", "destructive", "architecture_change"],
      },
      state: "waiting_user",
      updatedAt: 1,
      supervisor: {},
    },
    ...overrides,
  } as Session.Info
}

describe("planAutonomousNextAction", () => {
  it("stops subagent sessions — they are driven by the parent, not the runner", () => {
    const action = planAutonomousNextAction({
      session: { ...baseSession(), parentID: "parent_1" as any },
      todos: [{ id: "a", content: "x", status: "pending", priority: "high" }],
    })
    expect(action).toEqual({ type: "stop", reason: "subagent_session" })
  })

  it("continues with todo_pending when a pending todo exists", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [{ id: "a", content: "do it", status: "pending", priority: "high" }],
    })
    expect(action.type).toBe("continue")
    if (action.type === "continue") {
      expect(action.reason).toBe("todo_pending")
      expect(action.text).toContain("Continuation Gate")
      expect(action.todo.id).toBe("a")
    }
  })

  it("continues with todo_in_progress when an in_progress todo exists", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [{ id: "a", content: "working", status: "in_progress", priority: "high" }],
    })
    expect(action.type).toBe("continue")
    if (action.type === "continue") {
      expect(action.reason).toBe("todo_in_progress")
      expect(action.text).toContain("Continuation Gate")
    }
  })

  it("prefers in_progress over pending when both exist", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [
        { id: "a", content: "pending", status: "pending", priority: "high" },
        { id: "b", content: "in-progress", status: "in_progress", priority: "high" },
      ],
    })
    expect(action.type).toBe("continue")
    if (action.type === "continue") {
      expect(action.reason).toBe("todo_in_progress")
      expect(action.todo.id).toBe("b")
    }
  })

  it("fires completion-verify nudge once when todos drain and lastDecisionReason is not verify", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [{ id: "a", content: "done", status: "completed", priority: "high" }],
    })
    expect(action.type).toBe("continue")
    if (action.type === "continue") {
      expect(action.reason).toBe("completion_verify")
      expect(action.text).toContain("Continuation Gate")
      expect(action.todo.id).toBe("_runner_completion_verify")
    }
  })

  it("stops with todo_complete when AI did not update the todolist after verify", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [{ id: "a", content: "done", status: "completed", priority: "high" }],
      lastDecisionReason: "completion_verify",
    })
    expect(action).toEqual({ type: "stop", reason: "todo_complete" })
  })

  it("stops with todo_complete immediately when there are no todos at all and verify already fired", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [],
      lastDecisionReason: "completion_verify",
    })
    expect(action).toEqual({ type: "stop", reason: "todo_complete" })
  })

  it("fires verify the first time even on a session with no todos at all", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [],
    })
    expect(action.type).toBe("continue")
    if (action.type === "continue") expect(action.reason).toBe("completion_verify")
  })
})

describe("evaluateAutonomousContinuation", () => {
  it("wraps planAutonomousNextAction result in continue/stop form", () => {
    const decision = evaluateAutonomousContinuation({
      session: baseSession(),
      todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
    })
    expect(decision.continue).toBe(true)
    if (decision.continue) {
      expect(decision.reason).toBe("todo_pending")
      expect(decision.todo.id).toBe("a")
    }
  })

  it("returns stop form when planner says stop", () => {
    const decision = evaluateAutonomousContinuation({
      session: baseSession(),
      todos: [],
      lastDecisionReason: "completion_verify",
    })
    expect(decision).toEqual({ continue: false, reason: "todo_complete" })
  })
})

describe("describeAutonomousNextAction", () => {
  it("narrates continue with in-progress todo content", () => {
    expect(
      describeAutonomousNextAction({
        type: "continue",
        reason: "todo_in_progress",
        text: "_",
        todo: { id: "a", content: "finish it", status: "in_progress", priority: "high" },
      }),
    ).toEqual({ kind: "continue", text: "Runner continuing current step: finish it" })
  })

  it("narrates completion_verify distinctly", () => {
    expect(
      describeAutonomousNextAction({
        type: "continue",
        reason: "completion_verify",
        text: "_",
        todo: {
          id: "_runner_completion_verify",
          content: "verify",
          status: "pending",
          priority: "high",
        },
      }),
    ).toEqual({ kind: "continue", text: "Runner verifying completion before stopping." })
  })

  it("narrates todo_complete as complete", () => {
    expect(describeAutonomousNextAction({ type: "stop", reason: "todo_complete" })).toEqual({
      kind: "complete",
      text: "Runner complete: the current planned todo set is done.",
    })
  })

  it("narrates subagent_session stop", () => {
    expect(describeAutonomousNextAction({ type: "stop", reason: "subagent_session" })).toEqual({
      kind: "pause",
      text: "Autonomous continuation only runs for root sessions.",
    })
  })
})

describe("shouldInterruptAutonomousRun", () => {
  it("never interrupts if session is not busy", () => {
    expect(
      shouldInterruptAutonomousRun({
        session: baseSession(),
        status: { type: "idle" } as any,
        lastUserSynthetic: true,
        hasPendingContinuation: true,
      }),
    ).toBe(false)
  })

  it("never interrupts a subagent", () => {
    expect(
      shouldInterruptAutonomousRun({
        session: { ...baseSession(), parentID: "p" as any },
        status: { type: "busy" } as any,
        lastUserSynthetic: true,
        hasPendingContinuation: true,
      }),
    ).toBe(false)
  })

  it("interrupts busy root session when the previous user message was synthetic", () => {
    expect(
      shouldInterruptAutonomousRun({
        session: baseSession(),
        status: { type: "busy" } as any,
        lastUserSynthetic: true,
        hasPendingContinuation: false,
      }),
    ).toBe(true)
  })

  it("interrupts busy root session when a pending continuation is queued", () => {
    expect(
      shouldInterruptAutonomousRun({
        session: baseSession(),
        status: { type: "busy" } as any,
        lastUserSynthetic: false,
        hasPendingContinuation: true,
      }),
    ).toBe(true)
  })
})

describe("buildContinuationTrigger", () => {
  it("returns undefined when no todo supplied", () => {
    expect(
      buildContinuationTrigger({ todo: undefined, textForPending: "p", textForInProgress: "i" }),
    ).toBeUndefined()
  })

  it("returns in_progress trigger for in_progress todo", () => {
    const trigger = buildContinuationTrigger({
      todo: { id: "a", content: "x", status: "in_progress", priority: "high" },
      textForPending: "p",
      textForInProgress: "i",
    })
    expect(trigger?.source).toBe("todo_in_progress")
    expect(trigger?.payload.text).toBe("i")
  })

  it("returns pending trigger for pending todo", () => {
    const trigger = buildContinuationTrigger({
      todo: { id: "a", content: "x", status: "pending", priority: "high" },
      textForPending: "p",
      textForInProgress: "i",
    })
    expect(trigger?.source).toBe("todo_pending")
    expect(trigger?.payload.text).toBe("p")
  })

  it("returns undefined for completed todo", () => {
    expect(
      buildContinuationTrigger({
        todo: { id: "a", content: "x", status: "completed", priority: "high" },
        textForPending: "p",
        textForInProgress: "i",
      }),
    ).toBeUndefined()
  })
})

describe("buildApiTrigger", () => {
  it("builds an api trigger with defaults", () => {
    const trigger = buildApiTrigger({ source: "test", text: "go" })
    expect(trigger.type).toBe("api")
    expect(trigger.source).toBe("test")
    expect(trigger.priority).toBe("normal")
    expect(trigger.payload.text).toBe("go")
  })
})

describe("resume backoff + retry logic", () => {
  it("computeResumeBackoffMs grows exponentially with failures", () => {
    const b0 = computeResumeBackoffMs(0)
    const b1 = computeResumeBackoffMs(1)
    const b5 = computeResumeBackoffMs(5)
    expect(b0).toBeGreaterThanOrEqual(0)
    expect(b1).toBeGreaterThanOrEqual(b0)
    expect(b5).toBeGreaterThanOrEqual(b1)
  })

  it("computeResumeRetryAt returns a future time", () => {
    const retry = computeResumeRetryAt({
      now: 1_000,
      consecutiveFailures: 0,
      category: "transient" as any,
      budgetWaitTimeMs: 0,
    })
    expect(retry).toBeGreaterThan(1_000)
  })

  it("classifyResumeFailure labels errors with a category", () => {
    const c = classifyResumeFailure(new Error("boom"))
    expect(c.category).toBeDefined()
  })
})

describe("lane policy", () => {
  it("maps priority to lane", () => {
    expect(triggerPriorityToLane("critical")).toBe("critical" as Lane)
    expect(triggerPriorityToLane("normal")).toBe("normal" as Lane)
    expect(triggerPriorityToLane("background")).toBe("background" as Lane)
  })
})
