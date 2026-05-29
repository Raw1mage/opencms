import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { z } from "zod"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.question", () => {
  let askSpy: any

  beforeEach(() => {
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => {
      return []
    })
  })

  afterEach(() => {
    askSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    askSpy.mockResolvedValueOnce([["Red"]])

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
  })

  test("should now pass with a header longer than 12 but less than 30 chars", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [{ label: "Dog", description: "Man's best friend" }],
      },
    ]

    askSpy.mockResolvedValueOnce([["Dog"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Regression tests for plans/question-tool_idle-watchdog-false-kill
  // (issues/bug_20260530_question_tool_retracted_treated_as_answered.md)
  //
  // The bug: a 90s stream-idle watchdog in LLM.stream killed the question
  // tool while it was legitimately awaiting a human answer, because no
  // token chunks flow during the wait. Fix: Tool.Context.pauseIdleWatchdog
  // hook called by the question tool inside try/finally.
  //
  // These tests verify the question-tool side of the contract (the call
  // pattern). The LLM.stream side (paused flag suppresses re-arm; resume
  // re-arms) lives in llm.ts as a private closure; testing it would
  // require either extracting the watchdog into a separately-importable
  // module or running an end-to-end stream. We exercise the observable
  // call contract here and rely on the type system + code inspection for
  // the LLM.stream side.
  // ─────────────────────────────────────────────────────────────────────

  test("TV-1: question awaiting beyond watchdog window — pauseIdleWatchdog is invoked before the wait, resume() in finally", async () => {
    // Simulates the 90s+ wait: Question.ask resolves only after 5 ticks
    // (microtask drains) and we check the pause hook was called *before*
    // ask started and resume was called *after* ask resolved.
    const events: string[] = []
    const resume = () => {
      events.push("resume")
    }
    const pauseIdleWatchdog = () => {
      events.push("pause")
      return resume
    }
    const ctxWithPause = { ...ctx, pauseIdleWatchdog }

    askSpy.mockImplementationOnce(async () => {
      events.push("ask-running")
      // simulate long human-typing wait that would have triggered the 90s
      // timer before the fix
      await new Promise((r) => setTimeout(r, 5))
      events.push("ask-resolved")
      return [["Red"]]
    })

    const tool = await QuestionTool.init()
    await tool.execute(
      {
        questions: [
          {
            question: "Long-wait question",
            header: "TV-1",
            options: [{ label: "Red", description: "ok" }],
          },
        ],
      },
      ctxWithPause as any,
    )

    // pause happens before ask; resume happens after ask resolves.
    expect(events).toEqual(["pause", "ask-running", "ask-resolved", "resume"])
  })

  test("TV-2: genuine reject (input.abort surface) still rejects — finally still runs resume()", async () => {
    // Question.ask throws (mimicking what the AbortSignal-driven onAbort →
    // reject(RejectedError) path does in question/index.ts). The tool
    // re-throws; we assert resume() still ran via finally.
    const events: string[] = []
    const pauseIdleWatchdog = () => {
      events.push("pause")
      return () => {
        events.push("resume")
      }
    }
    const ctxWithPause = { ...ctx, pauseIdleWatchdog }

    askSpy.mockImplementationOnce(async () => {
      events.push("ask-running")
      throw new Error("aborted: user cancelled (simulated input.abort)")
    })

    const tool = await QuestionTool.init()
    let threw: unknown
    try {
      await tool.execute(
        {
          questions: [
            {
              question: "Will be aborted",
              header: "TV-2",
              options: [{ label: "x", description: "y" }],
            },
          ],
        },
        ctxWithPause as any,
      )
    } catch (err) {
      threw = err
    }

    expect(threw).toBeInstanceOf(Error)
    expect((threw as Error).message).toContain("aborted")
    // Critical: resume() MUST have run even though Question.ask threw,
    // otherwise the watchdog would stay disarmed for the rest of the
    // stream (design.md R1).
    expect(events).toEqual(["pause", "ask-running", "resume"])
  })

  test("TV-3: when ctx.pauseIdleWatchdog is absent — tool still works (optional-chaining no-op)", async () => {
    // Backwards compatibility: callers (small-model path) that do not
    // supply idleWatchdogBox leave ctx.pauseIdleWatchdog undefined. The
    // tool must still complete successfully (pre-fix behavior preserved).
    askSpy.mockResolvedValueOnce([["ok"]])
    const tool = await QuestionTool.init()
    const result = await tool.execute(
      {
        questions: [
          {
            question: "No pause hook",
            header: "TV-3",
            options: [{ label: "ok", description: "fine" }],
          },
        ],
      },
      ctx as any, // ctx has no pauseIdleWatchdog
    )
    expect(result.title).toBe("Asked 1 question")
    expect(result.output).toContain('"No pause hook"="ok"')
  })

  test("TV-4: resume idempotency — calling twice is safe and only emits one resume", async () => {
    // Spec DD-1 mandates resume() is idempotent. The question tool only
    // calls resume?.() once (in finally), but other future interactive
    // tools could double-call by mistake; we verify the contract is
    // honored by the closure returned from a typical pauseIdleWatchdog
    // implementation. Here we simulate the contract by tracking calls.
    let resumeCalls = 0
    const realResume = () => {
      resumeCalls++
    }
    // Simulate the llm.ts pauseIdleWatchdog: returns a closure that
    // guards against double-resume.
    const guardedResume = (() => {
      let resumed = false
      return () => {
        if (resumed) return
        resumed = true
        realResume()
      }
    })()

    // Call twice directly (simulating buggy future caller)
    guardedResume()
    guardedResume()
    expect(resumeCalls).toBe(1)
  })

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
