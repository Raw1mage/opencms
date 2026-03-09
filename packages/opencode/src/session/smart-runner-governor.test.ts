import { describe, expect, it } from "bun:test"
import { Session } from "."
import {
  applySmartRunnerBoundedAssist,
  buildSmartRunnerGovernorContext,
  shouldRunSmartRunnerGovernorDryRun,
} from "./smart-runner-governor"

describe("Smart Runner Governor", () => {
  it("only runs in dry-run mode when explicitly enabled and continuation is allowed", () => {
    expect(shouldRunSmartRunnerGovernorDryRun({ enabled: true, decision: { continue: true } })).toBe(true)
    expect(shouldRunSmartRunnerGovernorDryRun({ enabled: false, decision: { continue: true } })).toBe(false)
    expect(shouldRunSmartRunnerGovernorDryRun({ enabled: true, decision: { continue: false } })).toBe(false)
  })

  it("builds a compact governance context pack from session state and recent messages", () => {
    const context = buildSmartRunnerGovernorContext({
      session: {
        workflow: {
          ...Session.defaultWorkflow(1),
          autonomous: { ...Session.defaultWorkflow(1).autonomous, enabled: true },
          state: "running",
        },
      },
      todos: [
        { id: "t1", content: "finish current slice", status: "in_progress", priority: "high" },
        {
          id: "t2",
          content: "follow-up validation",
          status: "pending",
          priority: "medium",
          action: { kind: "implement", dependsOn: ["t1"] },
        },
      ],
      roundCount: 2,
      deterministicDecision: {
        continue: true,
        reason: "todo_in_progress",
        text: "Continue the task already in progress.",
        todo: { id: "t1", content: "finish current slice", status: "in_progress", priority: "high" },
      },
      messages: [
        {
          info: { id: "m1", role: "user" },
          parts: [
            { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "Implement dry-run governor trace" },
          ],
        } as any,
        {
          info: { id: "m2", role: "assistant" },
          parts: [
            {
              id: "p2",
              sessionID: "s1",
              messageID: "m2",
              type: "text",
              text: "I inspected the workflow runner and found the continuation handoff point.",
            },
          ],
        } as any,
        {
          info: { id: "m3", role: "assistant" },
          parts: [
            {
              id: "p3",
              sessionID: "s1",
              messageID: "m3",
              type: "text",
              text: "Continuing current step: finish current slice",
              synthetic: true,
              metadata: { autonomousNarration: true },
            },
          ],
        } as any,
      ],
    })

    expect(context.goal).toBe("Implement dry-run governor trace")
    expect(context.workflow.autonomous).toBe(true)
    expect(context.todos.inProgress).toEqual([{ id: "t1", content: "finish current slice" }])
    expect(context.todos.blocked).toEqual([{ id: "t2", content: "follow-up validation", waitingOn: undefined }])
    expect(context.recentProgress.lastNarration).toBe("Continuing current step: finish current slice")
    expect(context.recentProgress.latestAssistantSummary).toBe(
      "I inspected the workflow runner and found the continuation handoff point.",
    )
    expect(context.deterministicPlan.todoID).toBe("t1")
  })

  it("only lets bounded assist change low-risk continue instructions", () => {
    const baseDecision = {
      continue: true as const,
      reason: "todo_in_progress" as const,
      text: "Continue the task already in progress.",
      todo: { id: "t1", content: "finish current slice", status: "in_progress", priority: "high" as const },
    }

    expect(
      applySmartRunnerBoundedAssist({
        enabled: true,
        decision: baseDecision,
        trace: {
          source: "smart_runner_governor",
          dryRun: true,
          status: "advisory",
          createdAt: 1,
          deterministicReason: "todo_in_progress",
          decision: {
            situation: "execution_stalled",
            assessment: "Needs preflight",
            decision: "debug_preflight_first",
            reason: "Debug work should define signals first",
            nextAction: {
              kind: "request_debug_preflight",
              skillHints: ["code-thinker"],
              narration: "Running debug preflight before the next fix.",
            },
            needsUserInput: false,
            confidence: "high",
          },
        },
      }).narration,
    ).toBe("Running debug preflight before the next fix.")

    expect(
      applySmartRunnerBoundedAssist({
        enabled: true,
        decision: baseDecision,
        trace: {
          source: "smart_runner_governor",
          dryRun: true,
          status: "advisory",
          createdAt: 1,
          deterministicReason: "todo_in_progress",
          decision: {
            situation: "waiting_for_human",
            assessment: "Unsure",
            decision: "ask_user",
            reason: "Needs clarification",
            nextAction: {
              kind: "request_user_input",
              skillHints: [],
              narration: "Ask the user.",
            },
            needsUserInput: true,
            confidence: "high",
          },
        },
      }).decision.text,
    ).toBe(baseDecision.text)
  })
})
