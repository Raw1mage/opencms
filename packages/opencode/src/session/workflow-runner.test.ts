import { describe, expect, it } from "bun:test"
import { Session } from "./index"
import {
  classifyResumeFailure,
  computeResumeBackoffMs,
  clearPendingContinuation,
  describeAutonomousNextAction,
  detectApprovalRequiredForTodos,
  enqueuePendingContinuation,
  evaluateAutonomousContinuation,
  getPendingContinuation,
  planAutonomousNextAction,
  pickPendingContinuationsForResume,
  shouldInterruptAutonomousRun,
  shouldResumePendingContinuation,
} from "./workflow-runner"

describe("Session workflow runner", () => {
  it("continues when autonomous mode is enabled and todos remain", () => {
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        workflow: {
          ...Session.defaultWorkflow(1),
          autonomous: {
            ...Session.defaultWorkflow(1).autonomous,
            enabled: true,
            maxContinuousRounds: 3,
          },
          state: "waiting_user",
        },
        time: { created: 1, updated: 1 },
      },
      todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
      roundCount: 0,
    })

    expect(decision).toEqual({
      continue: true,
      reason: "todo_pending",
      text: "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision.",
      todo: { id: "a", content: "next", status: "pending", priority: "high" },
    })
  })

  it("uses planner contract to continue in-progress work before starting new todos", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [{ id: "a", content: "finish current", status: "in_progress", priority: "high" }],
        roundCount: 0,
      }),
    ).toEqual({
      type: "continue",
      reason: "todo_in_progress",
      text: "Continue the task already in progress. Finish or unblock it before starting new work, unless reprioritization is clearly necessary.",
      todo: { id: "a", content: "finish current", status: "in_progress", priority: "high" },
    })
  })

  it("stops autonomous enqueue when subagent task work is still active", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
        roundCount: 0,
        activeSubtasks: 1,
      }),
    ).toEqual({ type: "stop", reason: "wait_subagent" })
  })

  it("stops for pending approval requests before continuing autonomous work", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
        roundCount: 0,
        pendingApprovals: 1,
      }),
    ).toEqual({ type: "stop", reason: "approval_needed" })
  })

  it("uses requireApprovalFor policy to gate push/destructive/architecture todos", () => {
    expect(
      detectApprovalRequiredForTodos({
        gates: ["push", "destructive", "architecture_change"],
        todos: [{ id: "a", content: "push branch and deploy release", status: "pending", priority: "high" }],
      }),
    ).toBe("push")

    expect(
      detectApprovalRequiredForTodos({
        gates: ["destructive"],
        todos: [{ id: "a", content: "delete old workspace cache", status: "pending", priority: "high" }],
      }),
    ).toBe("destructive")

    expect(
      detectApprovalRequiredForTodos({
        gates: ["architecture_change"],
        todos: [
          { id: "a", content: "schema migration for architecture refactor", status: "pending", priority: "high" },
        ],
      }),
    ).toBe("architecture_change")

    expect(
      detectApprovalRequiredForTodos({
        gates: ["push", "destructive", "architecture_change"],
        todos: [
          {
            id: "b",
            content: "ship it",
            status: "pending",
            priority: "high",
            action: { kind: "push", needsApproval: true },
          },
        ],
      }),
    ).toBe("push")
  })

  it("planner stops for policy-gated todos even without live approval queue entries", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: {
              ...Session.defaultWorkflow(1).autonomous,
              enabled: true,
              requireApprovalFor: ["push", "destructive", "architecture_change"],
            },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [{ id: "a", content: "push release branch", status: "pending", priority: "high" }],
        roundCount: 0,
      }),
    ).toEqual({ type: "stop", reason: "approval_needed" })
  })

  it("planner prefers structured action metadata over text heuristics", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: {
              ...Session.defaultWorkflow(1).autonomous,
              enabled: true,
              requireApprovalFor: ["push", "destructive", "architecture_change"],
            },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [
          {
            id: "a",
            content: "harmless wording",
            status: "pending",
            priority: "high",
            action: { kind: "architecture_change", needsApproval: true },
          },
        ],
        roundCount: 0,
      }),
    ).toEqual({ type: "stop", reason: "approval_needed" })

    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [
          {
            id: "b",
            content: "continue later",
            status: "pending",
            priority: "medium",
            action: { kind: "wait", waitingOn: "subagent" },
          },
        ],
        roundCount: 0,
      }),
    ).toEqual({ type: "stop", reason: "wait_subagent" })
  })

  it("planner skips pending todos whose dependencies are not completed yet", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [
          {
            id: "a",
            content: "blocked follow-up",
            status: "pending",
            priority: "high",
            action: { kind: "implement", dependsOn: ["done_later"] },
          },
          {
            id: "done_later",
            content: "prereq",
            status: "pending",
            priority: "high",
          },
        ],
        roundCount: 0,
      }),
    ).toEqual({
      type: "continue",
      reason: "todo_pending",
      text: "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision.",
      todo: { id: "done_later", content: "prereq", status: "pending", priority: "high" },
    })
  })

  it("describes autonomous continuation and pause narration text", () => {
    expect(
      describeAutonomousNextAction({
        type: "continue",
        reason: "todo_pending",
        text: "continue",
        todo: { id: "a", content: "implement replanning", status: "pending", priority: "high" },
      }),
    ).toEqual({
      kind: "continue",
      text: "Starting next planned step: implement replanning",
    })

    expect(describeAutonomousNextAction({ type: "stop", reason: "wait_subagent" })).toEqual({
      kind: "pause",
      text: "Paused: a delegated subagent task is still running.",
    })
  })

  it("only interrupts busy autonomous runs when current work is synthetic or queued", () => {
    expect(
      shouldInterruptAutonomousRun({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
          },
        },
        status: { type: "busy" },
        lastUserSynthetic: true,
        hasPendingContinuation: false,
      }),
    ).toBe(true)

    expect(
      shouldInterruptAutonomousRun({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
          },
        },
        status: { type: "busy" },
        lastUserSynthetic: false,
        hasPendingContinuation: false,
      }),
    ).toBe(false)
  })

  it("stops for pending product questions before continuing autonomous work", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
        roundCount: 0,
        pendingQuestions: 1,
      }),
    ).toEqual({ type: "stop", reason: "product_decision_needed" })
  })

  it("stops when autonomous mode is disabled", () => {
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        workflow: Session.defaultWorkflow(1),
        time: { created: 1, updated: 1 },
      },
      todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
      roundCount: 0,
    })

    expect(decision).toEqual({ continue: false, reason: "autonomous_disabled" })
  })

  it("stops when max continuous rounds is reached", () => {
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        workflow: {
          ...Session.defaultWorkflow(1),
          autonomous: {
            ...Session.defaultWorkflow(1).autonomous,
            enabled: true,
            maxContinuousRounds: 2,
          },
          state: "waiting_user",
        },
        time: { created: 1, updated: 1 },
      },
      todos: [{ id: "a", content: "next", status: "in_progress", priority: "high" }],
      roundCount: 2,
    })

    expect(decision).toEqual({ continue: false, reason: "max_continuous_rounds" })
  })

  it("marks workflow complete when no actionable todos remain", () => {
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        workflow: {
          ...Session.defaultWorkflow(1),
          autonomous: {
            ...Session.defaultWorkflow(1).autonomous,
            enabled: true,
          },
          state: "waiting_user",
        },
        time: { created: 1, updated: 1 },
      },
      todos: [{ id: "a", content: "done", status: "completed", priority: "high" }],
      roundCount: 0,
    })

    expect(decision).toEqual({ continue: false, reason: "todo_complete" })
  })

  it("persists and clears pending continuation entries", async () => {
    const sessionID = "session_test_pending"
    await enqueuePendingContinuation({
      sessionID,
      messageID: "msg_test_pending",
      createdAt: 123,
      roundCount: 2,
      reason: "todo_pending",
      text: "Continue",
    })

    await expect(getPendingContinuation(sessionID)).resolves.toEqual({
      sessionID,
      messageID: "msg_test_pending",
      createdAt: 123,
      roundCount: 2,
      reason: "todo_pending",
      text: "Continue",
    })

    await clearPendingContinuation(sessionID)
    await expect(getPendingContinuation(sessionID)).resolves.toBeUndefined()
  })

  it("only resumes idle autonomous root sessions that are not blocked", () => {
    expect(
      shouldResumePendingContinuation({
        session: {
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
          },
        },
        status: { type: "idle" },
        inFlight: false,
      }),
    ).toBe(true)

    expect(
      shouldResumePendingContinuation({
        session: {
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "blocked",
            updatedAt: 1,
          },
        },
        status: { type: "idle" },
        inFlight: false,
      }),
    ).toBe(false)

    expect(
      shouldResumePendingContinuation({
        session: {
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            supervisor: {
              retryAt: Date.now() + 60_000,
            },
          },
        },
        status: { type: "idle" },
        inFlight: false,
      }),
    ).toBe(false)

    expect(
      shouldResumePendingContinuation({
        session: {
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
          },
        },
        status: { type: "busy" },
        inFlight: false,
      }),
    ).toBe(false)
  })

  it("allows same-owner lease recovery but blocks foreign active lease", () => {
    const workflow = {
      ...Session.defaultWorkflow(1),
      autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
      supervisor: {
        leaseOwner: "owner-a",
        leaseExpiresAt: Date.now() + 60_000,
      },
    }

    expect(
      shouldResumePendingContinuation({
        session: { workflow },
        status: { type: "idle" },
        inFlight: false,
        owner: "owner-a",
      }),
    ).toBe(true)

    expect(
      shouldResumePendingContinuation({
        session: { workflow },
        status: { type: "idle" },
        inFlight: false,
        owner: "owner-b",
      }),
    ).toBe(false)
  })

  it("computes exponential backoff with a capped ceiling", () => {
    expect(computeResumeBackoffMs(1)).toBe(15_000)
    expect(computeResumeBackoffMs(2)).toBe(30_000)
    expect(computeResumeBackoffMs(3)).toBe(60_000)
    expect(computeResumeBackoffMs(10)).toBe(300_000)
  })

  it("classifies auth and runtime failures as immediate block conditions", () => {
    expect(
      classifyResumeFailure({
        message: "Invalid API key",
        statusCode: 401,
      }),
    ).toMatchObject({ category: "provider_auth", shouldBlockImmediately: true, shouldRetry: false })

    expect(classifyResumeFailure(new Error("Tool execution failed: command not found"))).toMatchObject({
      category: "tool_runtime",
      shouldBlockImmediately: true,
      shouldRetry: false,
    })

    expect(classifyResumeFailure(new Error("approval_needed: awaiting user approval"))).toMatchObject({
      category: "tool_runtime",
    })
  })

  it("classifies transient provider failures as retryable", () => {
    expect(classifyResumeFailure(new Error("network timeout while calling provider"))).toMatchObject({
      category: "provider_transient",
      shouldRetry: true,
      shouldBlockImmediately: false,
    })
  })

  it("picks oldest-starved resumable sessions first and limits sweep size", () => {
    const picked = pickPendingContinuationsForResume({
      maxCount: 1,
      items: [
        {
          pending: {
            sessionID: "session_b",
            messageID: "msg_b",
            createdAt: 20,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              lastRunAt: 50,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "openai", waitTimeMs: 0 },
        },
        {
          pending: {
            sessionID: "session_a",
            messageID: "msg_a",
            createdAt: 10,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              lastRunAt: 10,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "google-api", waitTimeMs: 0 },
        },
      ],
    })

    expect(picked.map((item) => item.pending.sessionID)).toEqual(["session_a"])
  })

  it("skips blocked or busy sessions when picking fairness candidates", () => {
    const picked = pickPendingContinuationsForResume({
      maxCount: 3,
      items: [
        {
          pending: {
            sessionID: "session_blocked",
            messageID: "msg_1",
            createdAt: 10,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              state: "blocked",
              updatedAt: 2,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "openai", waitTimeMs: 0 },
        },
        {
          pending: {
            sessionID: "session_busy",
            messageID: "msg_2",
            createdAt: 11,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            },
          },
          status: { type: "busy" },
          inFlight: false,
          budget: { family: "google-api", waitTimeMs: 0 },
        },
        {
          pending: {
            sessionID: "session_ok",
            messageID: "msg_3",
            createdAt: 12,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "claude-cli", waitTimeMs: 0 },
        },
      ],
    })

    expect(picked.map((item) => item.pending.sessionID)).toEqual(["session_ok"])
  })

  it("prefers ready budget buckets over older rate-limited families", () => {
    const picked = pickPendingContinuationsForResume({
      maxCount: 1,
      items: [
        {
          pending: {
            sessionID: "session_waiting_family",
            messageID: "msg_1",
            createdAt: 1,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              lastRunAt: 1,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "openai", waitTimeMs: 30_000 },
        },
        {
          pending: {
            sessionID: "session_ready_family",
            messageID: "msg_2",
            createdAt: 2,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              lastRunAt: 20,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "google-api", waitTimeMs: 0 },
        },
      ],
    })

    expect(picked.map((item) => item.pending.sessionID)).toEqual(["session_ready_family"])
  })

  it("spreads picks across provider families before taking a second session from the same bucket", () => {
    const picked = pickPendingContinuationsForResume({
      maxCount: 2,
      items: [
        {
          pending: {
            sessionID: "session_openai_a",
            messageID: "msg_1",
            createdAt: 1,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              lastRunAt: 1,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "openai", waitTimeMs: 0 },
        },
        {
          pending: {
            sessionID: "session_openai_b",
            messageID: "msg_2",
            createdAt: 2,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              lastRunAt: 2,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "openai", waitTimeMs: 0 },
        },
        {
          pending: {
            sessionID: "session_google_a",
            messageID: "msg_3",
            createdAt: 3,
            roundCount: 1,
            reason: "todo_pending",
            text: "Continue",
          },
          session: {
            workflow: {
              ...Session.defaultWorkflow(1),
              autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
              lastRunAt: 3,
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "google-api", waitTimeMs: 0 },
        },
      ],
    })

    expect(picked.map((item) => item.pending.sessionID)).toEqual(["session_openai_a", "session_google_a"])
  })
})
