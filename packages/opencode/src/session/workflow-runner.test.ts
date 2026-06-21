import { describe, expect, it } from "bun:test"
import { Session } from "./index"
import { Todo } from "./todo"
import {
  classifyResumeFailure,
  computeResumeBackoffMs,
  computeResumeRetryAt,
  describeAutonomousNextAction,
  evaluateAutonomousContinuation,
  isAutonomousApprovalGated,
  isGateSuspended,
  inspectPendingContinuationResumability,
  shouldResumePendingContinuation,
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
        enabled: false,
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

function armedSession(overrides?: Partial<Session.Info>): Session.Info {
  const session = baseSession(overrides)
  const workflow = session.workflow!
  session.workflow = {
    ...workflow,
    autonomous: {
      ...workflow.autonomous,
      enabled: true,
    },
  }
  return session
}

describe("autonomous approval gate (harness/autonomous-gate-enforcement DD-1/DD-2)", () => {
  const gatedTodo = (overrides?: Partial<Todo.Info>): Todo.Info => ({
    id: "g",
    content: "delete old snapshots",
    status: "pending",
    priority: "high",
    action: { kind: "destructive", risk: "high", needsApproval: true },
    ...overrides,
  })

  it("TV-1: suspends (approval_required) before entering a requireApprovalFor step", () => {
    const action = planAutonomousNextAction({ session: armedSession(), todos: [gatedTodo()] })
    expect(action).toEqual({ type: "stop", reason: "approval_required" })
  })

  it("TV-3: empty requireApprovalFor is genuinely live — no suspend, continues", () => {
    const session = armedSession()
    session.workflow!.autonomous.requireApprovalFor = []
    const action = planAutonomousNextAction({ session, todos: [gatedTodo()] })
    expect(action.type).toBe("continue")
  })

  it("TV-4: an explicit awaiting_approval handback suspends even with no other actionable todo", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [{ id: "h", content: "ship it", status: "awaiting_approval", priority: "high" }],
    })
    expect(action).toEqual({ type: "stop", reason: "approval_required" })
  })

  it("does NOT gate an ordinary implement step (no false suspend)", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [
        { id: "a", content: "implement the parser", status: "in_progress", priority: "high", action: { kind: "implement" } },
      ],
    })
    expect(action.type).toBe("continue")
  })

  it("isAutonomousApprovalGated: handback status > policy match > ungated", () => {
    const workflow = armedSession().workflow!
    expect(isAutonomousApprovalGated({ todos: [gatedTodo()], current: gatedTodo(), workflow })).toBe(true)
    expect(
      isAutonomousApprovalGated({
        todos: [{ id: "x", content: "ok", status: "awaiting_approval", priority: "high" }],
        current: undefined,
        workflow,
      }),
    ).toBe(true)
    expect(
      isAutonomousApprovalGated({
        todos: [{ id: "y", content: "do", status: "pending", priority: "high", action: { kind: "implement" } }],
        current: { id: "y", content: "do", status: "pending", priority: "high", action: { kind: "implement" } },
        workflow,
      }),
    ).toBe(false)
  })

  it("describeAutonomousNextAction narrates approval_required as a pause", () => {
    expect(describeAutonomousNextAction({ type: "stop", reason: "approval_required" }).kind).toBe("pause")
  })

  it("TV-7: isGateSuspended is true for gate-induced state, false otherwise (DD-4)", () => {
    const waiting = armedSession().workflow!
    waiting.state = "waiting_user"
    waiting.stopReason = "approval_needed"
    // workflow parked on the approval gate
    expect(isGateSuspended({ workflow: waiting, todos: [] })).toBe(true)
    // an explicit awaiting_approval todo, regardless of workflow state
    expect(
      isGateSuspended({
        workflow: armedSession().workflow!,
        todos: [{ id: "h", content: "ship", status: "awaiting_approval", priority: "high" }],
      }),
    ).toBe(true)
    // a genuine no-gate spin: running, no awaiting_approval → NOT gate-suspended
    // (so the paralysis ladder still applies — backstop preserved, TV-8)
    const running = armedSession().workflow!
    running.state = "running"
    running.stopReason = undefined
    expect(
      isGateSuspended({
        workflow: running,
        todos: [{ id: "a", content: "loop", status: "in_progress", priority: "high" }],
      }),
    ).toBe(false)
    // waiting_user but a DIFFERENT stopReason (e.g. plan_drained) is not the gate
    const other = armedSession().workflow!
    other.state = "waiting_user"
    other.stopReason = "plan_drained"
    expect(isGateSuspended({ workflow: other, todos: [] })).toBe(false)
  })
})

describe("planAutonomousNextAction", () => {
  it("stops immediately when autorun is not armed", () => {
    const action = planAutonomousNextAction({
      session: baseSession(),
      todos: [{ id: "a", content: "do it", status: "pending", priority: "high" }],
    })
    expect(action).toEqual({ type: "stop", reason: "not_armed" })
  })

  it("stops subagent sessions — they are driven by the parent, not the runner", () => {
    const action = planAutonomousNextAction({
      session: { ...baseSession(), parentID: "parent_1" as any },
      todos: [{ id: "a", content: "x", status: "pending", priority: "high" }],
    })
    expect(action).toEqual({ type: "stop", reason: "subagent_session" })
  })

  it("continues with todo_pending when a pending todo exists", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [{ id: "a", content: "do it", status: "pending", priority: "high" }],
    })
    expect(action.type).toBe("continue")
    if (action.type === "continue") {
      expect(action.reason).toBe("todo_pending")
      expect(action.text).toContain("Continue with the current work")
      expect(action.todo.id).toBe("a")
    }
  })

  it("continues with todo_in_progress when an in_progress todo exists", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [{ id: "a", content: "working", status: "in_progress", priority: "high" }],
    })
    expect(action.type).toBe("continue")
    if (action.type === "continue") {
      expect(action.reason).toBe("todo_in_progress")
      expect(action.text).toContain("Continue with the current work")
    }
  })

  it("prefers in_progress over pending when both exist", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
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

  it("stops with todo_complete when todos drain", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [{ id: "a", content: "done", status: "completed", priority: "high" }],
    })
    expect(action).toEqual({ type: "stop", reason: "todo_complete" })
  })

  it("stops with todo_complete when there are no todos at all", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [],
    })
    expect(action).toEqual({ type: "stop", reason: "todo_complete" })
  })

  it("drives freerun engine when armed with an active root", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [],
      freerunState: "active",
    })
    expect(action).toEqual({ type: "continue", reason: "freerun_active", text: "Drive the freerun ContextNode engine." })
  })

  it("stops instead of inventing a freerun goal when no root exists", () => {
    const action = planAutonomousNextAction({
      session: armedSession(),
      todos: [],
      freerunState: "no_root",
    })
    expect(action).toEqual({ type: "stop", reason: "freerun_no_root" })
  })
})

describe("dormant scheduled invariant (scheduled-subsession AC3)", () => {
  const dormantMarker = { jobId: "cron_1", fireAtMs: 9_999_999_999_999, createdAtMs: 1 }

  it("planAutonomousNextAction stops a dormant scheduled session even when armed with pending todos", () => {
    const action = planAutonomousNextAction({
      session: armedSession({ scheduled: dormantMarker }),
      todos: [{ id: "a", content: "do it", status: "pending", priority: "high" }],
    })
    expect(action).toEqual({ type: "stop", reason: "dormant_scheduled" })
  })

  it("dormant_scheduled blocks resume UNCONDITIONALLY — overrides even task_completion bypass", () => {
    const result = inspectPendingContinuationResumability({
      session: baseSession({ scheduled: dormantMarker }),
      status: { type: "idle" } as any,
      inFlight: false,
      triggerType: "task_completion",
    })
    expect(result.resumable).toBe(false)
    expect(result.blockedReasons).toContain("dormant_scheduled")
  })

  it("shouldResumePendingContinuation is false for a dormant scheduled session", () => {
    expect(
      shouldResumePendingContinuation({
        session: baseSession({ scheduled: dormantMarker }),
        status: { type: "idle" } as any,
        inFlight: false,
        triggerType: "task_completion",
      }),
    ).toBe(false)
  })

  it("control: a non-scheduled session is not blocked by dormant_scheduled", () => {
    const result = inspectPendingContinuationResumability({
      session: baseSession(),
      status: { type: "idle" } as any,
      inFlight: false,
      triggerType: "task_completion",
    })
    expect(result.blockedReasons).not.toContain("dormant_scheduled")
  })

  it("Session.isDormantScheduled reflects marker presence", () => {
    expect(Session.isDormantScheduled(baseSession({ scheduled: dormantMarker }))).toBe(true)
    expect(Session.isDormantScheduled(baseSession())).toBe(false)
  })
})

describe("evaluateAutonomousContinuation", () => {
  it("wraps planAutonomousNextAction result in continue/stop form", () => {
    const decision = evaluateAutonomousContinuation({
      session: armedSession(),
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
      session: armedSession(),
      todos: [],
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
        session: armedSession(),
        status: { type: "busy" } as any,
        lastUserSynthetic: true,
        hasPendingContinuation: false,
      }),
    ).toBe(true)
  })

  it("interrupts busy root session when a pending continuation is queued", () => {
    expect(
      shouldInterruptAutonomousRun({
        session: armedSession(),
        status: { type: "busy" } as any,
        lastUserSynthetic: false,
        hasPendingContinuation: true,
      }),
    ).toBe(true)
  })

  it("does not interrupt when autorun is disabled", () => {
    expect(
      shouldInterruptAutonomousRun({
        session: baseSession(),
        status: { type: "busy" } as any,
        lastUserSynthetic: true,
        hasPendingContinuation: true,
      }),
    ).toBe(false)
  })
})

describe("inspectPendingContinuationResumability", () => {
  it("always allows task completion collection past autorun and workflow stop gates", () => {
    const session = baseSession({
      workflow: {
        ...baseSession().workflow!,
        autonomous: { ...baseSession().workflow!.autonomous, enabled: false },
        state: "completed",
        stopReason: "plan_drained",
      },
    })

    const result = inspectPendingContinuationResumability({
      session,
      status: { type: "idle" } as any,
      inFlight: false,
      health: {
        state: "completed",
        stopReason: "plan_drained",
        queue: { hasPendingContinuation: true, reason: "todo_pending", queuedAt: 1, roundCount: 0 },
        supervisor: { consecutiveResumeFailures: 0 },
        anomalies: { recentCount: 0, flags: [], countsByType: {} },
        summary: { health: "completed", label: "Autonomous workflow completed" },
      },
      triggerType: "task_completion",
    })

    expect(result.resumable).toBe(true)
    expect(result.blockedReasons).not.toContain("autonomous_disabled")
    expect(result.blockedReasons).not.toContain("workflow_completed")
  })
})

describe("buildContinuationTrigger", () => {
  it("returns undefined when no todo supplied", () => {
    expect(buildContinuationTrigger({ todo: undefined, textForPending: "p", textForInProgress: "i" })).toBeUndefined()
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
