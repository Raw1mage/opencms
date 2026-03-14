import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { tmpdir } from "../fixture/fixture"

describe("plan mode enforcement classifier", () => {
  test("flags plain-text bounded decision question as violation", async () => {
    const { SessionPrompt } = await import("../../src/session/prompt")
    const result = SessionPrompt.classifyPlanModeAssistantTurn({
      agentName: "plan",
      finish: "stop",
      parts: [
        {
          id: "part1",
          sessionID: "ses_test",
          messageID: "msg_test",
          type: "text",
          text: "session-local 的 execution 切換工具要叫 manage_session.set_execution 還是 switch_session_execution？",
        },
      ] as any,
    })
    expect(result.enforced).toBe(true)
    expect(result.violation).toBe(true)
    expect(result.reason).toBe("plain_text_decision_question")
  })

  test("allows question tool call in plan mode", async () => {
    const { SessionPrompt } = await import("../../src/session/prompt")
    const result = SessionPrompt.classifyPlanModeAssistantTurn({
      agentName: "plan",
      finish: "tool-calls",
      parts: [
        {
          id: "part2",
          sessionID: "ses_test",
          messageID: "msg_test",
          type: "tool",
          callID: "call_test",
          tool: "question",
          state: {
            status: "completed",
            input: {},
            output: { text: "ok" },
            time: { start: Date.now(), end: Date.now() },
          },
        },
      ] as any,
    })
    expect(result.enforced).toBe(true)
    expect(result.violation).toBe(false)
    expect(result.reason).toBe("question_tool")
  })

  test("allows progress summary without question", async () => {
    const { SessionPrompt } = await import("../../src/session/prompt")
    const result = SessionPrompt.classifyPlanModeAssistantTurn({
      agentName: "plan",
      finish: "stop",
      parts: [
        {
          id: "part3",
          sessionID: "ses_test",
          messageID: "msg_test",
          type: "text",
          text: "Current goal: finalize the system-manager planning scope. Resolved decisions: session-local is the default. Next step: write proposal/spec/design/tasks/handoff.",
        },
      ] as any,
    })
    expect(result.enforced).toBe(true)
    expect(result.violation).toBe(false)
    expect(result.reason).toBe("progress_summary")
  })
})

async function waitForPendingQuestion(sessionID: string, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const pending = (await Question.list()).filter((item) => item.sessionID === sessionID)
    if (pending.length > 0) return pending
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return []
}

describe("planner reactivation", () => {
  test("plan_enter creates a structured spec template when missing", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          const { PlanEnterTool } = await import("../../src/tool/plan")
          const tool = await PlanEnterTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "build",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await execute

          expect(planPath).toContain("/specs/changes/")
          expect(planPath).toEndWith("/implementation-spec.md")
          const planText = await Bun.file(planPath).text()
          expect(planText).toContain("## Goal")
          expect(planText).toContain("## Structured Execution Phases")
          expect(planText).toContain("## Handoff")
          expect(await Bun.file(planPath.replace("implementation-spec.md", "proposal.md")).exists()).toBe(true)
          expect(await Bun.file(planPath.replace("implementation-spec.md", "spec.md")).exists()).toBe(true)
          expect(await Bun.file(planPath.replace("implementation-spec.md", "design.md")).exists()).toBe(true)
          expect(await Bun.file(planPath.replace("implementation-spec.md", "tasks.md")).exists()).toBe(true)
          expect(await Bun.file(planPath.replace("implementation-spec.md", "handoff.md")).exists()).toBe(true)
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("auto-routes non-trivial implementation requests into plan agent", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const message = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: "請幫我規劃並實作一個 autonomous runner daemon 架構，包含 planner、workflow、subagent 與驗證流程。\n這是多步驟開發需求，先不要直接實作，先把規格想清楚。",
              },
            ],
          })
          if (message.info.role !== "user") throw new Error("expected user message")
          expect(message.info.agent).toBe("plan")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("does not auto-route lightweight status questions into plan agent", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const message = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [{ type: "text", text: "What did we do so far?" }],
          })
          if (message.info.role !== "user") throw new Error("expected user message")
          expect(message.info.agent).toBe("build")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("does not auto-route status-only requests into plan agent", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const message = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: "What did we do so far? Give me a short status update only.",
              },
            ],
          })
          if (message.info.role !== "user") throw new Error("expected user message")
          expect(message.info.agent).toBe("build")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("does not auto-route plain status questions into plan agent", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const message = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: "What did we do so far? Give me a short summary.",
              },
            ],
          })
          if (message.info.role !== "user") throw new Error("expected user message")
          expect(message.info.agent).toBe("build")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan mode reminder requires choice-based MCP question for bounded planning decisions", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const { insertReminders } = await import("../../src/session/reminders")
          const { Agent } = await import("../../src/agent/agent")
          const planAgent = await Agent.get("plan")
          const fallbackModel = { providerId: "openai", modelID: "gpt-5.4" }

          const userMessage = {
            info: {
              id: "msg_user",
              sessionID: session.id,
              role: "user",
              agent: "plan",
              time: { created: Date.now() },
              model: fallbackModel,
            },
            parts: [],
          } as unknown as MessageV2.WithParts

          const assistantMessage = {
            info: {
              id: "msg_assistant",
              sessionID: session.id,
              role: "assistant",
              agent: "build",
              time: { created: Date.now() - 1 },
              parentID: "msg_parent",
              modelID: fallbackModel.modelID,
              providerId: fallbackModel.providerId,
              mode: "chat",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
            parts: [],
          } as unknown as MessageV2.WithParts

          const messages = [assistantMessage, userMessage]
          await insertReminders({
            messages,
            agent: planAgent,
            session,
          })

          if (userMessage.parts.length === 0) {
            throw new Error(`expected reminder part, got none for message shape: ${JSON.stringify(userMessage.info)}`)
          }

          const reminder = userMessage.parts.find(
            (part) =>
              part.type === "text" &&
              part.synthetic &&
              part.text.includes("<system-reminder>") &&
              part.text.includes("# Plan Mode - System Reminder"),
          )
          if (!reminder || reminder.type !== "text") {
            throw new Error(
              `expected plan mode reminder, got parts: ${JSON.stringify(
                userMessage.parts.map((part) => (part.type === "text" ? part.text : part.type)),
              )}`,
            )
          }
          expect(reminder.text).toContain("Default to MCP question with structured multiple-choice options")
          expect(reminder.text).toContain(
            "Do not ask plain conversational clarification when a structured question choice would work.",
          )
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("experimental plan mode still uses plan.txt as the single prompt source", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    const originalPlanMode = process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE
    process.env.OPENCODE_CLIENT = "app"
    process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE = "1"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const { insertReminders } = await import("../../src/session/reminders")
          const { Agent } = await import("../../src/agent/agent")
          const planAgent = await Agent.get("plan")
          const fallbackModel = { providerId: "openai", modelID: "gpt-5.4" }

          const userMessage = {
            info: {
              id: "msg_user_exp",
              sessionID: session.id,
              role: "user",
              agent: "plan",
              time: { created: Date.now() },
              model: fallbackModel,
            },
            parts: [],
          } as unknown as MessageV2.WithParts

          const assistantMessage = {
            info: {
              id: "msg_assistant_exp",
              sessionID: session.id,
              role: "assistant",
              agent: "build",
              time: { created: Date.now() - 1 },
              parentID: "msg_parent_exp",
              modelID: fallbackModel.modelID,
              providerId: fallbackModel.providerId,
              mode: "chat",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
            parts: [],
          } as unknown as MessageV2.WithParts

          await insertReminders({
            messages: [assistantMessage, userMessage],
            agent: planAgent,
            session,
          })

          const reminder = userMessage.parts.find((part) => part.type === "text" && part.synthetic)
          if (!reminder || reminder.type !== "text") throw new Error("expected plan prompt part")
          expect(reminder.text).toContain("# Plan Mode - System Reminder")
          expect(reminder.text).toContain("Default to MCP question with structured multiple-choice options")
          expect(reminder.text).not.toContain("## Plan File Info:")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
      if (originalPlanMode === undefined) delete process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE
      else process.env.OPENCODE_EXPERIMENTAL_PLAN_MODE = originalPlanMode
    }
  })

  test("plan_exit blocks when implementation spec is incomplete", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await Bun.write(planPath, "# Plan\n\n## Goal\nIncomplete spec\n")

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await expect(execute).rejects.toThrow("Plan completeness gate failed")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit blocks when tasks artifact still contains placeholders", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nTest planner handoff\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [ ] <fill task item>\n",
          )

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await expect(execute).rejects.toThrow("tasks artifact issues")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit blocks when implementation spec fails schema checks", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nShip feature\n\n## Scope\n- missing IN/OUT headings\n\n## Assumptions\n- assumption\n\n## Stop Gates\n- require approval\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- do phase\n\n## Validation\n- run tests\n\n## Handoff\n- done\n",
          )
          await Bun.write(planPath.replace("implementation-spec.md", "tasks.md"), "# Tasks\n\n- [ ] 1.1 Do work\n")

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await expect(execute).rejects.toThrow("schema issues")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit blocks when tasks artifact is not executable", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nValid goal\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n- Implement planner restoration\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [x] finished\n",
          )

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await expect(execute).rejects.toThrow("tasks artifact issues")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit blocks when companion artifacts are incomplete", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nTest planner handoff\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n- Implement planner restoration\n- Run validation checks\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [ ] 1.1 Task from tasks artifact A\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "proposal.md"),
            "# Proposal\n\n## Why\n- Need planning reliability\n\n## What Changes\n- Strengthen planner handoff contract\n\n## Capabilities\n### New Capabilities\n- planner-handoff: structured build handoff\n\n### Modified Capabilities\n- planner-runtime: stronger plan_exit checks\n\n## Impact\n- Affects plan/build workflow and runtime handoff metadata\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "spec.md"),
            "# Spec\n\n## Purpose\n- Define planner handoff behavior\n\n## Requirements\n\n### Requirement: Planner SHALL provide execution-ready handoff\nThe system SHALL produce build-consumable handoff metadata from planner artifacts.\n\n#### Scenario: plan_exit after complete artifacts\n- **GIVEN** complete planner artifacts\n- **WHEN** plan_exit is invoked\n- **THEN** build handoff metadata is emitted\n\n## Acceptance Checks\n- Handoff metadata includes artifact paths and materialized todos\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "design.md"),
            "# Design\n\n## Context\n- Planner artifacts are consumed by build mode\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "handoff.md"),
            "# Handoff\n\n## Execution Contract\n- Build agent reads implementation-spec.md first\n\n## Required Reads\n- implementation-spec.md\n- design.md\n- tasks.md\n\n## Stop Gates In Force\n- Preserve approval and decision gates\n\n## Execution-Ready Checklist\n- [ ] Implementation spec complete\n",
          )

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await expect(execute).rejects.toThrow("design artifact issues")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit blocks when companion artifacts are missing required OpenSpec sections", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nValid goal\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n- Implement planner restoration\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [ ] 1.1 Do work\n",
          )
          await Bun.write(planPath.replace("implementation-spec.md", "proposal.md"), "# Proposal\n\n## Why\n- reason\n")
          await Bun.write(planPath.replace("implementation-spec.md", "spec.md"), "# Spec\n\n## Purpose\n- behavior\n")
          await Bun.write(
            planPath.replace("implementation-spec.md", "design.md"),
            "# Design\n\n## Context\n- context\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "handoff.md"),
            "# Handoff\n\n## Execution Contract\n- contract\n",
          )

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await expect(execute).rejects.toThrow("proposal artifact issues")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit injects structured handoff metadata for build mode", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nTest planner handoff\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n- Implement planner restoration\n- Run validation checks\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [ ] 1.1 Task from tasks artifact A\n- [ ] 1.2 Task from tasks artifact B\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "proposal.md"),
            "# Proposal\n\n## Why\n- Need planning reliability\n\n## What Changes\n- Strengthen planner handoff contract\n\n## Capabilities\n### New Capabilities\n- planner-handoff: structured build handoff\n\n### Modified Capabilities\n- planner-runtime: stronger plan_exit checks\n\n## Impact\n- Affects plan/build workflow and runtime handoff metadata\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "spec.md"),
            "# Spec\n\n## Purpose\n- Define planner handoff behavior\n\n## Requirements\n\n### Requirement: Planner SHALL provide execution-ready handoff\nThe system SHALL produce build-consumable handoff metadata from planner artifacts.\n\n#### Scenario: plan_exit after complete artifacts\n- **GIVEN** complete planner artifacts\n- **WHEN** plan_exit is invoked\n- **THEN** build handoff metadata is emitted\n\n## Acceptance Checks\n- Handoff metadata includes artifact paths and materialized todos\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "design.md"),
            "# Design\n\n## Context\n- Planner artifacts are consumed by build mode\n\n## Goals / Non-Goals\n**Goals:**\n- Produce deterministic handoff contract\n\n**Non-Goals:**\n- Implement daemon runtime in this slice\n\n## Decisions\n- Use plan_exit gate and metadata envelope\n\n## Risks / Trade-offs\n- Stricter gates increase planning rigor but add upfront requirements\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "handoff.md"),
            "# Handoff\n\n## Execution Contract\n- Build agent reads implementation-spec.md first\n\n## Required Reads\n- implementation-spec.md\n- design.md\n- tasks.md\n\n## Stop Gates In Force\n- Preserve approval and decision gates\n\n## Execution-Ready Checklist\n- [ ] Implementation spec complete\n- [ ] Companion artifacts aligned\n- [ ] Validation plan explicit\n",
          )

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test",
            callID: "call_test",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          await new Promise((resolve) => setTimeout(resolve, 0))
          const pending = await Question.list()
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          await execute

          let latestUser: MessageV2.WithParts | undefined
          for await (const item of MessageV2.stream(session.id)) {
            if (item.info.role === "user") {
              latestUser = item
              break
            }
          }
          if (!latestUser) throw new Error("expected latest user message")
          expect(latestUser.info.agent).toBe("build")
          const handoffPart = latestUser.parts.find((part) => part.type === "text" && part.synthetic)
          if (!handoffPart || handoffPart.type !== "text") throw new Error("expected synthetic handoff part")
          expect(handoffPart.metadata?.handoff?.contract).toBe("implementation_spec")
          expect(handoffPart.text).toContain("structured todos/action metadata")
          expect(handoffPart.metadata?.handoff?.materializedTodos?.length).toBeGreaterThanOrEqual(3)
          expect(handoffPart.metadata?.handoff?.missingSections).toEqual([])
          expect(handoffPart.metadata?.handoff?.clarificationMapping?.scope?.mappedTo).toContain(
            "implementation-spec.md#Scope",
          )
          expect(handoffPart.metadata?.handoff?.clarificationMapping?.validation?.mappedTo).toContain(
            "spec.md#Acceptance Checks",
          )
          expect(handoffPart.metadata?.handoff?.clarificationMapping?.stopGates?.mappedTo).toContain(
            "handoff.md#Stop Gates In Force",
          )
          expect(handoffPart.metadata?.handoff?.clarificationMapping?.delegation?.values?.length).toBeGreaterThan(0)
          expect(handoffPart.metadata?.handoff?.clarificationMapping?.riskPosture?.mappedTo).toContain(
            "design.md#Risks / Trade-offs",
          )
          expect(handoffPart.metadata?.handoff?.artifactPaths?.proposal).toContain("proposal.md")
          expect(handoffPart.metadata?.handoff?.artifactPaths?.spec).toContain("spec.md")
          expect(handoffPart.metadata?.handoff?.artifactPaths?.design).toContain("design.md")
          expect(handoffPart.metadata?.handoff?.artifactPaths?.tasks).toContain("tasks.md")
          expect(handoffPart.metadata?.handoff?.artifactPaths?.handoff).toContain("handoff.md")

          const todos = await Todo.get(session.id)
          expect(todos.length).toBeGreaterThanOrEqual(3)
          expect(todos[0]?.status).toBe("in_progress")
          expect(todos[0]?.content).toContain("Task from tasks artifact A")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })
})
