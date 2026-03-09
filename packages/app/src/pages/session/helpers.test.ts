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
        replanRequest: "Re-evaluate todo t2 before continuing.",
        error: undefined,
      },
    ])
    expect(summary.smartRunnerSummary).toEqual({
      total: 2,
      assistApplied: 1,
      assistNoop: 1,
      docsSync: 0,
      debugPreflight: 1,
      replan: 1,
      askUser: 1,
      recentTrend: ["continue → replan", "debug_preflight_first → ask_user"],
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
