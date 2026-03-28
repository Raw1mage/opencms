import { describe, expect, it } from "bun:test"
import { Session } from "../../src/session"
import { resolveDialogTrigger, resolveDialogTriggerPolicy } from "../../src/session/dialog-trigger"

function sessionFixture(overrides?: Partial<Pick<Session.Info, "workflow" | "mission" | "time">>) {
  return {
    workflow: Session.defaultWorkflow(1),
    mission: undefined,
    time: { updated: 1 },
    ...overrides,
  } as Pick<Session.Info, "workflow" | "mission" | "time">
}

describe("dialog trigger registry", () => {
  it("routes plan-enter eligible prompts into the plan agent", () => {
    const result = resolveDialogTrigger({
      client: "app",
      parts: [
        {
          type: "text",
          text: "We need a multi-step architecture plan with validation, constraints, handoff, and phased execution for this workflow.",
        },
      ] as any,
      session: sessionFixture(),
    })

    expect(result.trigger).toBe("plan_enter")
    expect(result.routeAgent).toBe("plan")
  })

  it("preserves explicit plan_exit/build-mode requests as non-plan routing", () => {
    const result = resolveDialogTrigger({
      client: "app",
      parts: [{ type: "text", text: "go on plan_exit and switch to build mode" }] as any,
      session: sessionFixture(),
    })

    expect(result.trigger).toBe("none")
    expect(result.routeAgent).toBeUndefined()
  })

  it("honors committed plan_exit intent over later plan-enter heuristics", () => {
    const result = resolveDialogTrigger({
      client: "app",
      committedPlannerIntent: "plan_exit",
      parts: [
        {
          type: "text",
          text: "We need a multi-step architecture plan with validation, constraints, handoff, and phased execution for this workflow.",
        },
      ] as any,
      session: sessionFixture(),
    })

    expect(result.trigger).toBe("none")
    expect(result.routeAgent).toBe("build")
    expect(result.suppressAutoEnterPlan).toBe(true)
  })

  it("routes replan requests into the plan agent when execution context exists", () => {
    const result = resolveDialogTrigger({
      client: "app",
      parts: [{ type: "text", text: "需求變更了，請重新規劃並改計畫" }] as any,
      session: sessionFixture({
        mission: { executionReady: true } as any,
        workflow: { ...Session.defaultWorkflow(1), state: "running" },
      }),
    })

    expect(result.trigger).toBe("replan")
    expect(result.routeAgent).toBe("plan")
    expect(result.stopReason).toBe("product_decision_needed")
  })

  it("does not route replan wording without material direction change", () => {
    const result = resolveDialogTrigger({
      client: "app",
      parts: [{ type: "text", text: "請幫我 replan 一下，整理得更好讀" }] as any,
      session: sessionFixture({
        mission: { executionReady: true } as any,
        workflow: { ...Session.defaultWorkflow(1), state: "running" },
      }),
    })

    expect(result.trigger).toBe("none")
    expect(result.routeAgent).toBeUndefined()
  })

  it("detects approval replies while waiting on approval without auto-entering plan mode", () => {
    const result = resolveDialogTrigger({
      client: "app",
      parts: [{ type: "text", text: "批准，go ahead" }] as any,
      session: sessionFixture({
        workflow: { ...Session.defaultWorkflow(1), state: "waiting_user", stopReason: "approval_needed" },
      }),
    })

    expect(result.trigger).toBe("approval")
    expect(result.routeAgent).toBe("build")
    expect(result.stopReason).toBe("approval_needed")
  })

  it("does not detect approval replies outside approval wait state", () => {
    const result = resolveDialogTrigger({
      client: "app",
      parts: [{ type: "text", text: "批准，go ahead" }] as any,
      session: sessionFixture({
        workflow: { ...Session.defaultWorkflow(1), state: "running" },
      }),
    })

    expect(result.trigger).toBe("none")
    expect(result.routeAgent).toBeUndefined()
  })

  it("centralizes trigger policy around the same dialog-trigger decision", async () => {
    const policy = await resolveDialogTriggerPolicy({
      client: "app",
      parts: [{ type: "text", text: "需求變更了，請重新規劃並改計畫" }] as any,
      session: sessionFixture({
        mission: { executionReady: true } as any,
        workflow: { ...Session.defaultWorkflow(1), state: "running" },
      }),
    })

    expect(policy.decision.trigger).toBe("replan")
    expect(policy.decision.routeAgent).toBe("plan")
    expect(policy.autoPlanExitHandoff).toBe(false)
  })

  it("keeps build-mode wording conservative in centralized policy", async () => {
    const policy = await resolveDialogTriggerPolicy({
      client: "app",
      parts: [{ type: "text", text: "go on plan_exit and switch to build mode" }] as any,
      session: sessionFixture(),
    })

    expect(policy.decision.trigger).toBe("none")
    expect(policy.decision.routeAgent).toBeUndefined()
    expect(policy.autoPlanExitHandoff).toBe(false)
  })
})
