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
      }),
    ).toEqual({
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
      latestResult: { label: "Completed: delegate API audit", tone: "success" },
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
      latestResult: { label: "Task completed · google/gemini-2.5-pro", tone: "success" },
    })
  })
})
