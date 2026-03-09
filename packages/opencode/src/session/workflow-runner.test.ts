import { describe, expect, it } from "bun:test"
import { Session } from "./index"
import {
  clearPendingContinuation,
  enqueuePendingContinuation,
  evaluateAutonomousContinuation,
  getPendingContinuation,
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

    expect(decision).toEqual({ continue: true, reason: "todo_pending" })
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
          },
        },
        status: { type: "busy" },
        inFlight: false,
      }),
    ).toBe(false)
  })
})
