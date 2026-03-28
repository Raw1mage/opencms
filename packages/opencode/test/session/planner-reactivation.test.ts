import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { plannerArtifacts } from "../../src/session/planner-layout"
import { MessageV2 } from "../../src/session/message-v2"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { tmpdir } from "../fixture/fixture"
import path from "path"

describe("planner root naming", () => {
  test("uses explicit topic title instead of session id fallback", async () => {
    const { plannerRootName } = await import("../../src/session/planner-layout")
    const rootName = plannerRootName({
      slug: "ses-abc123xyz",
      title: "Dialog Trigger Framework",
      time: { created: Date.UTC(2026, 2, 28) },
    })

    expect(rootName).toBe("20260328_dialog-trigger-framework")
  })

  test("fails fast when only generic title and session-id slug are available", async () => {
    const { plannerRootName } = await import("../../src/session/planner-layout")

    expect(() =>
      plannerRootName({
        slug: "ses-abc123xyz",
        title: "New session - 2026-03-28T12:00:00.000Z",
        time: { created: Date.UTC(2026, 2, 28) },
      }),
    ).toThrow("planner root slug derivation requires a topic-aligned title before plan_enter")
  })
})

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

async function answerNextQuestion(sessionID: string, answers: string[]) {
  const pending = await waitForPendingQuestion(sessionID)
  expect(pending.length).toBe(1)
  await Question.reply({ requestID: pending[0].id, answers: answers.map((answer) => [answer]) })
}

async function writePlannerJsonArtifacts(planPath: string) {
  await Bun.write(
    planPath.replace("implementation-spec.md", "idef0.json"),
    JSON.stringify(
      {
        diagram_title: "Planner Handoff",
        node_reference: "A0",
        activities: [{ id: "A1", title: "Emit Build Handoff", description: "handoff", decomposition: null }],
        arrows: [{ id: "AR1", source: "EXTERNAL", target: "A1:input", label: "Plan", type: "input" }],
      },
      null,
      2,
    ),
  )
  await Bun.write(
    planPath.replace("implementation-spec.md", "grafcet.json"),
    JSON.stringify(
      [
        {
          StepNumber: 0,
          ModuleRef: "A1",
          StepType: "initial",
          StepAction: "Start",
          LinkInputType: [],
          LinkInputNumber: [1],
          LinkOutputNumber: [1],
          LinkOutputType: "track",
          Condition: ["ready"],
          SubGrafcet: [],
        },
        {
          StepNumber: 1,
          ModuleRef: "A1",
          StepType: "normal",
          StepAction: "Emit Handoff",
          LinkInputType: [],
          LinkInputNumber: [0],
          LinkOutputNumber: [0],
          LinkOutputType: "track",
          Condition: ["reset"],
          SubGrafcet: [],
        },
      ],
      null,
      2,
    ),
  )
  await Bun.write(
    planPath.replace("implementation-spec.md", "c4.json"),
    JSON.stringify(
      {
        diagram_title: "Planner Components",
        diagram_level: "component",
        systems: [{ id: "SYS1", name: "Planner", description: "planner", external: false }],
        containers: [
          { id: "CT1", name: "Runtime", description: "runtime", technology: "TypeScript", systemRef: "SYS1" },
        ],
        components: [
          {
            id: "C1",
            name: "PlanExitTool",
            description: "handoff",
            technology: "module",
            containerRef: "CT1",
            moduleRef: "A1",
            filePath: "packages/opencode/src/tool/plan.ts",
          },
        ],
        relationships: [
          { id: "REL1", source: "C1", target: "SYS1", description: "emits handoff", technology: "function call" },
        ],
      },
      null,
      2,
    ),
  )
  await Bun.write(
    planPath.replace("implementation-spec.md", "sequence.json"),
    JSON.stringify(
      [
        {
          diagram_title: "Handoff Flow",
          scenario: "plan exit",
          moduleRef: "A1",
          participants: [
            { id: "P1", name: "Planner", type: "actor", componentRef: "SYS1" },
            { id: "P2", name: "PlanExitTool", type: "component", componentRef: "C1" },
          ],
          messages: [{ id: "MSG1", from: "P1", to: "P2", label: "exit plan", type: "sync", order: 1 }],
          fragments: [],
        },
      ],
      null,
      2,
    ),
  )
}

async function writeValidPlanArtifacts(planPath: string) {
  await Bun.write(
    planPath,
    "# Implementation Spec\n\n## Goal\n- Test planner handoff\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n- Implement planner restoration\n- Run validation checks\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
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
  await writePlannerJsonArtifacts(planPath)
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

          expect(planPath).toContain("/plans/")
          expect(planPath).not.toContain("/specs/changes/")
          expect(planPath).toEndWith("/implementation-spec.md")
          const planText = await Bun.file(planPath).text()
          expect(planText).toContain("## Goal")
          expect(planText).toContain("## Structured Execution Phases")
          expect(planText).toContain("## Handoff")
          const artifacts = plannerArtifacts(session)
          expect(await Bun.file(artifacts.proposal).exists()).toBe(true)
          expect(await Bun.file(artifacts.spec).exists()).toBe(true)
          expect(await Bun.file(artifacts.design).exists()).toBe(true)
          expect(await Bun.file(artifacts.tasks).exists()).toBe(true)
          expect(await Bun.file(artifacts.handoff).exists()).toBe(true)
          expect(await Bun.file(artifacts.proposal).text()).toContain("## Effective Requirement Description")
          expect(await Bun.file(artifacts.design).text()).toContain("## Data / State / Control Flow")
          expect(await Bun.file(artifacts.tasks).text()).toContain("## 2. Delegated Execution Slices")
          expect(await Bun.file(artifacts.handoff).text()).toContain("Prefer delegation-first execution")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_enter announces beta workflow as the default planner contract", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const { PlanEnterTool } = await import("../../src/tool/plan")
          const tool = await PlanEnterTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test_beta_default",
            callID: "call_test_beta_default",
            agent: "build",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
          const result = await execute
          expect(result.output).toContain("Beta workflow is the default planner contract")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_enter prefers templates/specs artifacts when available", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const templatesRoot = path.join(tmp.path, "templates", "specs")
          await Bun.write(
            path.join(templatesRoot, "proposal.md"),
            '# Proposal\n\n## Why\n- template proposal marker\n\n## Original Requirement Wording (Baseline)\n- "template baseline"\n\n## Requirement Revision History\n- template revision\n\n## Effective Requirement Description\n1. template effective requirement\n\n## Scope\n### IN\n- template in\n\n### OUT\n- template out\n\n## Non-Goals\n- template non-goal\n\n## Constraints\n- template constraint\n\n## What Changes\n- template what changes\n\n## Capabilities\n### New Capabilities\n- template-capability: template capability\n\n### Modified Capabilities\n- existing-capability: template delta\n\n## Impact\n- template impact\n',
          )
          const session = await Session.create({})
          const { PlanEnterTool } = await import("../../src/tool/plan")
          const tool = await PlanEnterTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test_template",
            callID: "call_test_template",
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

          const artifacts = plannerArtifacts(session)
          const proposalText = await Bun.file(artifacts.proposal).text()
          expect(proposalText).toContain("template proposal marker")
          expect(proposalText).toContain("template effective requirement")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_enter prefers OPENCODE_PLANNER_TEMPLATE_DIR over repo templates", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    const originalTemplateDir = process.env.OPENCODE_PLANNER_TEMPLATE_DIR
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const systemTemplatesRoot = path.join(tmp.path, "system-specs")
          const repoTemplatesRoot = path.join(tmp.path, "templates", "specs")
          await Bun.write(
            path.join(systemTemplatesRoot, "proposal.md"),
            '# Proposal\n\n## Why\n- system template marker\n\n## Original Requirement Wording (Baseline)\n- "system baseline"\n\n## Requirement Revision History\n- system revision\n\n## Effective Requirement Description\n1. system effective requirement\n\n## Scope\n### IN\n- system in\n\n### OUT\n- system out\n\n## Non-Goals\n- system non-goal\n\n## Constraints\n- system constraint\n\n## What Changes\n- system what changes\n\n## Capabilities\n### New Capabilities\n- system-capability: system capability\n\n### Modified Capabilities\n- system-existing: system delta\n\n## Impact\n- system impact\n',
          )
          await Bun.write(
            path.join(repoTemplatesRoot, "proposal.md"),
            '# Proposal\n\n## Why\n- repo template marker\n\n## Original Requirement Wording (Baseline)\n- "repo baseline"\n\n## Requirement Revision History\n- repo revision\n\n## Effective Requirement Description\n1. repo effective requirement\n\n## Scope\n### IN\n- repo in\n\n### OUT\n- repo out\n\n## Non-Goals\n- repo non-goal\n\n## Constraints\n- repo constraint\n\n## What Changes\n- repo what changes\n\n## Capabilities\n### New Capabilities\n- repo-capability: repo capability\n\n### Modified Capabilities\n- repo-existing: repo delta\n\n## Impact\n- repo impact\n',
          )
          process.env.OPENCODE_PLANNER_TEMPLATE_DIR = systemTemplatesRoot
          const session = await Session.create({})
          const { PlanEnterTool } = await import("../../src/tool/plan")
          const tool = await PlanEnterTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test_system_template",
            callID: "call_test_system_template",
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

          const artifacts = plannerArtifacts(session)
          const proposalText = await Bun.file(artifacts.proposal).text()
          expect(proposalText).toContain("system template marker")
          expect(proposalText).not.toContain("repo template marker")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
      if (originalTemplateDir === undefined) delete process.env.OPENCODE_PLANNER_TEMPLATE_DIR
      else process.env.OPENCODE_PLANNER_TEMPLATE_DIR = originalTemplateDir
    }
  })

  test("plan_enter reuses existing planner root after session title changes", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const initialArtifacts = plannerArtifacts({ ...session, title: undefined })

          await Bun.write(
            initialArtifacts.implementationSpec,
            "# Implementation Spec\n\n## Goal\n- Keep planner root stable\n\n## Scope\n### IN\n- planner reuse\n\n### OUT\n- runtime rewrite\n\n## Assumptions\n- title may change\n\n## Stop Gates\n- stop on missing artifacts\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Re-enter plan mode\n\n## Validation\n- Run planner tests\n\n## Handoff\n- Continue from same planner package\n",
          )
          await Bun.write(
            initialArtifacts.proposal,
            "# Proposal\n\n## Why\n- keep same root\n\n## What Changes\n- reuse planner package\n\n## Capabilities\n### New Capabilities\n- root-reuse: stable planner package\n\n### Modified Capabilities\n- planner-entry: prefers existing root\n\n## Impact\n- affects planner path reuse\n",
          )
          await Bun.write(
            initialArtifacts.spec,
            "# Spec\n\n## Purpose\n- reuse existing planner package\n\n## Requirements\n\n### Requirement: planner re-entry reuses same package\nThe system SHALL reuse the prior planner package for the same session when it already exists.\n\n#### Scenario: title changed after first entry\n- **GIVEN** an existing planner package\n- **WHEN** plan mode is re-entered\n- **THEN** the same package is reused\n\n## Acceptance Checks\n- no second planner root is created\n",
          )
          await Bun.write(
            initialArtifacts.design,
            "# Design\n\n## Context\n- session titles can change after first user prompt\n\n## Goals / Non-Goals\n**Goals:**\n- reuse planner package\n\n**Non-Goals:**\n- rename old package\n\n## Decisions\n- prefer existing root before minting a new one\n\n## Risks / Trade-offs\n- stale root reuse -> guard by checking implementation-spec existence\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n",
          )
          await Bun.write(initialArtifacts.tasks, "# Tasks\n\n- [ ] Re-enter plan mode\n")
          await Bun.write(
            initialArtifacts.handoff,
            "# Handoff\n\n## Execution Contract\n- Build agent must read implementation-spec.md first\n\n## Required Reads\n- implementation-spec.md\n- design.md\n- tasks.md\n\n## Stop Gates In Force\n- Preserve approval gates\n\n## Execution-Ready Checklist\n- [ ] Implementation spec is complete\n",
          )

          await Session.update(
            session.id,
            (draft) => {
              draft.title = "Consolidate planner root reuse"
            },
            { touch: false },
          )

          const updated = await Session.get(session.id)
          const titleArtifacts = plannerArtifacts(updated)
          expect(titleArtifacts.root).not.toBe(initialArtifacts.root)

          const { PlanEnterTool } = await import("../../src/tool/plan")
          const tool = await PlanEnterTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test_reuse",
            callID: "call_test_reuse",
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

          expect(await Bun.file(initialArtifacts.implementationSpec).exists()).toBe(true)
          expect(await Bun.file(titleArtifacts.implementationSpec).exists()).toBe(false)
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("auto-routes non-trivial implementation requests into plan mode", async () => {
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

  test("does not auto-route lightweight status questions into plan mode", async () => {
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

  test("does not auto-route status-only requests into plan mode", async () => {
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

  test("does not auto-route plain status questions into plan mode", async () => {
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

  test("does not auto-route explicit plan_exit requests into plan mode", async () => {
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
            parts: [{ type: "text", text: "go on plan_exit" }],
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

  test("does not auto-route build-mode switch requests into plan mode", async () => {
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
            parts: [{ type: "text", text: "Switch to build mode and start executing the plan." }],
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
          const expectedBetaAnswers = [
            tmp.path,
            tmp.path,
            "cms",
            `${tmp.path}-beta`,
            `${tmp.path}-beta`,
            `feature/${session.slug}-beta`,
            tmp.path,
          ]
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
          await writePlannerJsonArtifacts(planPath)

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const expectedBetaAnswers = [
            tmp.path,
            tmp.path,
            "cms",
            `${tmp.path}-beta`,
            `${tmp.path}-beta`,
            `feature/${session.slug}-beta`,
            tmp.path,
          ]
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
          await answerNextQuestion(session.id, expectedBetaAnswers)
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
          expect(handoffPart.text).toContain("Build mode is now active.")
          expect(handoffPart.text).toContain("Beta workflow is now the default execution contract")
          expect(handoffPart.metadata?.handoff?.betaWorkflowDefault).toBe(true)
          expect(handoffPart.metadata?.handoff?.materializedTodos?.length).toBeGreaterThanOrEqual(3)
          expect(handoffPart.metadata?.handoff?.todoMaterializationPolicy).toMatchObject({
            source: "tasks.md unchecked checklist items",
            includeChecked: false,
            maxSeedItems: 8,
            dependencyStrategy: "linear_chain",
            firstTodoStatus: "in_progress",
            remainingStatus: "pending",
          })
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

          const updatedSession = await Session.get(session.id)
          expect(updatedSession.mission).toMatchObject({
            source: "openspec_compiled_plan",
            contract: "implementation_spec",
            executionReady: true,
          })
          expect(updatedSession.mission?.planPath).toContain("implementation-spec.md")
          expect(updatedSession.mission?.artifactPaths?.handoff).toContain("handoff.md")

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

  test("plan_exit normalizes explicit No into a workflow decision stop", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await writeValidPlanArtifacts(planPath)

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test_no",
            callID: "call_test_no",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reply({ requestID: pending[0].id, answers: [["No"]] })
          await expect(execute).rejects.toThrow("product_decision_needed: plan_exit remained in plan mode")
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit normalizes dismissed confirmation into a workflow decision stop", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const planPath = Session.plan(session)
          await writeValidPlanArtifacts(planPath)

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execute = tool.execute({}, {
            sessionID: session.id,
            abort: new AbortController().signal,
            messageID: "msg_test_dismiss",
            callID: "call_test_dismiss",
            agent: "plan",
            messages: [],
            metadata: async () => {},
            ask: async () => [["Yes"]],
            extra: {},
          } as any)

          const pending = await waitForPendingQuestion(session.id)
          expect(pending.length).toBe(1)
          await Question.reject(pending[0].id)
          await expect(execute).rejects.toThrow(
            "product_decision_needed: plan_exit build-mode confirmation was dismissed",
          )
          await Session.remove(session.id)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit passes beta admission quiz and persists success", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"
    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await Session.setMission({
            sessionID: session.id,
            mission: {
              source: "openspec_compiled_plan",
              contract: "implementation_spec",
              approvedAt: 1,
              planPath: "plans/seed/implementation-spec.md",
              executionReady: false,
              artifactPaths: plannerArtifacts(session),
              beta: {
                branchName: "feature/test-beta",
                baseBranch: "cms",
                repoPath: "/repo",
                mainWorktreePath: "/repo",
                betaPath: "/repo-beta",
              },
            } as any,
          })
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nTest planner handoff\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [ ] 1.1 Task A\n",
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
            "# Handoff\n\n## Execution Contract\n- Build agent reads implementation-spec.md first\n\n## Required Reads\n- implementation-spec.md\n- design.md\n- tasks.md\n\n## Stop Gates In Force\n- Preserve approval and decision gates\n\n## Execution-Ready Checklist\n- [ ] Implementation spec complete\n",
          )
          await writePlannerJsonArtifacts(planPath)

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const expectedBetaAnswers = [
            tmp.path,
            tmp.path,
            "cms",
            `${tmp.path}-beta`,
            `${tmp.path}-beta`,
            `feature/${session.slug}-beta`,
            tmp.path,
          ]
          const execution = tool.execute({}, {
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
          await answerNextQuestion(session.id, ["Yes"])
          await answerNextQuestion(session.id, expectedBetaAnswers)
          await execution

          const updated = await Session.get(session.id)
          expect(updated.mission?.admission?.betaQuiz).toMatchObject({ status: "passed", reflectionUsed: false })
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit allows one beta admission retry and then passes", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"
    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await Session.setMission({
            sessionID: session.id,
            mission: {
              source: "openspec_compiled_plan",
              contract: "implementation_spec",
              approvedAt: 1,
              planPath: "plans/seed/implementation-spec.md",
              executionReady: false,
              artifactPaths: plannerArtifacts(session),
              beta: {
                branchName: "feature/test-beta",
                baseBranch: "cms",
                repoPath: "/repo",
                mainWorktreePath: "/repo",
                betaPath: "/repo-beta",
              },
            } as any,
          })
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nTest planner handoff\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [ ] 1.1 Task A\n",
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
            "# Handoff\n\n## Execution Contract\n- Build agent reads implementation-spec.md first\n\n## Required Reads\n- implementation-spec.md\n- design.md\n- tasks.md\n\n## Stop Gates In Force\n- Preserve approval and decision gates\n\n## Execution-Ready Checklist\n- [ ] Implementation spec complete\n",
          )
          await writePlannerJsonArtifacts(planPath)

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const expectedBetaAnswers = [
            tmp.path,
            tmp.path,
            "cms",
            `${tmp.path}-beta`,
            `${tmp.path}-beta`,
            `feature/${session.slug}-beta`,
            tmp.path,
          ]
          const execution = tool.execute({}, {
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
          await answerNextQuestion(session.id, ["Yes"])
          await answerNextQuestion(session.id, [
            "/wrong",
            tmp.path,
            "cms",
            `${tmp.path}-beta`,
            `${tmp.path}-beta`,
            `feature/${session.slug}-beta`,
            tmp.path,
          ])
          await answerNextQuestion(session.id, expectedBetaAnswers)
          await execution

          const updated = await Session.get(session.id)
          expect(updated.mission?.admission?.betaQuiz).toMatchObject({ status: "passed", reflectionUsed: true })
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })

  test("plan_exit stops after second beta admission mismatch", async () => {
    const originalClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "app"
    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await Session.setMission({
            sessionID: session.id,
            mission: {
              source: "openspec_compiled_plan",
              contract: "implementation_spec",
              approvedAt: 1,
              planPath: "plans/seed/implementation-spec.md",
              executionReady: false,
              artifactPaths: plannerArtifacts(session),
              beta: {
                branchName: "feature/test-beta",
                baseBranch: "cms",
                repoPath: "/repo",
                mainWorktreePath: "/repo",
                betaPath: "/repo-beta",
              },
            } as any,
          })
          const planPath = Session.plan(session)
          await Bun.write(
            planPath,
            "# Plan\n\n## Goal\nTest planner handoff\n\n## Scope\n### IN\n- planner runtime\n\n### OUT\n- daemon rewrite\n\n## Assumptions\n- runtime state is available\n\n## Stop Gates\n- pause if approval is needed\n\n## Critical Files\n- packages/opencode/src/tool/plan.ts\n\n## Structured Execution Phases\n- Read the approved spec\n\n## Validation\n- Run targeted tests\n\n## Handoff\n- Build should execute from this spec\n",
          )
          await Bun.write(
            planPath.replace("implementation-spec.md", "tasks.md"),
            "# Tasks\n\n## 1. Workstream\n- [ ] 1.1 Task A\n",
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
            "# Handoff\n\n## Execution Contract\n- Build agent reads implementation-spec.md first\n\n## Required Reads\n- implementation-spec.md\n- design.md\n- tasks.md\n\n## Stop Gates In Force\n- Preserve approval and decision gates\n\n## Execution-Ready Checklist\n- [ ] Implementation spec complete\n",
          )
          await writePlannerJsonArtifacts(planPath)

          const { PlanExitTool } = await import("../../src/tool/plan")
          const tool = await PlanExitTool.init()
          const execution = tool.execute({}, {
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
          await answerNextQuestion(session.id, ["Yes"])
          await answerNextQuestion(session.id, [
            "/wrong",
            tmp.path,
            "wrong",
            `${tmp.path}-beta`,
            `${tmp.path}-beta`,
            "wrong",
            "/wrong",
          ])
          await answerNextQuestion(session.id, [
            "/wrong",
            tmp.path,
            "wrong",
            `${tmp.path}-beta`,
            `${tmp.path}-beta`,
            "wrong",
            "/wrong",
          ])
          await expect(execution).rejects.toThrow("product_decision_needed: beta admission mismatches after retry")

          const updated = await Session.get(session.id)
          expect(updated.mission?.admission?.betaQuiz).toMatchObject({ status: "failed", reflectionUsed: true })
          expect(updated.mission?.admission?.betaQuiz?.lastMismatches?.length).toBeGreaterThan(0)
        },
      })
    } finally {
      if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = originalClient
    }
  })
})
