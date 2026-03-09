import { describe, expect, it } from "bun:test"
import { Session } from "./index"
import { evaluateAutonomousContinuation } from "./workflow-runner"

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
})
