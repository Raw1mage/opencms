import { afterEach, describe, expect, test } from "bun:test"
import { spyOn, mock } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import * as QuestionModule from "../../src/question"
import type { Todo as TodoInfo } from "../../src/session/todo"
import { tmpdir } from "../fixture/fixture"

describe("session.smart-runner-prompt", () => {
  afterEach(() => {
    mock.restore()
  })

  function plainTextStopStream(text: string) {
    return async function* () {
      yield { type: "start" }
      yield { type: "start-step" }
      yield { type: "text-start" }
      yield { type: "text-delta", text }
      yield { type: "text-end" }
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
        providerMetadata: {},
      }
      yield { type: "finish" }
    }
  }

  test("builds a host-adopted ask-user question payload", () => {
    expect(
      SessionPrompt.buildSmartRunnerQuestion({
        questionText: "Should we keep the current product behavior?",
      }),
    ).toEqual({
      question: "Should we keep the current product behavior?",
      header: "Decision needed",
      options: [],
      custom: true,
    })
  })

  test("returns undefined when ask-user question text is empty", () => {
    expect(SessionPrompt.buildSmartRunnerQuestion({ questionText: "   " })).toBeUndefined()
  })

  test("formats synthetic user answer text for prompt-loop continuation", () => {
    const question = SessionPrompt.buildSmartRunnerQuestion({
      questionText: "Should we keep the current product behavior?",
    })
    if (!question) throw new Error("expected question")

    expect(
      SessionPrompt.formatSmartRunnerQuestionAnswers({
        question,
        answers: [
          {
            header: "Smart Runner",
            answer: [],
          },
        ],
      }),
    ).toBe(
      'User answered Smart Runner question "Should we keep the current product behavior?" with: Unanswered. Continue with this answer in mind.',
    )
  })

  test("orchestrates ask-user rejection into waiting_user workflow state", async () => {
    const question = SessionPrompt.buildSmartRunnerQuestion({
      questionText: "Should we continue with the current product behavior?",
    })
    if (!question) throw new Error("expected question")

    const persistTrace = mock(async () => {})
    const updateMessage = mock(async () => {})
    const updatePart = mock(async () => {})
    const setWorkflowState = mock(async () => ({}) as Awaited<ReturnType<typeof Session.setWorkflowState>>)

    const result = await SessionPrompt.handleSmartRunnerAskUserAdoption({
      sessionID: "ses_test",
      question,
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: Date.now(),
        deterministicReason: "todo_pending",
        suggestion: {
          kind: "ask_user",
          reason: "Need user input before continuing",
          askUserAdoption: {
            proposalID: "ask-user:t1",
            hostAdopted: true,
            hostAdoptionReason: "adopted",
          },
        },
      },
      lastUser: {
        agent: "build",
        model: { providerId: "openai", modelID: "gpt-5.2" },
        variant: undefined,
        format: undefined,
      },
      ask: async () => {
        throw new QuestionModule.Question.RejectedError()
      },
      persistTrace,
      updateMessage,
      updatePart,
      setWorkflowState,
    })

    expect(result).toEqual({ outcome: "rejected" })
    expect(persistTrace).toHaveBeenCalledTimes(2)
    expect(updateMessage).toHaveBeenCalledTimes(0)
    expect(updatePart).toHaveBeenCalledTimes(0)
    expect(setWorkflowState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses_test",
        state: "waiting_user",
        stopReason: "product_decision_needed",
      }),
    )
  })

  test("orchestrates ask-user answer into a synthetic user continuation message", async () => {
    const question = SessionPrompt.buildSmartRunnerQuestion({
      questionText: "Should we continue with the current product behavior?",
    })
    if (!question) throw new Error("expected question")

    const persistTrace = mock(async () => {})
    const updateMessage = mock(async () => {})
    const updatePart = mock(async () => {})
    const setWorkflowState = mock(async () => ({}) as Awaited<ReturnType<typeof Session.setWorkflowState>>)

    const result = await SessionPrompt.handleSmartRunnerAskUserAdoption({
      sessionID: "ses_test",
      question,
      trace: {
        source: "smart_runner_governor",
        dryRun: true,
        status: "advisory",
        createdAt: Date.now(),
        deterministicReason: "todo_pending",
        suggestion: {
          kind: "ask_user",
          reason: "Need user input before continuing",
          askUserAdoption: {
            proposalID: "ask-user:t1",
            hostAdopted: true,
            hostAdoptionReason: "adopted",
          },
        },
      },
      lastUser: {
        agent: "build",
        model: { providerId: "openai", modelID: "gpt-5.2" },
        variant: undefined,
        format: undefined,
      },
      ask: async () => [["Proceed"]],
      persistTrace,
      updateMessage,
      updatePart,
      setWorkflowState,
    })

    expect(result).toEqual({ outcome: "answered" })
    expect(persistTrace).toHaveBeenCalledTimes(1)
    expect(updateMessage).toHaveBeenCalledTimes(1)
    expect(updatePart).toHaveBeenCalledTimes(1)
    expect((updatePart as any).mock.calls.at(0)?.[0]).toEqual(
      expect.objectContaining({
        sessionID: "ses_test",
        type: "text",
        synthetic: true,
        text: 'User answered Smart Runner question "Should we continue with the current product behavior?" with: Proceed. Continue with this answer in mind.',
      }),
    )
    expect(setWorkflowState).toHaveBeenCalledTimes(0)
  })

  test("integrates with real Question reject flow for ask-user adoption", async () => {
    const question = SessionPrompt.buildSmartRunnerQuestion({
      questionText: "Should we continue with the current product behavior?",
    })
    if (!question) throw new Error("expected question")

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const persistTrace = mock(async () => {})
        const updateMessage = mock(async () => {})
        const updatePart = mock(async () => {})
        const setWorkflowState = mock(async () => ({}) as Awaited<ReturnType<typeof Session.setWorkflowState>>)

        const promise = SessionPrompt.handleSmartRunnerAskUserAdoption({
          sessionID: "ses_test",
          question,
          trace: {
            source: "smart_runner_governor",
            dryRun: true,
            status: "advisory",
            createdAt: Date.now(),
            deterministicReason: "todo_pending",
            suggestion: {
              kind: "ask_user",
              reason: "Need user input before continuing",
              askUserAdoption: {
                proposalID: "ask-user:t1",
                hostAdopted: true,
                hostAdoptionReason: "adopted",
              },
            },
          },
          lastUser: {
            agent: "build",
            model: { providerId: "openai", modelID: "gpt-5.2" },
            variant: undefined,
            format: undefined,
          },
          persistTrace,
          updateMessage,
          updatePart,
          setWorkflowState,
        })

        let requestID: string | undefined
        for (let i = 0; i < 20; i++) {
          const pending = await QuestionModule.Question.list()
          requestID = pending[0]?.id
          if (requestID) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        if (!requestID) throw new Error("expected pending question")

        await QuestionModule.Question.reject(requestID)
        const result = await promise

        expect(result).toEqual({ outcome: "rejected" })
        expect(persistTrace).toHaveBeenCalledTimes(2)
        expect(updateMessage).toHaveBeenCalledTimes(0)
        expect(updatePart).toHaveBeenCalledTimes(0)
        expect(setWorkflowState).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionID: "ses_test",
            state: "waiting_user",
            stopReason: "product_decision_needed",
          }),
        )
      },
    })
  }, 15000)

  test("integrates with real Question reply flow for ask-user adoption", async () => {
    const question = SessionPrompt.buildSmartRunnerQuestion({
      questionText: "Should we continue with the current product behavior?",
    })
    if (!question) throw new Error("expected question")

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const persistTrace = mock(async () => {})
        const updateMessage = mock(async () => {})
        const updatePart = mock(async () => {})
        const setWorkflowState = mock(async () => ({}) as Awaited<ReturnType<typeof Session.setWorkflowState>>)

        const promise = SessionPrompt.handleSmartRunnerAskUserAdoption({
          sessionID: "ses_test",
          question,
          trace: {
            source: "smart_runner_governor",
            dryRun: true,
            status: "advisory",
            createdAt: Date.now(),
            deterministicReason: "todo_pending",
            suggestion: {
              kind: "ask_user",
              reason: "Need user input before continuing",
              askUserAdoption: {
                proposalID: "ask-user:t1",
                hostAdopted: true,
                hostAdoptionReason: "adopted",
              },
            },
          },
          lastUser: {
            agent: "build",
            model: { providerId: "openai", modelID: "gpt-5.2" },
            variant: undefined,
            format: undefined,
          },
          persistTrace,
          updateMessage,
          updatePart,
          setWorkflowState,
        })

        let requestID: string | undefined
        for (let i = 0; i < 20; i++) {
          const pending = await QuestionModule.Question.list()
          requestID = pending[0]?.id
          if (requestID) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        if (!requestID) throw new Error("expected pending question")

        await QuestionModule.Question.reply({ requestID, answers: [["Proceed"]] })
        const result = await promise

        expect(result).toEqual({ outcome: "answered" })
        expect(persistTrace).toHaveBeenCalledTimes(1)
        expect(updateMessage).toHaveBeenCalledTimes(1)
        expect(updatePart).toHaveBeenCalledTimes(1)
        expect((updatePart as any).mock.calls.at(0)?.[0]).toEqual(
          expect.objectContaining({
            sessionID: "ses_test",
            type: "text",
            synthetic: true,
            text: 'User answered Smart Runner question "Should we continue with the current product behavior?" with: Proceed. Continue with this answer in mind.',
          }),
        )
        expect(setWorkflowState).toHaveBeenCalledTimes(0)
      },
    })
  }, 15000)

  test("orchestrates host-adopted replan by updating todos and re-evaluating continuation", async () => {
    const todos: TodoInfo.Info[] = [
      { id: "t1", content: "first", status: "completed", priority: "high" },
      { id: "t2", content: "second", status: "pending", priority: "high" },
    ]
    const updateTodos = mock(async () => {})
    const decideContinuation = mock(async () => ({
      continue: true as const,
      reason: "todo_in_progress" as const,
      text: "Continue the task already in progress.",
      todo: { id: "t2", content: "second", status: "in_progress", priority: "high" },
    }))

    const result = await SessionPrompt.handleSmartRunnerReplanAdoption({
      sessionID: "ses_test",
      todos,
      suggestion: {
        kind: "replan",
        reason: "Start the dependency-ready next todo",
        replanAdoption: {
          proposalID: "replan:t2",
          targetTodoID: "t2",
          proposedAction: "replan_todos",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        },
      },
      roundCount: 1,
      fallbackDecision: {
        continue: true,
        reason: "todo_pending",
        text: "Continue with the next planned step.",
        todo: { id: "t2", content: "second", status: "pending", priority: "high" },
      },
      updateTodos,
      decideContinuation,
    })

    expect(result.adopted).toBe(true)
    expect(result.reason).toBe("adopted")
    expect(updateTodos).toHaveBeenCalledTimes(1)
    expect(decideContinuation).toHaveBeenCalledWith({ sessionID: "ses_test", roundCount: 1 })
    expect(result.decision).toEqual({
      continue: true,
      reason: "todo_in_progress",
      text: "Continue the task already in progress.",
      todo: { id: "t2", content: "second", status: "in_progress", priority: "high" },
    })
  })

  test("orchestrates continuation side effects for a Smart Runner continue branch", async () => {
    const emitNarration = mock(async () => {})
    const enqueueContinue = mock(async () => ({ id: "msg_next" }))

    const result = await SessionPrompt.handleSmartRunnerContinuationSideEffects({
      sessionID: "ses_test",
      user: {
        id: "msg_user",
        sessionID: "ses_test",
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerId: "openai", modelID: "gpt-5.2" },
        variant: undefined,
        format: undefined,
      },
      decision: {
        continue: true,
        reason: "todo_pending",
        text: "[AI] Continue with the next planned step.",
        todo: { id: "t1", content: "next", status: "pending", priority: "high" },
      },
      narrationOverride: "[AI] Starting the next step now.",
      autonomousRounds: 2,
      emitNarration,
      enqueueContinue,
    })

    expect(result.nextRoundCount).toBe(3)
    expect(emitNarration).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses_test",
        parentID: "msg_user",
        text: "[AI] Starting the next step now.",
        kind: "continue",
      }),
    )
    expect(enqueueContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses_test",
        roundCount: 3,
        text: "[AI] Continue with the next planned step.",
      }),
    )
  })

  test("coordinates stop-decision ask-user adoption at a high level", async () => {
    const getConfig = mock(async () => ({ enabled: true, assist: false }))
    const evaluateGovernor = mock(async () => ({
      source: "smart_runner_governor",
      dryRun: true,
      status: "advisory",
      createdAt: Date.now(),
      deterministicReason: "todo_pending",
      decision: {
        situation: "waiting_for_human",
        assessment: "Needs clarification",
        decision: "ask_user",
        reason: "Need user input before continuing",
        nextAction: {
          kind: "request_user_input",
          todoID: "t1",
          skillHints: [],
          narration: "Should we continue with the current product behavior?",
        },
        needsUserInput: true,
        confidence: "high",
      },
    }))
    const askUser = mock(async () => ({ outcome: "rejected" as const }))

    const result = await SessionPrompt.handleSmartRunnerStopDecision({
      sessionID: "ses_test",
      activeModel: { providerId: "openai", modelID: "gpt-5.2" } as any,
      autonomousRounds: 0,
      lastUser: {
        id: "msg_user",
        sessionID: "ses_test",
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerId: "openai", modelID: "gpt-5.2" },
        variant: undefined,
        format: undefined,
      },
      messages: [],
      todos: [{ id: "t1", content: "next", status: "pending", priority: "high" }],
      decision: {
        continue: true,
        reason: "todo_pending",
        text: "Continue with the next planned step.",
        todo: { id: "t1", content: "next", status: "pending", priority: "high" },
      },
      getConfig: getConfig as any,
      evaluateGovernor: evaluateGovernor as any,
      listQuestions: async () => [],
      askUser: askUser as any,
      replan: mock(async () => {
        throw new Error("replan should not run when ask_user is adopted")
      }) as any,
    })

    expect(result).toEqual(
      expect.objectContaining({
        kind: "ask_user",
        adopted: true,
        outcome: "rejected",
      }),
    )
    expect(askUser).toHaveBeenCalledTimes(1)
  })

  test("coordinates stop-decision continue path with assist/replan outputs", async () => {
    const getConfig = mock(async () => ({ enabled: true, assist: true }))
    const evaluateGovernor = mock(async () => ({
      source: "smart_runner_governor",
      dryRun: true,
      status: "advisory",
      createdAt: Date.now(),
      deterministicReason: "todo_pending",
      decision: {
        situation: "ready_to_continue",
        assessment: "Can continue",
        decision: "continue",
        reason: "Safe to continue",
        nextAction: {
          kind: "continue_current",
          todoID: "t1",
          skillHints: [],
          narration: "Continue",
        },
        needsUserInput: false,
        confidence: "high",
      },
    }))
    const replan = mock(async () => ({
      adopted: true as const,
      reason: "adopted" as const,
      decision: {
        continue: true as const,
        reason: "todo_in_progress" as const,
        text: "Continue the task already in progress.",
        todo: { id: "t1", content: "next", status: "in_progress", priority: "high" },
      },
      todos: [{ id: "t1", content: "next", status: "in_progress", priority: "high" }],
    }))
    const applyAssist = mock(() => ({
      applied: true,
      decision: {
        continue: true as const,
        reason: "todo_in_progress" as const,
        text: "Continue the task already in progress.",
        todo: { id: "t1", content: "next", status: "in_progress", priority: "high" },
      },
      narration: "Starting the next step now.",
    }))
    const persistTrace = mock(async () => {})

    const result = await SessionPrompt.handleSmartRunnerStopDecision({
      sessionID: "ses_test",
      activeModel: { providerId: "openai", modelID: "gpt-5.2" } as any,
      autonomousRounds: 0,
      lastUser: {
        id: "msg_user",
        sessionID: "ses_test",
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerId: "openai", modelID: "gpt-5.2" },
        variant: undefined,
        format: undefined,
      },
      messages: [],
      todos: [{ id: "t1", content: "next", status: "pending", priority: "high" }],
      decision: {
        continue: true,
        reason: "todo_pending",
        text: "Continue with the next planned step.",
        todo: { id: "t1", content: "next", status: "pending", priority: "high" },
      },
      getConfig: getConfig as any,
      evaluateGovernor: evaluateGovernor as any,
      listQuestions: async () => [],
      askUser: mock(async () => {
        throw new Error("askUser should not run in continue path")
      }) as any,
      replan: replan as any,
      persistTrace: persistTrace as any,
      applyAssist: applyAssist as any,
    })

    expect(result).toEqual(
      expect.objectContaining({
        kind: "continue",
        narrationOverride: "[AI] Starting the next step now.",
        continueDecision: {
          continue: true,
          reason: "todo_in_progress",
          text: "[AI] Continue the task already in progress.",
          todo: { id: "t1", content: "next", status: "in_progress", priority: "high" },
        },
      }),
    )
    expect(replan).toHaveBeenCalledTimes(1)
    expect(applyAssist).toHaveBeenCalledTimes(1)
    expect(persistTrace).toHaveBeenCalledTimes(1)
  })
})
