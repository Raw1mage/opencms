import { describe, expect, test } from "bun:test"
import {
  combineCommandSections,
  createOpenReviewFile,
  focusTerminalById,
  getSessionArbitrationChips,
  getSessionStatusSummary,
  getSessionWorkflowChips,
  getTabReorderIndex,
} from "./helpers"

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => {
        calls.push(`load:${path}`)
      },
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("combineCommandSections", () => {
  test("keeps section order stable", () => {
    const result = combineCommandSections([
      [{ id: "a", title: "A" }],
      [
        { id: "b", title: "B" },
        { id: "c", title: "C" },
      ],
    ])

    expect(result.map((item) => item.id)).toEqual(["a", "b", "c"])
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("getSessionWorkflowChips", () => {
  test("returns empty when workflow metadata is absent", () => {
    expect(getSessionWorkflowChips(undefined)).toEqual([])
  })

  test("summarizes autonomous workflow and stop reason for session header visibility", () => {
    expect(
      getSessionWorkflowChips({
        workflow: {
          autonomous: { enabled: true },
          state: "waiting_user",
          stopReason: "max_continuous_rounds",
        },
      }),
    ).toEqual([
      { label: "Auto", tone: "info" },
      { label: "Model auto", tone: "info" },
      { label: "Waiting", tone: "neutral" },
      { label: "Max continuous rounds", tone: "neutral" },
    ])
  })

  test("highlights blocked workflow reasons", () => {
    expect(
      getSessionWorkflowChips({
        workflow: {
          autonomous: { enabled: true },
          state: "blocked",
          stopReason: "resume_failed:provider_exhausted",
        },
      }),
    ).toEqual([
      { label: "Auto", tone: "info" },
      { label: "Model auto", tone: "info" },
      { label: "Blocked", tone: "warning" },
      { label: "Resume failed: provider exhausted", tone: "warning" },
    ])
  })
})

describe("getSessionArbitrationChips", () => {
  test("returns chips from latest arbitration trace metadata", () => {
    expect(
      getSessionArbitrationChips({
        userParts: [
          {
            id: "p1",
            sessionID: "s1",
            messageID: "m1",
            type: "text",
            text: "continue",
            metadata: {
              modelArbitration: {
                selected: {
                  providerId: "google",
                  modelID: "gemini-2.5-pro",
                  source: "rotation_rescue",
                },
              },
            },
          } as any,
        ],
      }),
    ).toEqual([
      { label: "rotation rescue", tone: "info" },
      { label: "google/gemini-2.5-pro", tone: "neutral" },
    ])
  })
})

describe("getSessionStatusSummary", () => {
  test("surfaces current objective, method chips, process, and latest result", () => {
    expect(
      getSessionStatusSummary({
        session: {
          workflow: {
            autonomous: { enabled: true },
            state: "waiting_user",
            stopReason: "wait_subagent",
            supervisor: {
              leaseOwner: "supervisor:test",
              retryAt: 60_000,
              consecutiveResumeFailures: 2,
              lastResumeCategory: "provider_rate_limit",
              lastResumeError: "rate limited",
              lastGovernorTraceAt: 65_000,
              lastGovernorTrace: {
                status: "advisory",
                deterministicReason: "todo_in_progress",
                assessment: "Needs preflight",
                assist: { enabled: true, applied: true, mode: "debug_preflight_first" },
                suggestion: {
                  kind: "ask_user",
                  reason: "The next step depends on a product choice the current context does not resolve",
                  suggestedTodoID: "t3",
                  suggestedAction: "request_user_input",
                  draftQuestion: "Should we keep the current product behavior or switch to the new flow?",
                  askUserHandoff: {
                    question: "Should we keep the current product behavior or switch to the new flow?",
                    whyNow: "The next step depends on a product choice the current context does not resolve",
                    blockingDecision: "Need a decision before continuing todo t3.",
                    impactIfUnanswered:
                      "Autonomous progress may continue in the wrong direction or stall on an unresolved product choice.",
                  },
                  askUserAdoption: {
                    proposalID: "ask-user:t3",
                    proposedQuestion: "Should we keep the current product behavior or switch to the new flow?",
                    targetTodoID: "t3",
                    rationale: "The next step depends on a product choice the current context does not resolve",
                    adoptionNote:
                      "Host may adopt this proposal into a real user question if the current loop should pause for clarification.",
                    hostAdopted: false,
                    hostAdoptionReason: "question_already_pending",
                    policy: {
                      trustLevel: "medium",
                      adoptionMode: "user_confirm_required",
                      requiresUserConfirm: true,
                      requiresHostReview: true,
                    },
                  },
                },
                decision: {
                  decision: "debug_preflight_first",
                  confidence: "high",
                  nextAction: { kind: "request_debug_preflight", narration: "Run debug preflight." },
                },
              },
              governorTraceHistory: [
                {
                  createdAt: 64_000,
                  status: "advisory",
                  deterministicReason: "todo_pending",
                  assessment: "Start next step cleanly",
                  assist: { enabled: true, applied: false },
                  suggestion: {
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
                      hostAdopted: true,
                      hostAdoptionReason: "adopted",
                    },
                  },
                  decision: {
                    decision: "continue",
                    confidence: "medium",
                    nextAction: { kind: "start_next_todo", narration: "Start the next todo." },
                  },
                },
                {
                  createdAt: 65_000,
                  status: "advisory",
                  deterministicReason: "todo_in_progress",
                  assessment: "Needs preflight",
                  assist: { enabled: true, applied: true, mode: "debug_preflight_first" },
                  suggestion: {
                    kind: "ask_user",
                    reason: "The next step depends on a product choice the current context does not resolve",
                    suggestedTodoID: "t3",
                    suggestedAction: "request_user_input",
                    draftQuestion: "Should we keep the current product behavior or switch to the new flow?",
                    askUserHandoff: {
                      question: "Should we keep the current product behavior or switch to the new flow?",
                      whyNow: "The next step depends on a product choice the current context does not resolve",
                      blockingDecision: "Need a decision before continuing todo t3.",
                      impactIfUnanswered:
                        "Autonomous progress may continue in the wrong direction or stall on an unresolved product choice.",
                    },
                    askUserAdoption: {
                      proposalID: "ask-user:t3",
                      proposedQuestion: "Should we keep the current product behavior or switch to the new flow?",
                      targetTodoID: "t3",
                      rationale: "The next step depends on a product choice the current context does not resolve",
                      adoptionNote:
                        "Host may adopt this proposal into a real user question if the current loop should pause for clarification.",
                    },
                  },
                  decision: {
                    decision: "debug_preflight_first",
                    confidence: "high",
                    nextAction: { kind: "request_debug_preflight", narration: "Run debug preflight." },
                  },
                },
              ],
            },
          },
        },
        status: { type: "busy" },
        todos: [
          {
            id: "a",
            content: "delegate API audit",
            status: "completed",
            priority: "medium",
          },
          {
            id: "b",
            content: "wait for subagent result",
            status: "in_progress",
            priority: "high",
            action: { kind: "wait", waitingOn: "subagent" },
          },
        ] as any,
        messages: [
          {
            id: "m2",
            sessionID: "s1",
            role: "assistant",
            parentID: "u1",
            modelID: "gpt-5",
            providerId: "openai",
            mode: "default",
            agent: "coding",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 2 },
          },
        ] as any,
        partsByMessage: {
          m2: [
            {
              id: "p2",
              sessionID: "s1",
              messageID: "m2",
              type: "text",
              text: "Paused: a delegated subagent task is still running.",
              synthetic: true,
              metadata: { autonomousNarration: true, narrationKind: "pause", excludeFromModel: true },
            },
          ] as any,
        },
      }),
    ).toMatchObject({
      currentStep: {
        id: "b",
        content: "wait for subagent result",
        status: "in_progress",
        priority: "high",
        action: { kind: "wait", waitingOn: "subagent" },
      },
      methodChips: [
        { label: "wait", tone: "info" },
        { label: "waiting: subagent", tone: "neutral" },
      ],
      processLines: ["Workflow: Waiting", "Stop: Wait subagent", "Runtime: busy"],
      latestNarration: { label: "Paused: a delegated subagent task is still running.", tone: "warning" },
      latestResult: { label: "Completed: delegate API audit", tone: "success" },
    })

    const summary = getSessionStatusSummary({
      session: {
        workflow: {
          autonomous: { enabled: true },
          state: "waiting_user",
          stopReason: "wait_subagent",
          supervisor: {
            leaseOwner: "supervisor:test",
            retryAt: 60_000,
            consecutiveResumeFailures: 2,
            lastResumeCategory: "provider_rate_limit",
            lastResumeError: "rate limited",
            lastGovernorTraceAt: 65_000,
            lastGovernorTrace: {
              status: "advisory",
              deterministicReason: "todo_in_progress",
              assessment: "Needs preflight",
              assist: { enabled: true, applied: true, mode: "debug_preflight_first" },
              suggestion: {
                kind: "ask_user",
                reason: "The next step depends on a product choice the current context does not resolve",
                suggestedTodoID: "t3",
                suggestedAction: "request_user_input",
                draftQuestion: "Should we keep the current product behavior or switch to the new flow?",
                askUserHandoff: {
                  question: "Should we keep the current product behavior or switch to the new flow?",
                  whyNow: "The next step depends on a product choice the current context does not resolve",
                  blockingDecision: "Need a decision before continuing todo t3.",
                  impactIfUnanswered:
                    "Autonomous progress may continue in the wrong direction or stall on an unresolved product choice.",
                },
                askUserAdoption: {
                  proposalID: "ask-user:t3",
                  proposedQuestion: "Should we keep the current product behavior or switch to the new flow?",
                  targetTodoID: "t3",
                  rationale: "The next step depends on a product choice the current context does not resolve",
                  adoptionNote:
                    "Host may adopt this proposal into a real user question if the current loop should pause for clarification.",
                  hostAdopted: false,
                  hostAdoptionReason: "question_already_pending",
                  policy: {
                    trustLevel: "medium",
                    adoptionMode: "user_confirm_required",
                    requiresUserConfirm: true,
                    requiresHostReview: true,
                  },
                },
              },
              decision: {
                decision: "debug_preflight_first",
                confidence: "high",
                nextAction: { kind: "request_debug_preflight", narration: "Run debug preflight." },
              },
            },
            governorTraceHistory: [
              {
                createdAt: 64_000,
                status: "advisory",
                deterministicReason: "todo_pending",
                assessment: "Start next step cleanly",
                assist: { enabled: true, applied: false },
                suggestion: {
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
                    hostAdopted: true,
                    hostAdoptionReason: "adopted",
                  },
                },
                decision: {
                  decision: "continue",
                  confidence: "medium",
                  nextAction: { kind: "start_next_todo", narration: "Start the next todo." },
                },
              },
              {
                createdAt: 65_000,
                status: "advisory",
                deterministicReason: "todo_in_progress",
                assessment: "Needs preflight",
                assist: { enabled: true, applied: true, mode: "debug_preflight_first" },
                suggestion: {
                  kind: "ask_user",
                  reason: "The next step depends on a product choice the current context does not resolve",
                  suggestedTodoID: "t3",
                  suggestedAction: "request_user_input",
                  draftQuestion: "Should we keep the current product behavior or switch to the new flow?",
                  askUserHandoff: {
                    question: "Should we keep the current product behavior or switch to the new flow?",
                    whyNow: "The next step depends on a product choice the current context does not resolve",
                    blockingDecision: "Need a decision before continuing todo t3.",
                    impactIfUnanswered:
                      "Autonomous progress may continue in the wrong direction or stall on an unresolved product choice.",
                  },
                  askUserAdoption: {
                    proposalID: "ask-user:t3",
                    proposedQuestion: "Should we keep the current product behavior or switch to the new flow?",
                    targetTodoID: "t3",
                    rationale: "The next step depends on a product choice the current context does not resolve",
                    adoptionNote:
                      "Host may adopt this proposal into a real user question if the current loop should pause for clarification.",
                    hostAdopted: false,
                    hostAdoptionReason: "question_already_pending",
                    policy: {
                      trustLevel: "medium",
                      adoptionMode: "user_confirm_required",
                      requiresUserConfirm: true,
                      requiresHostReview: true,
                    },
                  },
                },
                decision: {
                  decision: "debug_preflight_first",
                  confidence: "high",
                  nextAction: { kind: "request_debug_preflight", narration: "Run debug preflight." },
                },
              },
            ],
          },
        },
      },
      status: { type: "busy" },
      todos: [
        {
          id: "a",
          content: "delegate API audit",
          status: "completed",
          priority: "medium",
        },
        {
          id: "b",
          content: "wait for subagent result",
          status: "in_progress",
          priority: "high",
          action: { kind: "wait", waitingOn: "subagent" },
        },
      ] as any,
      messages: [
        {
          id: "m2",
          sessionID: "s1",
          role: "assistant",
          parentID: "u1",
          modelID: "gpt-5",
          providerId: "openai",
          mode: "default",
          agent: "coding",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        },
      ] as any,
      partsByMessage: {
        m2: [
          {
            id: "p2",
            sessionID: "s1",
            messageID: "m2",
            type: "text",
            text: "Paused: a delegated subagent task is still running.",
            synthetic: true,
            metadata: { autonomousNarration: true, narrationKind: "pause", excludeFromModel: true },
          },
        ] as any,
      },
    })

    expect(summary.debugLines).toEqual([
      "Lease: supervisor:test",
      expect.stringMatching(/^Retry at: \d{2}:\d{2}:\d{2}$/),
      "Resume failures: 2",
      "Last category: provider_rate_limit",
      "Last error: rate limited",
      "Governor: advisory",
      "Governor decision: debug_preflight_first (high)",
      "Governor next: request_debug_preflight",
      "Smart Runner assist: applied (debug_preflight_first)",
      "Smart Runner suggestion: ask_user (request_user_input)",
      "Ask-user why: The next step depends on a product choice the current context does not resolve",
      "Ask-user draft: Should we keep the current product behavior or switch to the new flow?",
      "Ask-user handoff: Need a decision before continuing todo t3.",
      "Ask-user proposal: ask-user:t3",
      "Ask-user policy: user_confirm_required (medium)",
      "Ask-user adoption: question already pending",
      expect.stringMatching(/^Governor at: \d{2}:\d{2}:\d{2}$/),
    ])
    expect(summary.smartRunnerHistory).toEqual([
      {
        time: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/),
        status: "advisory",
        decision: "debug_preflight_first",
        confidence: "high",
        next: "request_debug_preflight",
        assessment: "Needs preflight",
        assist: "applied · debug_preflight_first",
        suggestion:
          "ask_user · request_user_input · The next step depends on a product choice the current context does not resolve",
        draftQuestion: "Should we keep the current product behavior or switch to the new flow?",
        askUserHandoff: "Need a decision before continuing todo t3.",
        askUserAdoption: "ask-user:t3",
        replanRequest: undefined,
        replanAdoption: undefined,
        policy: "user_confirm_required · medium",
        adoptionOutcome: "not adopted · question already pending",
        error: undefined,
      },
      {
        time: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/),
        status: "advisory",
        decision: "continue",
        confidence: "medium",
        next: "start_next_todo",
        assessment: "Start next step cleanly",
        assist: "noop",
        suggestion: "replan · replan_todos · The current todo ordering no longer matches the latest task state",
        draftQuestion: undefined,
        askUserHandoff: undefined,
        askUserAdoption: undefined,
        replanRequest: "Re-evaluate todo t2 before continuing.",
        replanAdoption: "replan:t2 · adopted",
        policy: "host_adoptable · medium",
        adoptionOutcome: "adopted",
        error: undefined,
      },
    ])
    expect(summary.smartRunnerSummary).toEqual({
      total: 2,
      assistApplied: 1,
      assistNoop: 1,
      docsSync: 0,
      debugPreflight: 1,
      pauseAssist: 0,
      replan: 1,
      askUser: 1,
      requestApproval: 0,
      pauseForRisk: 0,
      complete: 0,
      pause: 0,
      adopted: 1,
      notAdopted: 1,
      nonAdoptedReasons: [{ reason: "question_already_pending", count: 1 }],
      recentTrend: ["continue → replan", "debug_preflight_first → ask_user"],
    })
  })

  test("surfaces non-adopted replan reasons in debug and history", () => {
    const summary = getSessionStatusSummary({
      session: {
        workflow: {
          supervisor: {
            lastGovernorTrace: {
              status: "advisory",
              suggestion: {
                kind: "replan",
                reason: "Need re-evaluation",
                suggestedAction: "replan_todos",
                replanAdoption: {
                  proposalID: "replan:t9",
                  policy: {
                    trustLevel: "medium",
                    adoptionMode: "host_adoptable",
                    requiresUserConfirm: false,
                    requiresHostReview: true,
                  },
                  hostAdopted: false,
                  hostAdoptionReason: "active_todo_in_progress",
                },
              },
            },
            governorTraceHistory: [
              {
                createdAt: 70_000,
                status: "advisory",
                suggestion: {
                  kind: "replan",
                  reason: "Need re-evaluation",
                  suggestedAction: "replan_todos",
                  replanAdoption: {
                    proposalID: "replan:t9",
                    policy: {
                      trustLevel: "medium",
                      adoptionMode: "host_adoptable",
                      requiresUserConfirm: false,
                      requiresHostReview: true,
                    },
                    hostAdopted: false,
                    hostAdoptionReason: "active_todo_in_progress",
                  },
                },
              },
            ],
          },
        },
      } as any,
    })

    expect(summary.debugLines).toContain("Replan proposal: replan:t9")
    expect(summary.debugLines).toContain("Replan adoption: active todo in progress")
    expect(summary.smartRunnerHistory[0]).toMatchObject({
      replanAdoption: "replan:t9",
      policy: "host_adoptable · medium",
      adoptionOutcome: "not adopted · active todo in progress",
    })
  })

  test("surfaces approval, risk-pause, and complete adoption traces in summary and history", () => {
    const summary = getSessionStatusSummary({
      session: {
        workflow: {
          supervisor: {
            lastGovernorTraceAt: 80_000,
            lastGovernorTrace: {
              status: "advisory",
              suggestion: {
                kind: "complete",
                reason: "Current slice is done",
                suggestedAction: "continue_current",
                completionRequest: {
                  proposalID: "complete:t5",
                  policy: {
                    trustLevel: "medium",
                    adoptionMode: "host_adoptable",
                    requiresUserConfirm: false,
                    requiresHostReview: true,
                  },
                  hostAdopted: false,
                  hostAdoptionReason: "not_terminal_after_completion",
                },
              },
            },
            governorTraceHistory: [
              {
                createdAt: 78_000,
                status: "advisory",
                decision: {
                  decision: "request_approval",
                  confidence: "high",
                  nextAction: { kind: "request_approval" },
                },
                suggestion: {
                  kind: "request_approval",
                  reason: "Needs approval",
                  suggestedAction: "request_approval",
                  approvalRequest: {
                    proposalID: "approval:t9",
                    policy: {
                      trustLevel: "medium",
                      adoptionMode: "host_adoptable",
                      requiresUserConfirm: false,
                      requiresHostReview: true,
                    },
                    hostAdopted: true,
                    hostAdoptionReason: "adopted",
                  },
                },
              },
              {
                createdAt: 79_000,
                status: "advisory",
                decision: { decision: "pause_for_risk", confidence: "high", nextAction: { kind: "pause_for_risk" } },
                suggestion: {
                  kind: "pause_for_risk",
                  reason: "Needs review",
                  suggestedAction: "pause_for_risk",
                  riskPauseRequest: {
                    proposalID: "risk-pause:t7",
                    policy: {
                      trustLevel: "medium",
                      adoptionMode: "host_adoptable",
                      requiresUserConfirm: false,
                      requiresHostReview: true,
                    },
                    hostAdopted: true,
                    hostAdoptionReason: "adopted",
                  },
                },
              },
              {
                createdAt: 80_000,
                status: "advisory",
                decision: { decision: "complete", confidence: "high", nextAction: { kind: "continue_current" } },
                suggestion: {
                  kind: "complete",
                  reason: "Current slice is done",
                  suggestedAction: "continue_current",
                  completionRequest: {
                    proposalID: "complete:t5",
                    policy: {
                      trustLevel: "medium",
                      adoptionMode: "host_adoptable",
                      requiresUserConfirm: false,
                      requiresHostReview: true,
                    },
                    hostAdopted: false,
                    hostAdoptionReason: "not_terminal_after_completion",
                  },
                },
              },
            ],
          },
        },
      } as any,
    })

    expect(summary.debugLines).toContain("Complete proposal: complete:t5")
    expect(summary.debugLines).toContain("Complete adoption: not terminal after completion")
    expect(summary.smartRunnerHistory[0]).toMatchObject({
      completionRequest: "complete:t5",
      policy: "host_adoptable · medium",
      adoptionOutcome: "not adopted · not terminal after completion",
    })
    expect(summary.smartRunnerHistory[1]).toMatchObject({
      riskPauseRequest: "risk-pause:t7 · adopted",
      adoptionOutcome: "adopted",
    })
    expect(summary.smartRunnerHistory[2]).toMatchObject({
      approvalRequest: "approval:t9 · adopted",
      adoptionOutcome: "adopted",
    })
    expect(summary.smartRunnerSummary).toMatchObject({
      requestApproval: 1,
      pauseForRisk: 1,
      complete: 1,
      pause: 0,
      pauseAssist: 0,
      adopted: 2,
      notAdopted: 1,
      nonAdoptedReasons: [{ reason: "not_terminal_after_completion", count: 1 }],
    })
  })

  test("surfaces advisory pause suggestions in debug and history without adoption semantics", () => {
    const summary = getSessionStatusSummary({
      session: {
        workflow: {
          supervisor: {
            lastGovernorTrace: {
              status: "advisory",
              decision: { decision: "pause", confidence: "medium", nextAction: { kind: "request_user_input" } },
              suggestion: {
                kind: "pause",
                reason: "Current evidence is too weak to continue safely",
                suggestedAction: "request_user_input",
                pauseRequest: {
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
              },
            },
            governorTraceHistory: [
              {
                createdAt: 81_000,
                status: "advisory",
                decision: { decision: "pause", confidence: "medium", nextAction: { kind: "request_user_input" } },
                suggestion: {
                  kind: "pause",
                  reason: "Current evidence is too weak to continue safely",
                  suggestedAction: "request_user_input",
                  pauseRequest: {
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
                },
              },
            ],
          },
        },
      } as any,
    })

    expect(summary.debugLines).toContain("Pause why: Current evidence is too weak to continue safely")
    expect(summary.debugLines).toContain("Pause scope: Pause around todo t8 until a clearer next step exists.")
    expect(summary.smartRunnerHistory[0]).toMatchObject({
      suggestion: "pause · request_user_input · Current evidence is too weak to continue safely",
      pauseRequest: "Pause around todo t8 until a clearer next step exists.",
      policy: "advisory_only · medium",
      adoptionOutcome: undefined,
    })
    expect(summary.smartRunnerSummary).toMatchObject({
      pause: 1,
      adopted: 0,
      notAdopted: 0,
      nonAdoptedReasons: [],
    })
  })

  test("counts advisory pause assist mode in Smart Runner summary", () => {
    const summary = getSessionStatusSummary({
      session: {
        workflow: {
          supervisor: {
            governorTraceHistory: [
              {
                createdAt: 82_000,
                status: "advisory",
                assist: {
                  enabled: true,
                  applied: true,
                  mode: "pause",
                },
                decision: { decision: "pause", confidence: "medium", nextAction: { kind: "request_user_input" } },
                suggestion: {
                  kind: "pause",
                  reason: "Current evidence is too weak to continue safely",
                  suggestedAction: "request_user_input",
                },
              },
            ],
          },
        },
      } as any,
    })

    expect(summary.smartRunnerSummary).toMatchObject({
      assistApplied: 1,
      pauseAssist: 1,
      pause: 1,
      nonAdoptedReasons: [],
    })
    expect(summary.smartRunnerHistory[0]).toMatchObject({
      assist: "applied · pause",
      suggestion: "pause · request_user_input · Current evidence is too weak to continue safely",
    })
  })

  test("aggregates repeated non-adopted reasons across Smart Runner history", () => {
    const summary = getSessionStatusSummary({
      session: {
        workflow: {
          supervisor: {
            governorTraceHistory: [
              {
                createdAt: 83_000,
                status: "advisory",
                suggestion: {
                  kind: "request_approval",
                  reason: "Needs approval",
                  approvalRequest: {
                    proposalID: "approval:t1",
                    hostAdopted: false,
                    hostAdoptionReason: "policy_not_host_adoptable",
                  },
                },
              },
              {
                createdAt: 84_000,
                status: "advisory",
                suggestion: {
                  kind: "pause_for_risk",
                  reason: "Needs review",
                  riskPauseRequest: {
                    proposalID: "risk-pause:t2",
                    hostAdopted: false,
                    hostAdoptionReason: "policy_not_host_adoptable",
                  },
                },
              },
              {
                createdAt: 85_000,
                status: "advisory",
                suggestion: {
                  kind: "complete",
                  reason: "Not terminal yet",
                  completionRequest: {
                    proposalID: "complete:t3",
                    hostAdopted: false,
                    hostAdoptionReason: "not_terminal_after_completion",
                  },
                },
              },
            ],
          },
        },
      } as any,
    })

    expect(summary.smartRunnerSummary).toMatchObject({
      notAdopted: 3,
      nonAdoptedReasons: [
        { reason: "policy_not_host_adoptable", count: 2 },
        { reason: "not_terminal_after_completion", count: 1 },
      ],
    })
  })

  test("prefers synthesized task result over plain todo completion when available", () => {
    expect(
      getSessionStatusSummary({
        todos: [
          {
            id: "a",
            content: "implement feature",
            status: "completed",
            priority: "high",
          },
        ] as any,
        messages: [
          {
            id: "m1",
            sessionID: "s1",
            role: "assistant",
            parentID: "u1",
            modelID: "gpt-5",
            providerId: "openai",
            mode: "default",
            agent: "coding",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1 },
          },
        ] as any,
        partsByMessage: {
          m1: [
            {
              id: "p1",
              sessionID: "s1",
              messageID: "m1",
              type: "tool",
              callID: "c1",
              tool: "task",
              state: {
                status: "completed",
                output: "done",
                time: { start: 1, end: 2 },
              },
              metadata: {
                modelArbitration: {
                  selected: { providerId: "google", modelID: "gemini-2.5-pro" },
                },
              },
            },
          ] as any,
        },
      }),
    ).toMatchObject({
      debugLines: [],
      smartRunnerSummary: undefined,
      smartRunnerHistory: [],
      latestResult: { label: "Task completed · google/gemini-2.5-pro", tone: "success" },
    })
  })
})
