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

const hasDom = typeof document !== "undefined"

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
  test.if(hasDom)("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test.if(hasDom)("falls back to terminal element focus", () => {
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
  test("surfaces current objective, chips, and simplified process lines", () => {
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
      autonomousHealth: {
        state: "waiting_user",
        stopReason: "wait_subagent",
        queue: {
          hasPendingContinuation: true,
          roundCount: 2,
          reason: "todo_in_progress",
          queuedAt: 1,
        },
        supervisor: {
          consecutiveResumeFailures: 2,
          retryAt: 60_000,
          lastResumeCategory: "provider_rate_limit",
          lastResumeError: "rate limited",
        },
        anomalies: {
          recentCount: 1,
          latestEventType: "workflow.unreconciled_wait_subagent",
          latestAt: 65_000,
          flags: ["unreconciled_wait_subagent"],
          countsByType: { "workflow.unreconciled_wait_subagent": 1 },
        },
        summary: {
          health: "degraded",
          label: "Degraded: workflow.unreconciled_wait_subagent",
        },
      },
    })
    expect(summary).toMatchObject({
      currentStep: {
        id: "b",
        content: "wait for subagent result",
      },
      methodChips: [
        { label: "wait", tone: "info" },
        { label: "waiting: subagent", tone: "neutral" },
      ],
    })
    expect(summary.processLines).toContain("Workflow: Waiting")
    expect(summary.processLines).toContain("Stop: Wait subagent")
    expect(summary.processLines).toContain("Runtime: busy")
    expect(summary.processLines).toContain("Health: Degraded: workflow.unreconciled_wait_subagent")
    expect(summary.processLines).toContain("Queue: Todo in progress (round 2)")
    expect(summary.processLines).toContain("Anomalies: 1")
    expect(summary.processLines).toContain("Latest anomaly: workflow.unreconciled_wait_subagent")
    expect(summary.processLines).toContain("Lease: supervisor:test")
    expect(summary.processLines).toContain("Resume failures: 2")
    expect(summary.processLines).toContain("Last category: provider_rate_limit")
    expect(summary.processLines).toContain("Last error: rate limited")
  })

  test("returns minimal summary when no workflow/todos exist", () => {
    expect(getSessionStatusSummary({})).toEqual({
      currentStep: undefined,
      methodChips: [],
      processLines: [],
    })
  })
})
