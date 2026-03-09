import { describe, expect, it } from "bun:test"
import { Session } from "."
import {
  annotateSmartRunnerTraceSuggestion,
  annotateSmartRunnerTraceAssist,
  applySmartRunnerBoundedAssist,
  buildSmartRunnerGovernorContext,
  prefixSmartRunnerText,
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
      }).decision.text,
    ).toContain("Smart Runner preflight: debug before execution.")

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

  it("records whether assist was actually applied", () => {
    const assist = applySmartRunnerBoundedAssist({
      enabled: true,
      decision: {
        continue: true,
        reason: "todo_in_progress",
        text: "Continue the task already in progress.",
        todo: { id: "t1", content: "finish current slice", status: "in_progress", priority: "high" },
      },
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
    })

    const traced = annotateSmartRunnerTraceAssist({
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_in_progress",
      },
      enabled: true,
      assist,
      originalText: "Continue the task already in progress.",
    })

    expect(traced.assist).toEqual({
      enabled: true,
      applied: true,
      mode: "debug_preflight_first",
      finalTextChanged: true,
      narrationUsed: true,
    })
  })

  it("annotates replan suggestions without changing control flow", () => {
    const trace = annotateSmartRunnerTraceSuggestion({
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_pending",
        decision: {
          situation: "plan_invalid",
          assessment: "Plan drifted",
          decision: "replan",
          reason: "The current todo ordering no longer matches the latest task state",
          nextAction: {
            kind: "replan_todos",
            todoID: "t2",
            skillHints: ["agent-workflow"],
            narration: "Suggesting a replan before continuing.",
          },
          needsUserInput: false,
          confidence: "high",
        },
      },
    })

    expect(trace.suggestion).toEqual({
      kind: "replan",
      reason: "The current todo ordering no longer matches the latest task state",
      suggestedTodoID: "t2",
      suggestedAction: "replan_todos",
      replanRequest: {
        targetTodoID: "t2",
        requestedAction: "replan_todos",
        proposedNextStep: "Re-evaluate todo t2 before continuing.",
        note: "The current todo ordering no longer matches the latest task state",
      },
    })
  })

  it("annotates ask-user suggestions without changing control flow", () => {
    const trace = annotateSmartRunnerTraceSuggestion({
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_pending",
        decision: {
          situation: "waiting_for_human",
          assessment: "Needs clarification",
          decision: "ask_user",
          reason: "The next step depends on a product choice the current context does not resolve",
          nextAction: {
            kind: "request_user_input",
            todoID: "t3",
            skillHints: [],
            narration: "Suggesting a user clarification before continuing.",
          },
          needsUserInput: true,
          confidence: "high",
        },
      },
    })

    expect(trace.suggestion).toEqual({
      kind: "ask_user",
      reason: "The next step depends on a product choice the current context does not resolve",
      suggestedTodoID: "t3",
      suggestedAction: "request_user_input",
      draftQuestion: "Suggesting a user clarification before continuing.",
    })
  })

  it("turns docs sync assist into an explicit preflight continuation", () => {
    const assist = applySmartRunnerBoundedAssist({
      enabled: true,
      decision: {
        continue: true,
        reason: "todo_pending",
        text: "Continue with the next planned step.",
        todo: { id: "t2", content: "implement the next slice", status: "pending", priority: "high" },
      },
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_pending",
        decision: {
          situation: "context_gap",
          assessment: "Refresh docs first",
          decision: "docs_sync_first",
          reason: "Need docs alignment before continuing",
          nextAction: {
            kind: "request_docs_sync",
            skillHints: ["doc-coauthoring"],
            narration: "Refreshing docs context before the next implementation step.",
          },
          needsUserInput: false,
          confidence: "high",
        },
      },
    })

    expect(assist.applied).toBe(true)
    expect(assist.mode).toBe("docs_sync_first")
    expect(assist.decision.text).toContain("Smart Runner preflight: docs sync before execution.")
    expect(assist.decision.text).toContain("implement the next slice")
  })

  it("prefixes Smart Runner loop-authored text with [AI]", () => {
    expect(prefixSmartRunnerText("continue the step")).toBe("[AI] continue the step")
    expect(prefixSmartRunnerText("[AI] already labeled")).toBe("[AI] already labeled")
  })
})
