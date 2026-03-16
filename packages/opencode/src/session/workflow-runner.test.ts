import { describe, expect, it } from "bun:test"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { Todo } from "./todo"
import { Instance } from "../project/instance"
import { RuntimeEventService } from "../system/runtime-event-service"
import { tmpdir } from "../../test/fixture/fixture"
import path from "path"
import {
  classifyResumeFailure,
  computeResumeBackoffMs,
  computeResumeRetryAt,
  clearPendingContinuation,
  decideAutonomousContinuation,
  detectWaitSubagentMismatch,
  describeAutonomousNextAction,
  detectApprovalRequiredForTodos,
  enqueuePendingContinuation,
  enqueueAutonomousContinue,
  evaluateAutonomousContinuation,
  getAutonomousWorkflowHealth,
  getPendingContinuationQueueInspection,
  getPendingContinuation,
  mutatePendingContinuationQueue,
  isPlanTrusting,
  planAutonomousNextAction,
  pickPendingContinuationsForResume,
  shouldInterruptAutonomousRun,
  shouldResumePendingContinuation,
  summarizeAutonomousWorkflowHealth,
} from "./workflow-runner"

function approvedMission() {
  return {
    source: "openspec_compiled_plan" as const,
    contract: "implementation_spec" as const,
    approvedAt: 1,
    planPath: "specs/20260315_test/implementation-spec.md",
    executionReady: true,
    artifactPaths: {
      root: "specs/20260315_test",
      implementationSpec: "specs/20260315_test/implementation-spec.md",
      proposal: "specs/20260315_test/proposal.md",
      spec: "specs/20260315_test/spec.md",
      design: "specs/20260315_test/design.md",
      tasks: "specs/20260315_test/tasks.md",
      handoff: "specs/20260315_test/handoff.md",
    },
  }
}

describe("Session workflow runner", () => {
  it("continues when autonomous mode is enabled and todos remain", () => {
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        mission: approvedMission(),
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
      text: expect.stringContaining(
        "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision.",
      ),
      todo: { id: "a", content: "next", status: "pending", priority: "high" },
    })
    expect(decision.text).toContain("You are the runner contract for autonomous build-mode continuation.")
    expect(decision.text).toContain("Prefer delegation-first execution")
    expect(decision.text).toContain("Progress narration is visibility only")
  })

  it("uses planner contract to continue in-progress work before starting new todos", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          mission: approvedMission(),
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
      text: expect.stringContaining(
        "Continue the task already in progress. Finish or unblock it before starting new work, unless reprioritization is clearly necessary.",
      ),
      todo: { id: "a", content: "finish current", status: "in_progress", priority: "high" },
    })
    const result = planAutonomousNextAction({
      session: {
        parentID: undefined,
        mission: approvedMission(),
        workflow: {
          ...Session.defaultWorkflow(1),
          autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
          state: "waiting_user",
        },
        time: { created: 1, updated: 1 },
      },
      todos: [{ id: "a", content: "finish current", status: "in_progress", priority: "high" }],
      roundCount: 0,
    })
    expect(result.type).toBe("continue")
    if (result.type !== "continue") throw new Error("expected continue action")
    expect(result.text).toContain("You are the runner contract for autonomous build-mode continuation.")
  })

  it("stops autonomous enqueue when subagent task work is still active", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          mission: approvedMission(),
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
          mission: approvedMission(),
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
          mission: approvedMission(),
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
          mission: approvedMission(),
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
          mission: approvedMission(),
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

  it("ignores structured gates on pending todos whose dependencies are not ready", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          mission: approvedMission(),
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [
          {
            id: "later",
            content: "dangerous deploy later",
            status: "pending",
            priority: "high",
            action: { kind: "push", needsApproval: true, dependsOn: ["first"] },
          },
          {
            id: "first",
            content: "finish prerequisite",
            status: "pending",
            priority: "high",
          },
        ],
        roundCount: 0,
      }),
    ).toEqual({
      type: "continue",
      reason: "todo_pending",
      text: expect.stringContaining(
        "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision.",
      ),
      todo: { id: "first", content: "finish prerequisite", status: "pending", priority: "high" },
    })
  })

  it("planner skips pending todos whose dependencies are not completed yet", () => {
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          mission: approvedMission(),
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
      text: expect.stringContaining(
        "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision.",
      ),
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
      text: "Runner starting next planned step: implement replanning",
    })

    expect(describeAutonomousNextAction({ type: "stop", reason: "wait_subagent" })).toEqual({
      kind: "pause",
      text: "Runner paused: a delegated subagent task is still running.",
    })

    expect(describeAutonomousNextAction({ type: "stop", reason: "mission_not_approved" })).toEqual({
      kind: "pause",
      text: "Paused: autonomous runner requires an approved OpenSpec mission contract before continuing.",
    })
  })

  it("detects stale wait_subagent mismatch when no active subtasks remain", () => {
    const mismatch = detectWaitSubagentMismatch({
      decision: { continue: false, reason: "wait_subagent" },
      activeSubtasks: 0,
      todos: [
        {
          id: "todo_wait",
          content: "waiting for subagent",
          status: "in_progress",
          priority: "high",
          action: { kind: "wait", waitingOn: "subagent" },
        },
      ],
    })

    expect(mismatch).toEqual({
      anomalyCode: "unreconciled_wait_subagent",
      waitingTodoIDs: ["todo_wait"],
      waitingTodoContents: ["waiting for subagent"],
      activeSubtasks: 0,
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
          mission: approvedMission(),
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
        mission: approvedMission(),
        time: { created: 1, updated: 1 },
      },
      todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
      roundCount: 0,
    })

    expect(decision).toEqual({ continue: false, reason: "autonomous_disabled" })
  })

  it("stops when autonomous runner has no approved mission contract", () => {
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
      todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
      roundCount: 0,
    })

    expect(decision).toEqual({ continue: false, reason: "mission_not_approved" })
  })

  it("continues when autonomous runner has an approved mission contract", () => {
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        mission: approvedMission(),
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
      todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
      roundCount: 0,
    })

    expect(decision).toEqual({
      continue: true,
      reason: "todo_pending",
      text: expect.stringContaining(
        "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision.",
      ),
      todo: { id: "a", content: "next", status: "pending", priority: "high" },
    })
  })

  it("bypasses max continuous rounds for plan-trusting sessions", () => {
    // Plan-trusting sessions (approved mission) should continue past maxContinuousRounds
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        mission: approvedMission(),
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
    expect(decision.continue).toBe(true)
    expect(decision.reason).toBe("todo_in_progress")
  })

  it("marks workflow complete when no actionable todos remain", () => {
    const decision = evaluateAutonomousContinuation({
      session: {
        parentID: undefined,
        mission: approvedMission(),
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

    expect(
      shouldResumePendingContinuation({
        session: {
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
            stopReason: "approval_needed",
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
            state: "waiting_user",
            stopReason: "wait_subagent",
          },
        },
        status: { type: "idle" },
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

  it("uses provider bucket wait time when scheduling rate-limit retries", () => {
    expect(
      computeResumeRetryAt({
        now: 1_000,
        consecutiveFailures: 2,
        category: "provider_rate_limit",
        budgetWaitTimeMs: 90_000,
      }),
    ).toBe(91_000)

    expect(
      computeResumeRetryAt({
        now: 1_000,
        consecutiveFailures: 2,
        category: "provider_transient",
        budgetWaitTimeMs: 90_000,
      }),
    ).toBe(31_000)
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

  it("pins autonomous synthetic turns to persisted session execution identity", async () => {
    const session = await Session.createNext({
      id: "session_execution_pin",
      title: "execution pin test",
      directory: "/tmp",
    })
    await Session.pinExecutionIdentity({
      sessionID: session.id,
      model: {
        providerId: "github-copilot",
        modelID: "gpt-5.4",
        accountId: "acct-copilot",
      },
    })

    const message = await enqueueAutonomousContinue({
      sessionID: session.id,
      user: {
        id: "msg_user_prev",
        role: "user",
        sessionID: session.id,
        time: { created: 1 },
        agent: "coding",
        model: {
          providerId: "openai",
          modelID: "gpt-5",
          accountId: "acct-openai",
        },
        format: { type: "text" },
      },
      text: "Continue",
    })

    expect(message.model).toEqual({
      providerId: "github-copilot",
      modelID: "gpt-5.4",
      accountId: "acct-copilot",
    })
  })

  it("includes approved mission metadata on autonomous synthetic continuation messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.createNext({
          id: "session_mission_metadata",
          title: "mission metadata test",
          directory: tmp.path,
        })
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        await Bun.write(
          path.join(planRoot, "implementation-spec.md"),
          "# Implementation Spec\n\n## Goal\n- Ship mission metadata\n\n## Scope\n### IN\n- mission runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- artifacts exist\n\n## Stop Gates\n- pause on artifact mismatch\n\n## Critical Files\n- packages/opencode/src/session/workflow-runner.ts\n\n## Structured Execution Phases\n- Read mission\n\n## Validation\n- Run workflow-runner tests\n\n## Handoff\n- Continue from approved mission\n",
        )
        await Bun.write(path.join(planRoot, "tasks.md"), "# Tasks\n\n- [ ] Read approved mission\n")
        await Bun.write(
          path.join(planRoot, "handoff.md"),
          "# Handoff\n\n## Execution Contract\n- Read the approved mission first\n\n## Required Reads\n- implementation-spec.md\n- tasks.md\n- handoff.md\n\n## Stop Gates In Force\n- Preserve approval gates\n\n## Execution-Ready Checklist\n- [ ] Mission is approved\n",
        )
        await Session.setMission({
          sessionID: session.id,
          mission: approvedMission(),
        })

        const message = await enqueueAutonomousContinue({
          sessionID: session.id,
          user: {
            id: "msg_user_prev_mission",
            role: "user",
            sessionID: session.id,
            time: { created: 1 },
            agent: "coding",
            model: {
              providerId: "openai",
              modelID: "gpt-5",
              accountId: "acct-openai",
            },
            format: { type: "text" },
          },
          text: "Continue",
        })

        const persisted = await MessageV2.get({ sessionID: session.id, messageID: message.id })
        const part = persisted?.parts.find((item) => item.type === "text")
        expect(part?.type).toBe("text")
        if (part?.type !== "text") throw new Error("expected text part")
        expect(part.metadata?.mission).toMatchObject({
          source: "openspec_compiled_plan",
          contract: "implementation_spec",
          executionReady: true,
          planPath: "specs/20260315_test/implementation-spec.md",
        })
      },
    })
  })

  it("includes mission consumption trace on autonomous synthetic continuation messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.createNext({
          id: "session_mission_consumption_metadata",
          title: "mission consumption metadata test",
          directory: tmp.path,
        })
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        await Bun.write(
          path.join(planRoot, "implementation-spec.md"),
          "# Implementation Spec\n\n## Goal\n- Ship mission consumption\n\n## Scope\n### IN\n- runner mission\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- artifacts exist\n\n## Stop Gates\n- pause on artifact mismatch\n\n## Critical Files\n- packages/opencode/src/session/workflow-runner.ts\n\n## Structured Execution Phases\n- Read mission\n\n## Validation\n- Run workflow-runner tests\n\n## Handoff\n- Continue from approved mission\n",
        )
        await Bun.write(
          path.join(planRoot, "tasks.md"),
          "# Tasks\n\n- [ ] Read approved mission\n- [ ] Continue execution\n",
        )
        await Bun.write(
          path.join(planRoot, "handoff.md"),
          "# Handoff\n\n## Execution Contract\n- Read the approved mission first\n\n## Required Reads\n- implementation-spec.md\n- tasks.md\n- handoff.md\n\n## Stop Gates In Force\n- Preserve approval gates\n\n## Execution-Ready Checklist\n- [ ] Mission is approved\n",
        )
        await Session.setMission({
          sessionID: session.id,
          mission: approvedMission(),
        })

        const message = await enqueueAutonomousContinue({
          sessionID: session.id,
          user: {
            id: "msg_user_prev_mission_consumption",
            role: "user",
            sessionID: session.id,
            time: { created: 1 },
            agent: "coding",
            model: {
              providerId: "openai",
              modelID: "gpt-5",
              accountId: "acct-openai",
            },
            format: { type: "text" },
          },
          text: "Continue",
        })

        const persisted = await MessageV2.get({ sessionID: session.id, messageID: message.id })
        const part = persisted?.parts.find((item) => item.type === "text")
        expect(part?.type).toBe("text")
        if (part?.type !== "text") throw new Error("expected text part")
        expect(part.metadata?.missionConsumption).toMatchObject({
          source: "openspec_compiled_plan",
          contract: "implementation_spec",
          consumedArtifacts: {
            implementationSpec: "specs/20260315_test/implementation-spec.md",
            tasks: "specs/20260315_test/tasks.md",
            handoff: "specs/20260315_test/handoff.md",
          },
        })
        expect(part.metadata?.missionConsumption?.executionChecklist.length).toBeGreaterThan(0)
      },
    })
  })

  it("includes delegation trace on autonomous synthetic continuation messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.createNext({
          id: "session_delegation_metadata",
          title: "delegation metadata test",
          directory: tmp.path,
        })
        const planRoot = path.join(tmp.path, "specs", "20260315_test")
        await Bun.write(
          path.join(planRoot, "implementation-spec.md"),
          "# Implementation Spec\n\n## Goal\n- Ship delegation metadata\n\n## Scope\n### IN\n- workflow runner\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- artifacts exist\n\n## Stop Gates\n- pause on artifact mismatch\n\n## Critical Files\n- packages/opencode/src/session/workflow-runner.ts\n\n## Structured Execution Phases\n- Read mission\n\n## Validation\n- Run workflow-runner tests\n\n## Handoff\n- Continue from approved mission\n",
        )
        await Bun.write(path.join(planRoot, "tasks.md"), "# Tasks\n\n- [ ] Implement delegation trace\n")
        await Bun.write(
          path.join(planRoot, "handoff.md"),
          "# Handoff\n\n## Execution Contract\n- Read the approved mission first\n\n## Required Reads\n- implementation-spec.md\n- tasks.md\n- handoff.md\n\n## Stop Gates In Force\n- Preserve approval gates\n\n## Execution-Ready Checklist\n- [ ] Mission is approved\n",
        )
        await Session.setMission({
          sessionID: session.id,
          mission: approvedMission(),
        })

        const message = await enqueueAutonomousContinue({
          sessionID: session.id,
          user: {
            id: "msg_user_prev_delegation",
            role: "user",
            sessionID: session.id,
            time: { created: 1 },
            agent: "coding",
            model: {
              providerId: "openai",
              modelID: "gpt-5",
              accountId: "acct-openai",
            },
            format: { type: "text" },
          },
          delegation: {
            role: "coding",
            source: "todo_action",
            todoID: "todo_impl",
            todoContent: "implement delegation trace",
          },
        })

        const persisted = await MessageV2.get({ sessionID: session.id, messageID: message.id })
        const part = persisted?.parts.find((item) => item.type === "text")
        expect(part?.type).toBe("text")
        if (part?.type !== "text") throw new Error("expected text part")
        expect(part.text).toContain("planned coding step")
        expect(part.metadata?.delegation).toMatchObject({
          role: "coding",
          source: "todo_action",
          todoID: "todo_impl",
        })
      },
    })
  })

  it("records anomaly events for unreconciled wait_subagent state", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.setMission({
          sessionID: session.id,
          mission: approvedMission(),
        })
        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Todo.update({
          sessionID: session.id,
          todos: [
            {
              id: "todo_wait",
              content: "waiting for subagent",
              status: "in_progress",
              priority: "high",
              action: { kind: "wait", waitingOn: "subagent" },
            },
          ],
        })

        const decision = await decideAutonomousContinuation({
          sessionID: session.id,
          roundCount: 0,
        })
        expect(decision).toEqual({ continue: false, reason: "wait_subagent" })

        const events = await RuntimeEventService.list(session.id)
        expect(events.at(-1)).toMatchObject({
          level: "warn",
          domain: "anomaly",
          eventType: "workflow.unreconciled_wait_subagent",
          todoID: "todo_wait",
          anomalyFlags: ["unreconciled_wait_subagent"],
        })
      },
    })
  })

  it("records unreconciled_wait_subagent after task failure reconciliation", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.setMission({
          sessionID: session.id,
          mission: approvedMission(),
        })
        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Todo.update({
          sessionID: session.id,
          todos: [{ id: "todo_delegate", content: "delegate API audit", status: "pending", priority: "high" }],
        })

        await Todo.reconcileProgress({
          sessionID: session.id,
          linkedTodoID: "todo_delegate",
          taskStatus: "error",
        })

        const todosAfterFailure = await Todo.get(session.id)
        expect(todosAfterFailure).toEqual([
          {
            id: "todo_delegate",
            content: "delegate API audit",
            status: "in_progress",
            priority: "high",
            action: { kind: "delegate", canDelegate: true, waitingOn: "subagent" },
          },
        ])

        const decision = await decideAutonomousContinuation({
          sessionID: session.id,
          roundCount: 0,
        })
        expect(decision).toEqual({ continue: false, reason: "wait_subagent" })

        const events = await RuntimeEventService.list(session.id)
        expect(events.at(-1)).toMatchObject({
          level: "warn",
          domain: "anomaly",
          eventType: "workflow.unreconciled_wait_subagent",
          todoID: "todo_delegate",
          anomalyFlags: ["unreconciled_wait_subagent"],
          payload: {
            waitingTodoIDs: ["todo_delegate"],
            activeSubtasks: 0,
          },
        })
      },
    })
  })

  it("fails fast when approved mission artifacts cannot be consumed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.setMission({
          sessionID: session.id,
          mission: approvedMission(),
        })
        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Todo.update({
          sessionID: session.id,
          todos: [{ id: "todo_next", content: "next approved step", status: "pending", priority: "high" }],
        })

        const decision = await decideAutonomousContinuation({
          sessionID: session.id,
          roundCount: 0,
        })
        expect(decision).toEqual({ continue: false, reason: "mission_not_consumable" })

        const events = await RuntimeEventService.list(session.id)
        expect(events.at(-1)).toMatchObject({
          level: "warn",
          domain: "anomaly",
          eventType: "workflow.mission_not_consumable",
          anomalyFlags: ["mission_not_consumable"],
        })
      },
    })
  })

  it("maps changed approved artifacts to spec_dirty stop reason", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.setMission({
          sessionID: session.id,
          mission: {
            ...approvedMission(),
            artifactIntegrity: {
              implementationSpec: "bad_impl",
              tasks: "bad_tasks",
              handoff: "bad_handoff",
            },
          },
        })
        await Session.updateAutonomous({ sessionID: session.id, policy: { enabled: true } })
        await Todo.update({
          sessionID: session.id,
          todos: [{ id: "todo_next", content: "next approved step", status: "pending", priority: "high" }],
        })

        const decision = await decideAutonomousContinuation({ sessionID: session.id, roundCount: 0 })
        expect(decision).toEqual({ continue: false, reason: "spec_dirty" })
      },
    })
  })

  it("summarizes queue, supervisor, and anomaly evidence into one health surface", () => {
    const health = summarizeAutonomousWorkflowHealth({
      workflow: {
        ...Session.defaultWorkflow(1),
        autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
        state: "waiting_user",
        stopReason: "wait_subagent",
        supervisor: {
          consecutiveResumeFailures: 2,
          retryAt: 5_000,
          lastResumeCategory: "provider_transient",
          lastResumeError: "network timeout",
        },
      },
      pending: {
        sessionID: "ses_health",
        messageID: "msg_health",
        createdAt: 1_000,
        roundCount: 3,
        reason: "todo_in_progress",
        text: "Continue current step",
      },
      events: [
        {
          id: "evt_1",
          ts: 2_000,
          level: "warn",
          domain: "anomaly",
          eventType: "workflow.unreconciled_wait_subagent",
          sessionID: "ses_health",
          anomalyFlags: ["unreconciled_wait_subagent"],
          payload: {},
        },
        {
          id: "evt_2",
          ts: 3_000,
          level: "warn",
          domain: "anomaly",
          eventType: "workflow.mission_not_consumable",
          sessionID: "ses_health",
          anomalyFlags: ["mission_not_consumable"],
          payload: {},
        },
      ],
    })

    expect(health).toEqual({
      state: "waiting_user",
      stopReason: "wait_subagent",
      queue: {
        hasPendingContinuation: true,
        roundCount: 3,
        reason: "todo_in_progress",
        queuedAt: 1_000,
      },
      supervisor: {
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        retryAt: 5_000,
        consecutiveResumeFailures: 2,
        lastResumeCategory: "provider_transient",
        lastResumeError: "network timeout",
      },
      anomalies: {
        recentCount: 2,
        latestEventType: "workflow.mission_not_consumable",
        latestAt: 3_000,
        flags: ["unreconciled_wait_subagent", "mission_not_consumable"],
        countsByType: {
          "workflow.unreconciled_wait_subagent": 1,
          "workflow.mission_not_consumable": 1,
        },
      },
      summary: {
        health: "degraded",
        label: "Degraded: workflow.mission_not_consumable",
      },
    })
  })

  it("loads autonomous workflow health from persisted queue and runtime events", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Session.updateWorkflowSupervisor({
          sessionID: session.id,
          patch: {
            consecutiveResumeFailures: 1,
            lastResumeCategory: "provider_rate_limit",
            lastResumeError: "429 Too Many Requests",
          },
        })
        await enqueuePendingContinuation({
          sessionID: session.id,
          messageID: "msg_resume",
          createdAt: 10,
          roundCount: 1,
          reason: "todo_pending",
          text: "Continue next step",
        })
        await RuntimeEventService.append({
          sessionID: session.id,
          level: "warn",
          domain: "anomaly",
          eventType: "workflow.unreconciled_wait_subagent",
          anomalyFlags: ["unreconciled_wait_subagent"],
          payload: { activeSubtasks: 0 },
        })

        const health = await getAutonomousWorkflowHealth(session.id)
        expect(health.summary).toEqual({
          health: "degraded",
          label: "Degraded: workflow.unreconciled_wait_subagent",
        })
        expect(health.queue).toMatchObject({
          hasPendingContinuation: true,
          roundCount: 1,
          reason: "todo_pending",
        })
        expect(health.supervisor).toMatchObject({
          consecutiveResumeFailures: 1,
          lastResumeCategory: "provider_rate_limit",
        })
        expect(health.anomalies).toMatchObject({
          recentCount: 1,
          latestEventType: "workflow.unreconciled_wait_subagent",
          flags: ["unreconciled_wait_subagent"],
        })
      },
    })
  })

  it("inspects pending continuation queue with resumable vs blocked reasons", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const blocked = await Session.create({})
        await Session.setMission({ sessionID: blocked.id, mission: approvedMission() })
        await Session.updateAutonomous({
          sessionID: blocked.id,
          policy: { enabled: true },
        })
        await Session.setWorkflowState({
          sessionID: blocked.id,
          state: "waiting_user",
          stopReason: "wait_subagent",
        })
        await enqueuePendingContinuation({
          sessionID: blocked.id,
          messageID: "msg_blocked",
          createdAt: 101,
          roundCount: 2,
          reason: "todo_pending",
          text: "Continue",
        })

        const resumable = await Session.create({})
        await Session.setMission({ sessionID: resumable.id, mission: approvedMission() })
        await Session.updateAutonomous({
          sessionID: resumable.id,
          policy: { enabled: true },
        })
        await enqueuePendingContinuation({
          sessionID: resumable.id,
          messageID: "msg_resumable",
          createdAt: 102,
          roundCount: 1,
          reason: "todo_in_progress",
          text: "Continue current step",
        })

        const blockedInspection = await getPendingContinuationQueueInspection(blocked.id)
        expect(blockedInspection).toMatchObject({
          hasPendingContinuation: true,
          status: "idle",
          resumable: false,
          blockedReasons: ["waiting_user_non_resumable:wait_subagent"],
          pending: {
            sessionID: blocked.id,
            messageID: "msg_blocked",
            roundCount: 2,
          },
        })

        const resumableInspection = await getPendingContinuationQueueInspection(resumable.id)
        expect(resumableInspection).toMatchObject({
          hasPendingContinuation: true,
          status: "idle",
          resumable: true,
          blockedReasons: [],
          pending: {
            sessionID: resumable.id,
            messageID: "msg_resumable",
            roundCount: 1,
            reason: "todo_in_progress",
          },
        })
      },
    })
  })

  it("drops pending continuation through operator queue control mutation", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.setMission({ sessionID: session.id, mission: approvedMission() })
        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await enqueuePendingContinuation({
          sessionID: session.id,
          messageID: "msg_drop",
          createdAt: 300,
          roundCount: 1,
          reason: "todo_pending",
          text: "Continue",
        })

        const result = await mutatePendingContinuationQueue({
          sessionID: session.id,
          action: "drop_pending",
        })

        expect(result).toMatchObject({
          action: "drop_pending",
          applied: true,
          reason: "dropped",
          inspection: {
            hasPendingContinuation: false,
            blockedReasons: ["no_pending_continuation"],
          },
        })
      },
    })
  })

  it("returns not_resumable when operator requests resume for blocked queue", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.setMission({ sessionID: session.id, mission: approvedMission() })
        await Session.updateAutonomous({
          sessionID: session.id,
          policy: { enabled: true },
        })
        await Session.setWorkflowState({
          sessionID: session.id,
          state: "waiting_user",
          stopReason: "wait_subagent",
        })
        await enqueuePendingContinuation({
          sessionID: session.id,
          messageID: "msg_blocked_resume",
          createdAt: 301,
          roundCount: 1,
          reason: "todo_pending",
          text: "Continue",
        })

        const result = await mutatePendingContinuationQueue({
          sessionID: session.id,
          action: "resume_once",
        })

        expect(result).toMatchObject({
          action: "resume_once",
          applied: false,
          reason: "not_resumable",
          blockedReasons: ["waiting_user_non_resumable:wait_subagent"],
          inspection: {
            hasPendingContinuation: true,
            resumable: false,
            blockedReasons: ["waiting_user_non_resumable:wait_subagent"],
          },
        })
      },
    })
  })

  it("prefers lower-failure resumptions when budget readiness is otherwise equal", () => {
    const picked = pickPendingContinuationsForResume({
      maxCount: 1,
      items: [
        {
          pending: {
            sessionID: "session_flaky",
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
              supervisor: { consecutiveResumeFailures: 3 },
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "openai", waitTimeMs: 0 },
        },
        {
          pending: {
            sessionID: "session_healthy",
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
              supervisor: { consecutiveResumeFailures: 0 },
            },
          },
          status: { type: "idle" },
          inFlight: false,
          budget: { family: "google-api", waitTimeMs: 0 },
        },
      ],
    })

    expect(picked.map((item) => item.pending.sessionID)).toEqual(["session_healthy"])
  })
})

describe("isPlanTrusting", () => {
  it("returns true for fully approved mission", () => {
    expect(isPlanTrusting(approvedMission())).toBe(true)
  })

  it("returns false when mission is undefined", () => {
    expect(isPlanTrusting(undefined)).toBe(false)
  })

  it("returns false when executionReady is false", () => {
    expect(isPlanTrusting({ ...approvedMission(), executionReady: false })).toBe(false)
  })

  it("returns false when source is not openspec_compiled_plan", () => {
    expect(isPlanTrusting({ ...approvedMission(), source: "openspec_compiled_plan" as any })).toBe(true)
    expect(isPlanTrusting({ ...approvedMission(), source: "manual" as any })).toBe(false)
  })

  it("returns false when contract is not implementation_spec", () => {
    expect(isPlanTrusting({ ...approvedMission(), contract: "other" as any })).toBe(false)
  })
})

describe("plan-trusting mode: max_continuous_rounds bypass", () => {
  it("skips max_continuous_rounds when plan-trusting", () => {
    const decision = planAutonomousNextAction({
      session: {
        parentID: undefined,
        mission: approvedMission(),
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
      todos: [{ id: "a", content: "next task", status: "pending", priority: "high" }],
      roundCount: 100, // Way over the limit
    })
    expect(decision.type).toBe("continue")
    expect(decision.reason).toBe("todo_pending")
  })

  it("still enforces max_continuous_rounds when NOT plan-trusting", () => {
    const decision = planAutonomousNextAction({
      session: {
        parentID: undefined,
        mission: { ...approvedMission(), executionReady: false },
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
      todos: [{ id: "a", content: "next task", status: "pending", priority: "high" }],
      roundCount: 5,
    })
    expect(decision.type).toBe("stop")
    expect(decision.reason).toBe("mission_not_approved")
  })

  it("still stops for real blockers even in plan-trusting mode", () => {
    // blocked state
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          mission: approvedMission(),
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "blocked",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [{ id: "a", content: "next", status: "pending", priority: "high" }],
        roundCount: 0,
      }),
    ).toEqual({ type: "stop", reason: "blocked" })

    // approval needed
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          mission: approvedMission(),
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

    // todo complete
    expect(
      planAutonomousNextAction({
        session: {
          parentID: undefined,
          mission: approvedMission(),
          workflow: {
            ...Session.defaultWorkflow(1),
            autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
            state: "waiting_user",
          },
          time: { created: 1, updated: 1 },
        },
        todos: [],
        roundCount: 0,
      }),
    ).toEqual({ type: "stop", reason: "todo_complete" })
  })
})
