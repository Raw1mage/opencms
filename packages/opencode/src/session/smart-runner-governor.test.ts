import { describe, expect, it } from "bun:test"
import { Session } from "."
import {
  annotateSmartRunnerApprovalAdoption,
  annotateSmartRunnerAskUserAdoption,
  annotateSmartRunnerCompletionAdoption,
  annotateSmartRunnerRiskPauseAdoption,
  annotateSmartRunnerReplanAdoption,
  annotateSmartRunnerTraceSuggestion,
  annotateSmartRunnerTraceAssist,
  applySmartRunnerBoundedAssist,
  evaluateSmartRunnerAskUserAdoption,
  evaluateSmartRunnerHostAdoptionPolicy,
  buildSmartRunnerGovernorContext,
  getSmartRunnerAskUserQuestionText,
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
      replanAdoption: {
        proposalID: "replan:t2",
        targetTodoID: "t2",
        proposedAction: "replan_todos",
        proposedNextStep: "Host may adopt a replan around todo t2 before continuing.",
        rationale: "The current todo ordering no longer matches the latest task state",
        adoptionNote:
          "Host may adopt this proposal into a real todo replan if current execution no longer matches the plan.",
        policy: {
          trustLevel: "medium",
          adoptionMode: "host_adoptable",
          requiresUserConfirm: false,
          requiresHostReview: true,
        },
      },
    })
  })

  it("marks when a replan proposal was host-adopted", () => {
    const trace = annotateSmartRunnerReplanAdoption({
      adopted: true,
      reason: "adopted",
      trace: annotateSmartRunnerTraceSuggestion({
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
      }),
    })

    expect(trace.suggestion?.replanAdoption?.hostAdopted).toBe(true)
    expect(trace.suggestion?.replanAdoption?.hostAdoptionReason).toBe("adopted")
  })

  it("records non-adopted replan reasons for host observability", () => {
    const trace = annotateSmartRunnerReplanAdoption({
      adopted: false,
      reason: "dependencies_not_ready",
      trace: annotateSmartRunnerTraceSuggestion({
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
      }),
    })

    expect(trace.suggestion?.replanAdoption?.hostAdopted).toBe(false)
    expect(trace.suggestion?.replanAdoption?.hostAdoptionReason).toBe("dependencies_not_ready")
  })

  it("marks when an ask-user proposal was host-adopted", () => {
    const trace = annotateSmartRunnerAskUserAdoption({
      adopted: true,
      reason: "adopted",
      trace: annotateSmartRunnerTraceSuggestion({
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
      }),
    })

    expect(trace.suggestion?.askUserAdoption?.hostAdopted).toBe(true)
    expect(trace.suggestion?.askUserAdoption?.hostAdoptionReason).toBe("adopted")
  })

  it("records non-adopted ask-user reasons for host observability", () => {
    const trace = annotateSmartRunnerAskUserAdoption({
      adopted: false,
      reason: "question_already_pending",
      trace: annotateSmartRunnerTraceSuggestion({
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
      }),
    })

    expect(trace.suggestion?.askUserAdoption?.hostAdopted).toBe(false)
    expect(trace.suggestion?.askUserAdoption?.hostAdoptionReason).toBe("question_already_pending")
  })

  it("evaluates ask-user adoption gates from suggestion policy and pending question state", () => {
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

    expect(getSmartRunnerAskUserQuestionText({ suggestion: trace.suggestion })).toBe(
      "Suggesting a user clarification before continuing.",
    )
    expect(evaluateSmartRunnerAskUserAdoption({ suggestion: trace.suggestion, pendingQuestions: 0 })).toEqual({
      adopted: true,
      reason: "adopted",
      questionText: "Suggesting a user clarification before continuing.",
    })
    expect(evaluateSmartRunnerAskUserAdoption({ suggestion: trace.suggestion, pendingQuestions: 1 })).toEqual({
      adopted: false,
      reason: "question_already_pending",
      questionText: "Suggesting a user clarification before continuing.",
    })
  })

  it("rejects ask-user adoption when no usable question text exists", () => {
    expect(
      evaluateSmartRunnerAskUserAdoption({
        suggestion: {
          kind: "ask_user",
          reason: "Need clarification",
          askUserAdoption: {
            proposalID: "ask-user:t9",
            policy: {
              trustLevel: "medium",
              adoptionMode: "user_confirm_required",
              requiresUserConfirm: true,
              requiresHostReview: true,
            },
          },
        },
        pendingQuestions: 0,
      }),
    ).toEqual({
      adopted: false,
      reason: "missing_question",
      questionText: undefined,
    })
  })

  it("evaluates host-adoptable policy outcomes for approval-like proposals", () => {
    expect(evaluateSmartRunnerHostAdoptionPolicy({ adoptionMode: "host_adoptable", requiresHostReview: true })).toBe(
      "adopted",
    )
    expect(evaluateSmartRunnerHostAdoptionPolicy({ adoptionMode: "advisory_only", requiresHostReview: true })).toBe(
      "policy_not_host_adoptable",
    )
    expect(
      evaluateSmartRunnerHostAdoptionPolicy({
        adoptionMode: "host_adoptable",
        requiresUserConfirm: true,
        requiresHostReview: true,
      }),
    ).toBe("user_confirm_required")
    expect(evaluateSmartRunnerHostAdoptionPolicy({ adoptionMode: "host_adoptable", requiresHostReview: false })).toBe(
      "host_review_missing",
    )
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
      askUserHandoff: {
        question: "Suggesting a user clarification before continuing.",
        whyNow: "The next step depends on a product choice the current context does not resolve",
        blockingDecision: "Need a decision before continuing todo t3.",
        impactIfUnanswered:
          "Autonomous progress may continue in the wrong direction or stall on an unresolved product choice.",
      },
      askUserAdoption: {
        proposalID: "ask-user:t3",
        proposedQuestion: "Suggesting a user clarification before continuing.",
        targetTodoID: "t3",
        rationale: "The next step depends on a product choice the current context does not resolve",
        adoptionNote:
          "Host may adopt this proposal into a real user question if the current loop should pause for clarification.",
        policy: {
          trustLevel: "medium",
          adoptionMode: "user_confirm_required",
          requiresUserConfirm: true,
          requiresHostReview: true,
        },
      },
    })
  })

  it("annotates request-approval suggestions without changing control flow", () => {
    const trace = annotateSmartRunnerTraceSuggestion({
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_pending",
        decision: {
          situation: "waiting_for_human",
          assessment: "High-risk step needs approval",
          decision: "request_approval",
          reason: "The next step changes architecture and should be user-approved",
          nextAction: {
            kind: "request_approval",
            todoID: "t9",
            skillHints: [],
            narration: "Approval needed before continuing.",
          },
          needsUserInput: true,
          confidence: "high",
        },
      },
    })

    expect(trace.suggestion).toEqual(
      expect.objectContaining({
        kind: "request_approval",
        reason: "The next step changes architecture and should be user-approved",
        suggestedTodoID: "t9",
        suggestedAction: "request_approval",
        approvalRequest: {
          proposalID: "approval:t9",
          targetTodoID: "t9",
          rationale: "The next step changes architecture and should be user-approved",
          approvalScope: "Approval needed before continuing todo t9.",
          adoptionNote: "Host may adopt this proposal into a real approval pause before continuing execution.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        },
      }),
    )
  })

  it("marks when a request-approval proposal was host-adopted", () => {
    const trace = annotateSmartRunnerApprovalAdoption({
      trace: annotateSmartRunnerTraceSuggestion({
        trace: {
          source: "smart_runner_governor",
          dryRun: true,
          status: "advisory",
          createdAt: 1,
          deterministicReason: "todo_pending",
          decision: {
            situation: "waiting_for_human",
            assessment: "High-risk step needs approval",
            decision: "request_approval",
            reason: "The next step changes architecture and should be user-approved",
            nextAction: {
              kind: "request_approval",
              todoID: "t9",
              skillHints: [],
              narration: "Approval needed before continuing.",
            },
            needsUserInput: true,
            confidence: "high",
          },
        },
      }),
      adopted: true,
      reason: "adopted",
    })

    expect(trace.suggestion?.approvalRequest?.hostAdopted).toBe(true)
    expect(trace.suggestion?.approvalRequest?.hostAdoptionReason).toBe("adopted")
  })

  it("annotates pause-for-risk suggestions without changing control flow", () => {
    const trace = annotateSmartRunnerTraceSuggestion({
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_pending",
        decision: {
          situation: "execution_stalled",
          assessment: "The next step is risky enough to justify a deliberate review pause",
          decision: "pause_for_risk",
          reason: "The upcoming step touches shared workflow behavior and should pause for risk review",
          nextAction: {
            kind: "pause_for_risk",
            todoID: "t7",
            skillHints: ["code-thinker"],
            narration: "Pausing for a human risk review before continuing.",
          },
          needsUserInput: true,
          confidence: "high",
        },
      },
    })

    expect(trace.suggestion).toEqual(
      expect.objectContaining({
        kind: "pause_for_risk",
        reason: "The upcoming step touches shared workflow behavior and should pause for risk review",
        suggestedTodoID: "t7",
        suggestedAction: "pause_for_risk",
        riskPauseRequest: {
          proposalID: "risk-pause:t7",
          targetTodoID: "t7",
          rationale: "The upcoming step touches shared workflow behavior and should pause for risk review",
          riskSummary: "The next step is risky enough to justify a deliberate review pause",
          pauseScope: "Pause before continuing risky todo t7.",
          adoptionNote: "Host may adopt this proposal into a real risk pause before continuing execution.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        },
      }),
    )
  })

  it("marks when a pause-for-risk proposal was host-adopted", () => {
    const trace = annotateSmartRunnerRiskPauseAdoption({
      trace: annotateSmartRunnerTraceSuggestion({
        trace: {
          source: "smart_runner_governor",
          dryRun: true,
          status: "advisory",
          createdAt: 1,
          deterministicReason: "todo_pending",
          decision: {
            situation: "execution_stalled",
            assessment: "The next step is risky enough to justify a deliberate review pause",
            decision: "pause_for_risk",
            reason: "The upcoming step touches shared workflow behavior and should pause for risk review",
            nextAction: {
              kind: "pause_for_risk",
              todoID: "t7",
              skillHints: ["code-thinker"],
              narration: "Pausing for a human risk review before continuing.",
            },
            needsUserInput: true,
            confidence: "high",
          },
        },
      }),
      adopted: true,
      reason: "adopted",
    })

    expect(trace.suggestion?.riskPauseRequest?.hostAdopted).toBe(true)
    expect(trace.suggestion?.riskPauseRequest?.hostAdoptionReason).toBe("adopted")
  })

  it("annotates complete suggestions without changing control flow", () => {
    const trace = annotateSmartRunnerTraceSuggestion({
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_in_progress",
        decision: {
          situation: "completed",
          assessment: "The current slice looks finished",
          decision: "complete",
          reason: "The active todo appears done and no follow-up work looks actionable",
          nextAction: {
            kind: "continue_current",
            todoID: "t5",
            skillHints: [],
            narration: "Marking the current slice complete.",
          },
          needsUserInput: false,
          confidence: "high",
        },
      },
    })

    expect(trace.suggestion).toEqual(
      expect.objectContaining({
        kind: "complete",
        reason: "The active todo appears done and no follow-up work looks actionable",
        suggestedTodoID: "t5",
        suggestedAction: "continue_current",
        completionRequest: {
          proposalID: "complete:t5",
          targetTodoID: "t5",
          proposedAction: "mark_todo_complete",
          rationale: "The active todo appears done and no follow-up work looks actionable",
          completionScope: "Mark todo t5 complete if the current slice is truly done.",
          adoptionNote:
            "Host may adopt this proposal into a real todo completion only if re-evaluation confirms the workflow is terminal.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        },
      }),
    )
  })

  it("marks when a complete proposal was host-adopted", () => {
    const trace = annotateSmartRunnerCompletionAdoption({
      trace: annotateSmartRunnerTraceSuggestion({
        trace: {
          source: "smart_runner_governor",
          dryRun: true,
          status: "advisory",
          createdAt: 1,
          deterministicReason: "todo_in_progress",
          decision: {
            situation: "completed",
            assessment: "The current slice looks finished",
            decision: "complete",
            reason: "The active todo appears done and no follow-up work looks actionable",
            nextAction: {
              kind: "continue_current",
              todoID: "t5",
              skillHints: [],
              narration: "Marking the current slice complete.",
            },
            needsUserInput: false,
            confidence: "high",
          },
        },
      }),
      adopted: true,
      reason: "adopted",
    })

    expect(trace.suggestion?.completionRequest?.hostAdopted).toBe(true)
    expect(trace.suggestion?.completionRequest?.hostAdoptionReason).toBe("adopted")
  })

  it("annotates advisory pause suggestions without creating a host-adoption contract", () => {
    const trace = annotateSmartRunnerTraceSuggestion({
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_pending",
        decision: {
          situation: "execution_stalled",
          assessment: "The plan should pause until a clearer next step exists",
          decision: "pause",
          reason: "Current evidence is too weak to continue safely",
          nextAction: {
            kind: "request_user_input",
            todoID: "t8",
            skillHints: [],
            narration: "Pause and wait for a clearer next step.",
          },
          needsUserInput: true,
          confidence: "medium",
        },
      },
    })

    expect(trace.suggestion).toEqual(
      expect.objectContaining({
        kind: "pause",
        reason: "Current evidence is too weak to continue safely",
        suggestedTodoID: "t8",
        suggestedAction: "request_user_input",
        pauseRequest: {
          rationale: "Current evidence is too weak to continue safely",
          pauseScope: "Pause around todo t8 until a clearer next step exists.",
          advisoryNote:
            "This is an advisory-only Smart Runner pause suggestion; host should observe it but not auto-adopt it into a new stop contract.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "advisory_only",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        },
      }),
    )
  })

  it("turns advisory pause into a bounded pause-check continuation", () => {
    const assist = applySmartRunnerBoundedAssist({
      enabled: true,
      decision: {
        continue: true,
        reason: "todo_pending",
        text: "Continue with the next planned step.",
        todo: { id: "t8", content: "decide the next safe move", status: "pending", priority: "high" },
      },
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: 1,
        deterministicReason: "todo_pending",
        decision: {
          situation: "execution_stalled",
          assessment: "The plan should pause until a clearer next step exists",
          decision: "pause",
          reason: "Current evidence is too weak to continue safely",
          nextAction: {
            kind: "request_user_input",
            todoID: "t8",
            skillHints: [],
            narration: "Pause and wait for a clearer next step.",
          },
          needsUserInput: true,
          confidence: "medium",
        },
      },
    })

    expect(assist.applied).toBe(true)
    expect(assist.mode).toBe("pause")
    expect(assist.narration).toBe("Pause and wait for a clearer next step.")
    expect(assist.decision.text).toContain("Smart Runner pause check before execution.")
    expect(assist.decision.text).toContain("decide the next safe move")
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
