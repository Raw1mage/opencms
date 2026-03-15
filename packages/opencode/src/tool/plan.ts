import z from "zod"
import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { Todo } from "../session/todo"
import { plannerArtifacts } from "../session/planner-layout"
import { extractChecklistItems } from "../session/tasks-checklist"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"

const PLAN_REQUIRED_SECTIONS = [
  "Goal",
  "Scope",
  "Assumptions",
  "Stop Gates",
  "Critical Files",
  "Structured Execution Phases",
  "Validation",
  "Handoff",
] as const

const PLAN_SPEC_TEMPLATE = `# Implementation Spec

## Goal
- <one-sentence execution objective>

## Scope
### IN
- <in scope>

### OUT
- <out of scope>

## Assumptions
- <assumption>

## Stop Gates
- <approval / decision / blocker conditions>
- <when to stop and re-enter planning>

## Critical Files
- <absolute or repo-relative file paths>

## Structured Execution Phases
- <phase 1: planner / runtime contract rewrite>
- <phase 2: delegated execution / integration slice>
- <phase 3: validation / documentation sync>

## Validation
- <tests / commands / end-to-end checks>
- <operator or runtime verification>

## Handoff
- Build agent must read this spec first.
- Build agent must read \
  proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must prefer delegation-first execution when the task slice can be safely handed off.
`

const ARTIFACT_TEMPLATES = {
  proposal: `# Proposal\n\n## Why\n- <why this work exists>\n- <problem / opportunity / pressure>\n\n## Original Requirement Wording (Baseline)\n- \"<record the user's original requirement wording as faithfully as practical>\"\n\n## Requirement Revision History\n- <date or stage>: <what changed and why>\n\n## Effective Requirement Description\n1. <effective requirement>\n2. <effective requirement>\n\n## Scope\n### IN\n- <in scope>\n\n### OUT\n- <out of scope>\n\n## Non-Goals\n- <explicitly not being solved>\n\n## Constraints\n- <technical / product / policy constraint>\n\n## What Changes\n- <what will change>\n- <what behavior / modules / flows are affected>\n\n## Capabilities\n### New Capabilities\n- <capability>: <brief description>\n\n### Modified Capabilities\n- <existing capability>: <behavior delta>\n\n## Impact\n- <affected code, APIs, systems, operators, or docs>\n`,
  spec: `# Spec\n\n## Purpose\n- <behavioral intent of this change>\n\n## Requirements\n\n### Requirement: <name>\nThe system SHALL <behavior>.\n\n#### Scenario: <name>\n- **GIVEN** <context>\n- **WHEN** <action>\n- **THEN** <outcome>\n\n## Acceptance Checks\n- <observable verification point>\n- <runtime / UX / operator-visible acceptance check>\n`,
  design: `# Design\n\n## Context\n- <current state / background>\n- <relevant architecture / runtime / operator context>\n\n## Goals / Non-Goals\n**Goals:**\n- <goal>\n- <goal>\n\n**Non-Goals:**\n- <non-goal>\n- <non-goal>\n\n## Decisions\n- <decision and rationale>\n- <decision and rationale>\n\n## Data / State / Control Flow\n- <request / state / config flow>\n- <boundary transitions>\n\n## Risks / Trade-offs\n- <risk> -> <mitigation>\n- <trade-off> -> <why chosen>\n\n## Critical Files\n- <file path>\n- <file path>\n`,
  tasks: `# Tasks\n\n## 1. Planner Contract Rewrite\n- [ ] 1.1 Read the approved implementation spec and companion artifacts\n- [ ] 1.2 Rewrite planner/runtime contract files\n\n## 2. Delegated Execution Slices\n- [ ] 2.1 Delegate or implement the first dependency-ready execution slice\n- [ ] 2.2 Integrate follow-up slices using the same planner task naming\n\n## 3. Validation\n- [ ] 3.1 Run targeted validation\n- [ ] 3.2 Record validation evidence\n\n## 4. Documentation / Retrospective\n- [ ] 4.1 Sync relevant event / architecture docs\n- [ ] 4.2 Compare implementation against the proposal's effective requirement description\n`,
  handoff: `# Handoff\n\n## Execution Contract\n- Build agent must read implementation-spec.md first\n- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding\n- Materialize tasks.md into runtime todos before coding\n- Preserve planner task naming in user-visible progress and runtime todo\n- Prefer delegation-first execution when a task slice can be safely handed off\n\n## Required Reads\n- implementation-spec.md\n- proposal.md\n- spec.md\n- design.md\n- tasks.md\n\n## Stop Gates In Force\n- Preserve approval, decision, and blocker gates from implementation-spec.md\n- Return to planning if a new implementation slice is not represented in planner artifacts\n\n## Execution-Ready Checklist\n- [ ] Implementation spec is complete\n- [ ] Companion artifacts are aligned\n- [ ] Validation plan is explicit\n- [ ] Runtime todo seed is present in tasks.md\n`,
} as const

async function loadPlannerTemplate(relativePath: string, fallback: string) {
  const candidates = [
    process.env.OPENCODE_PLANNER_TEMPLATE_DIR || "/etc/opencode/specs",
    path.join(Instance.worktree, "templates", "specs"),
  ]

  for (const base of candidates) {
    const templatePath = path.join(base, relativePath)
    const file = Bun.file(templatePath)
    if (await file.exists()) {
      const text = await file.text().catch(() => "")
      if (text.trim()) return text
    }
  }

  return fallback
}

async function loadArtifactTemplates() {
  return {
    implementationSpec: await loadPlannerTemplate("implementation-spec.md", PLAN_SPEC_TEMPLATE),
    proposal: await loadPlannerTemplate("proposal.md", ARTIFACT_TEMPLATES.proposal),
    spec: await loadPlannerTemplate("spec.md", ARTIFACT_TEMPLATES.spec),
    design: await loadPlannerTemplate("design.md", ARTIFACT_TEMPLATES.design),
    tasks: await loadPlannerTemplate("tasks.md", ARTIFACT_TEMPLATES.tasks),
    handoff: await loadPlannerTemplate("handoff.md", ARTIFACT_TEMPLATES.handoff),
  }
}

const ARTIFACT_REQUIRED_HEADINGS = {
  proposal: ["Why", "What Changes", "Capabilities", "Impact"],
  spec: ["Purpose", "Requirements", "Acceptance Checks"],
  design: ["Context", "Goals / Non-Goals", "Decisions", "Risks / Trade-offs", "Critical Files"],
  tasks: ["Tasks"],
  handoff: ["Execution Contract", "Required Reads", "Stop Gates In Force", "Execution-Ready Checklist"],
} as const

async function getLastModel(sessionID: string) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

function digest(text: string) {
  return createHash("sha1").update(text).digest("hex")
}

function extractSection(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = markdown.match(new RegExp(`(^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"))
  return match?.[2]?.trim() ?? ""
}

function extractBulletItems(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
}

async function readPlannerArtifacts(session: Session.Info) {
  const artifactPaths = await resolvePlannerArtifacts(session)
  const implementationSpecPath = artifactPaths.implementationSpec
  const root = artifactPaths.root
  const implementationSpec = await Bun.file(implementationSpecPath)
    .text()
    .catch(() => "")
  const proposal = await Bun.file(artifactPaths.proposal)
    .text()
    .catch(() => "")
  const spec = await Bun.file(artifactPaths.spec)
    .text()
    .catch(() => "")
  const design = await Bun.file(artifactPaths.design)
    .text()
    .catch(() => "")
  const tasks = await Bun.file(artifactPaths.tasks)
    .text()
    .catch(() => "")
  const handoff = await Bun.file(artifactPaths.handoff)
    .text()
    .catch(() => "")
  return { root, implementationSpec, proposal, spec, design, tasks, handoff }
}

async function hasImplementationSpec(root: string) {
  return Bun.file(path.join(root, "implementation-spec.md")).exists()
}

async function resolvePlannerArtifacts(session: Session.Info) {
  const missionRoot = session.mission?.artifactPaths?.root
  if (missionRoot) {
    const absoluteMissionRoot = path.isAbsolute(missionRoot) ? missionRoot : path.join(Instance.worktree, missionRoot)
    if (await hasImplementationSpec(absoluteMissionRoot)) {
      return {
        root: absoluteMissionRoot,
        implementationSpec: path.join(absoluteMissionRoot, "implementation-spec.md"),
        proposal: path.join(absoluteMissionRoot, "proposal.md"),
        spec: path.join(absoluteMissionRoot, "spec.md"),
        design: path.join(absoluteMissionRoot, "design.md"),
        tasks: path.join(absoluteMissionRoot, "tasks.md"),
        handoff: path.join(absoluteMissionRoot, "handoff.md"),
      }
    }
  }

  const titleBased = plannerArtifacts(session)
  if (await hasImplementationSpec(titleBased.root)) return titleBased

  const slugBased = plannerArtifacts({ ...session, title: undefined })
  if (await hasImplementationSpec(slugBased.root)) return slugBased

  return titleBased
}

function analyzePlanSpec(markdown: string) {
  const sectionMap = {
    goal: extractSection(markdown, "Goal"),
    scope: extractSection(markdown, "Scope"),
    assumptions: extractSection(markdown, "Assumptions"),
    stopGates: extractSection(markdown, "Stop Gates"),
    criticalFiles: extractSection(markdown, "Critical Files"),
    executionPhases:
      extractSection(markdown, "Structured Execution Phases") || extractSection(markdown, "Execution Phases"),
    validation: extractSection(markdown, "Validation") || extractSection(markdown, "Validation Plan"),
    handoff: extractSection(markdown, "Handoff"),
  }

  const missingSections = PLAN_REQUIRED_SECTIONS.filter((heading) => !extractSection(markdown, heading).trim())
  const schema = z.object({
    goal: z.string().min(1),
    scope: z.string().min(1),
    assumptions: z.string().min(1),
    stopGates: z.string().min(1),
    criticalFiles: z.string().min(1),
    executionPhases: z.string().min(1),
    validation: z.string().min(1),
    handoff: z.string().min(1),
  })
  const schemaIssues: string[] = []
  const parsed = schema.safeParse(sectionMap)
  if (!parsed.success) {
    schemaIssues.push(...parsed.error.issues.map((issue) => issue.path.join(".") || "schema"))
  }

  if (!/###\s*in\b/i.test(sectionMap.scope) || !/###\s*out\b/i.test(sectionMap.scope)) {
    schemaIssues.push("scope must contain both '### IN' and '### OUT'")
  }
  if (extractBulletItems(sectionMap.executionPhases).length === 0) {
    schemaIssues.push("structured execution phases must contain at least one bullet item")
  }
  if (extractBulletItems(sectionMap.criticalFiles).length === 0) {
    schemaIssues.push("critical files must contain at least one bullet item")
  }
  if (extractBulletItems(sectionMap.validation).length === 0) {
    schemaIssues.push("validation must contain at least one bullet item")
  }
  const placeholders = Object.entries(sectionMap)
    .filter(([, value]) => /<[^>]+>/.test(value))
    .map(([key]) => key)
  if (placeholders.length) {
    schemaIssues.push(`placeholder tokens remain in sections: ${placeholders.join(", ")}`)
  }

  return { sectionMap, missingSections, schemaIssues }
}

function extractTasksChecklistItems(tasksMarkdown: string) {
  return extractChecklistItems(tasksMarkdown)
}

function analyzeTasksArtifact(tasksMarkdown: string) {
  const issues: string[] = []
  if (!tasksMarkdown.trim()) {
    issues.push("tasks.md is empty")
    return { checklistItems: [], issues }
  }

  if (!/^#\s+Tasks\b/im.test(tasksMarkdown)) {
    issues.push("tasks.md must include a '# Tasks' heading")
  }

  const checklistItems = extractTasksChecklistItems(tasksMarkdown)
  if (checklistItems.length === 0) {
    issues.push("tasks.md must include at least one unchecked checklist item")
  }

  if (/<[^>]+>/.test(tasksMarkdown)) {
    issues.push("tasks.md still contains placeholder tokens")
  }

  return { checklistItems, issues }
}

function analyzeProposalArtifact(proposalMarkdown: string) {
  const issues: string[] = []
  const missingHeadings = ARTIFACT_REQUIRED_HEADINGS.proposal.filter(
    (heading) => !extractSection(proposalMarkdown, heading).trim(),
  )
  if (!proposalMarkdown.trim()) issues.push("proposal.md is empty")
  if (missingHeadings.length) issues.push(`proposal.md missing headings: ${missingHeadings.join(", ")}`)
  if (/<[^>]+>/.test(proposalMarkdown)) issues.push("proposal.md still contains placeholder tokens")

  const why = extractBulletItems(extractSection(proposalMarkdown, "Why"))
  const whatChanges = extractBulletItems(extractSection(proposalMarkdown, "What Changes"))
  const impact = extractBulletItems(extractSection(proposalMarkdown, "Impact"))
  if (why.length === 0) issues.push("proposal.md must explain why this change exists")
  if (whatChanges.length === 0) issues.push("proposal.md must describe what changes")
  if (impact.length === 0) issues.push("proposal.md must describe impact")

  return { issues }
}

function analyzeBehaviorSpecArtifact(specMarkdown: string) {
  const issues: string[] = []
  const missingHeadings = ARTIFACT_REQUIRED_HEADINGS.spec.filter(
    (heading) => !extractSection(specMarkdown, heading).trim(),
  )
  if (!specMarkdown.trim()) issues.push("spec.md is empty")
  if (missingHeadings.length) issues.push(`spec.md missing headings: ${missingHeadings.join(", ")}`)
  if (/<[^>]+>/.test(specMarkdown)) issues.push("spec.md still contains placeholder tokens")
  if (!/###\s+Requirement:/m.test(specMarkdown))
    issues.push("spec.md must include at least one '### Requirement:' section")
  if (!/####\s+Scenario:/m.test(specMarkdown)) issues.push("spec.md must include at least one '#### Scenario:' section")
  if (extractBulletItems(extractSection(specMarkdown, "Acceptance Checks")).length === 0) {
    issues.push("spec.md must include at least one acceptance check")
  }
  return { issues }
}

function analyzeDesignArtifact(designMarkdown: string) {
  const issues: string[] = []
  const missingHeadings = ARTIFACT_REQUIRED_HEADINGS.design.filter(
    (heading) => !extractSection(designMarkdown, heading).trim(),
  )
  if (!designMarkdown.trim()) issues.push("design.md is empty")
  if (missingHeadings.length) issues.push(`design.md missing headings: ${missingHeadings.join(", ")}`)
  if (/<[^>]+>/.test(designMarkdown)) issues.push("design.md still contains placeholder tokens")

  const decisions = extractBulletItems(extractSection(designMarkdown, "Decisions"))
  const risks = extractBulletItems(extractSection(designMarkdown, "Risks / Trade-offs"))
  const criticalFiles = extractBulletItems(extractSection(designMarkdown, "Critical Files"))
  if (decisions.length === 0) issues.push("design.md must record at least one design decision")
  if (risks.length === 0) issues.push("design.md must record at least one risk or trade-off")
  if (criticalFiles.length === 0) issues.push("design.md must list at least one critical file")
  return { issues }
}

function analyzeHandoffArtifact(handoffMarkdown: string) {
  const issues: string[] = []
  const missingHeadings = ARTIFACT_REQUIRED_HEADINGS.handoff.filter(
    (heading) => !extractSection(handoffMarkdown, heading).trim(),
  )
  if (!handoffMarkdown.trim()) issues.push("handoff.md is empty")
  if (missingHeadings.length) issues.push(`handoff.md missing headings: ${missingHeadings.join(", ")}`)
  if (/<[^>]+>/.test(handoffMarkdown)) issues.push("handoff.md still contains placeholder tokens")

  const requiredReads = extractBulletItems(extractSection(handoffMarkdown, "Required Reads"))
  const stopGates = extractBulletItems(extractSection(handoffMarkdown, "Stop Gates In Force"))
  const readinessChecklist = handoffMarkdown
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^-\s*\[(?:\s|x)\]\s+/.test(line))
  if (requiredReads.length === 0) issues.push("handoff.md must list required reads for the executor")
  if (stopGates.length === 0) issues.push("handoff.md must preserve stop gates in force")
  if (readinessChecklist.length === 0) issues.push("handoff.md must include an execution-ready checklist")
  return { issues }
}

function buildClarificationMapping(input: {
  implementationSpec: ReturnType<typeof analyzePlanSpec>
  proposal: string
  spec: string
  design: string
  tasks: string
  handoff: string
}) {
  const scopeItems = extractBulletItems(input.implementationSpec.sectionMap.scope)
  const validationItems = extractBulletItems(input.implementationSpec.sectionMap.validation)
  const stopGateItems = extractBulletItems(input.implementationSpec.sectionMap.stopGates)
  const taskItems = extractTasksChecklistItems(input.tasks)
  const riskItems = extractBulletItems(extractSection(input.design, "Risks / Trade-offs"))
  const decisionItems = extractBulletItems(extractSection(input.design, "Decisions"))
  const impactItems = extractBulletItems(extractSection(input.proposal, "Impact"))
  const acceptanceChecks = extractBulletItems(extractSection(input.spec, "Acceptance Checks"))

  return {
    scope: {
      values: scopeItems,
      mappedTo: ["implementation-spec.md#Scope", "proposal.md#What Changes", "tasks.md#Tasks"],
    },
    validation: {
      values: validationItems.length ? validationItems : acceptanceChecks,
      mappedTo: [
        "implementation-spec.md#Validation",
        "spec.md#Acceptance Checks",
        "tasks.md#Tasks",
        "handoff.md#Execution-Ready Checklist",
      ],
    },
    stopGates: {
      values: stopGateItems,
      mappedTo: ["implementation-spec.md#Stop Gates", "handoff.md#Stop Gates In Force"],
    },
    delegation: {
      values: taskItems,
      mappedTo: ["tasks.md#Tasks", "handoff.md#Execution Contract"],
    },
    riskPosture: {
      values: riskItems.length ? riskItems : impactItems,
      mappedTo: ["design.md#Risks / Trade-offs", "proposal.md#Impact", "handoff.md#Execution Contract"],
    },
    decisions: {
      values: decisionItems,
      mappedTo: ["design.md#Decisions", "implementation-spec.md#Handoff"],
    },
  }
}

function materializePlanTodos(input: { implementationSpec: string; tasks: string }): Todo.Info[] {
  const { sectionMap } = analyzePlanSpec(input.implementationSpec)
  const phaseSection = sectionMap.executionPhases
  const handoffSection = sectionMap.handoff
  const scopeSection = sectionMap.scope
  const validationSection = sectionMap.validation

  const { checklistItems: taskItems } = analyzeTasksArtifact(input.tasks)
  const phaseItems = extractBulletItems(phaseSection)
  const handoffItems = extractBulletItems(handoffSection)
  const scopeItems = extractBulletItems(scopeSection)
  const validationItems = extractBulletItems(validationSection)

  const seedItems = taskItems.length
    ? taskItems
    : phaseItems.length
      ? phaseItems
      : handoffItems.length
        ? handoffItems
        : ["Read approved implementation spec and derive execution plan"]

  const todos: Todo.Info[] = seedItems.slice(0, 8).map((content, index) => {
    const status = index === 0 ? "in_progress" : "pending"
    const inferred = (Todo.inferActionFromContent({ content, status }) ?? {}) as Partial<
      NonNullable<Todo.Info["action"]>
    >
    const actionKind = inferred.kind ?? "implement"
    return {
      id: `plan_${index + 1}`,
      content,
      status,
      priority: index === 0 ? "high" : "medium",
      action: {
        ...inferred,
        kind: actionKind,
        dependsOn: index === 0 ? undefined : [`plan_${index}`],
      },
    } satisfies Todo.Info
  })

  if (scopeItems.length) {
    todos.push({
      id: `plan_${todos.length + 1}`,
      content: `Respect scope constraints: ${scopeItems.join("; ")}`,
      status: "pending",
      priority: "high",
      action: { kind: "implement", risk: "medium", dependsOn: [todos[todos.length - 1].id] },
    })
  }

  if (validationItems.length) {
    todos.push({
      id: `plan_${todos.length + 1}`,
      content: `Run validation plan: ${validationItems.join("; ")}`,
      status: "pending",
      priority: "high",
      action: { kind: "implement", risk: "medium", dependsOn: [todos[todos.length - 1].id] },
    })
  }

  return todos
}

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const artifactPaths = await resolvePlannerArtifacts(session)
    const planFile = artifactPaths.implementationSpec
    const planRoot = artifactPaths.root
    const plan = path.relative(Instance.worktree, planFile)
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: `Plan at ${plan} is execution-ready. Would you like to switch to build mode and start executing it?`,
          header: "Build Agent",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to build mode and start executing the plan" },
            { label: "No", description: "Stay in plan mode and continue refining the plan" },
          ],
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]
    if (answer === "No") throw new Question.RejectedError()

    const model = await getLastModel(ctx.sessionID)
    const artifacts = await readPlannerArtifacts(session)
    const planMarkdown = artifacts.implementationSpec
    const spec = analyzePlanSpec(planMarkdown)
    const proposalArtifact = analyzeProposalArtifact(artifacts.proposal)
    const behaviorSpecArtifact = analyzeBehaviorSpecArtifact(artifacts.spec)
    const designArtifact = analyzeDesignArtifact(artifacts.design)
    const taskArtifact = analyzeTasksArtifact(artifacts.tasks)
    const handoffArtifact = analyzeHandoffArtifact(artifacts.handoff)
    const clarificationMapping = buildClarificationMapping({
      implementationSpec: spec,
      proposal: artifacts.proposal,
      spec: artifacts.spec,
      design: artifacts.design,
      tasks: artifacts.tasks,
      handoff: artifacts.handoff,
    })
    if (
      spec.missingSections.length ||
      spec.schemaIssues.length ||
      proposalArtifact.issues.length ||
      behaviorSpecArtifact.issues.length ||
      designArtifact.issues.length ||
      taskArtifact.issues.length ||
      handoffArtifact.issues.length
    ) {
      const details = [
        spec.missingSections.length ? `missing sections: ${spec.missingSections.join(", ")}` : undefined,
        spec.schemaIssues.length ? `schema issues: ${spec.schemaIssues.join("; ")}` : undefined,
        proposalArtifact.issues.length ? `proposal artifact issues: ${proposalArtifact.issues.join("; ")}` : undefined,
        behaviorSpecArtifact.issues.length
          ? `spec artifact issues: ${behaviorSpecArtifact.issues.join("; ")}`
          : undefined,
        designArtifact.issues.length ? `design artifact issues: ${designArtifact.issues.join("; ")}` : undefined,
        taskArtifact.issues.length ? `tasks artifact issues: ${taskArtifact.issues.join("; ")}` : undefined,
        handoffArtifact.issues.length ? `handoff artifact issues: ${handoffArtifact.issues.join("; ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" | ")
      throw new Error(
        `Plan completeness gate failed. ${details}. ` + `Complete the planner artifact set before calling plan_exit.`,
      )
    }
    const planTodos = materializePlanTodos({ implementationSpec: planMarkdown, tasks: artifacts.tasks })
    await Todo.update({ sessionID: ctx.sessionID, todos: planTodos, mode: "plan_materialization" })
    await Session.setMission({
      sessionID: ctx.sessionID,
      mission: {
        source: "openspec_compiled_plan",
        contract: "implementation_spec",
        approvedAt: Date.now(),
        planPath: plan,
        executionReady: true,
        artifactPaths: {
          root: path.relative(Instance.worktree, planRoot),
          implementationSpec: plan,
          proposal: path.relative(Instance.worktree, artifactPaths.proposal),
          spec: path.relative(Instance.worktree, artifactPaths.spec),
          design: path.relative(Instance.worktree, artifactPaths.design),
          tasks: path.relative(Instance.worktree, artifactPaths.tasks),
          handoff: path.relative(Instance.worktree, artifactPaths.handoff),
        },
        artifactIntegrity: {
          implementationSpec: digest(artifacts.implementationSpec),
          tasks: digest(artifacts.tasks),
          handoff: digest(artifacts.handoff),
        },
      },
    })

    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: ctx.sessionID,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: "build",
      model,
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text:
        `The plan at ${plan} has been approved. You are now in build mode, which is execution-first. ` +
        `Todo authority is now strict (execution ledger mode): todos must align with planner-derived tasks. Structure changes require plan_materialization or replan_adoption mode. ` +
        `Use the plan file as the implementation specification and execute it end-to-end. ` +
        `Treat the plan as the source of truth for goal, scope, assumptions, stop gates, validation, critical files, execution phases, and handoff instructions. ` +
        `Before coding, read the plan file carefully, convert its execution phases into structured todos/action metadata, and then continue implementing from that spec. Update the plan artifacts when user intent or scope changes.`,
      synthetic: true,
      metadata: {
        handoff: {
          planPath: plan,
          contract: "implementation_spec",
          requiredSections: [
            "goal",
            "scope",
            "assumptions",
            "stop_gates",
            "validation",
            "critical_files",
            "execution_phases",
            "handoff",
          ],
          missingSections: spec.missingSections,
          artifactIssues: {
            proposal: proposalArtifact.issues,
            spec: behaviorSpecArtifact.issues,
            design: designArtifact.issues,
            tasks: taskArtifact.issues,
            handoff: handoffArtifact.issues,
          },
          clarificationMapping,
          materializedTodos: planTodos.map((todo) => ({
            id: todo.id,
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
          })),
          todoMaterializationPolicy: {
            source: "tasks.md unchecked checklist items",
            includeChecked: false,
            maxSeedItems: 8,
            dependencyStrategy: "linear_chain",
            firstTodoStatus: "in_progress",
            remainingStatus: "pending",
            firstPriority: "high",
            remainingPriority: "medium",
          },
          executionReady: true,
          artifactPaths: {
            root: path.relative(Instance.worktree, planRoot),
            implementationSpec: plan,
            proposal: path.relative(Instance.worktree, path.join(planRoot, "proposal.md")),
            spec: path.relative(Instance.worktree, path.join(planRoot, "spec.md")),
            design: path.relative(Instance.worktree, path.join(planRoot, "design.md")),
            tasks: path.relative(Instance.worktree, path.join(planRoot, "tasks.md")),
            handoff: path.relative(Instance.worktree, path.join(planRoot, "handoff.md")),
          },
        },
      },
    } satisfies MessageV2.TextPart)

    return {
      title: "Switching to build agent",
      output: "User approved switching to build agent. Wait for further instructions.",
      metadata: {},
    }
  },
})

export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const artifactPaths = await resolvePlannerArtifacts(session)
    const planFile = artifactPaths.implementationSpec
    const planRoot = artifactPaths.root
    const plan = path.relative(Instance.worktree, planFile)

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: `Would you like to switch to plan mode and create or refine the active plan saved to ${plan}?`,
          header: "Plan Mode",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to plan mode for spec discussion and plan maintenance" },
            { label: "No", description: "Stay in build mode to continue execution-focused work" },
          ],
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]
    if (answer === "No") throw new Question.RejectedError()

    const model = await getLastModel(ctx.sessionID)
    const existing = await Bun.file(planFile).exists()
    if (!existing) {
      await fs.mkdir(planRoot, { recursive: true })
      const templates = await loadArtifactTemplates()
      await Bun.write(planFile, templates.implementationSpec)
      await Bun.write(artifactPaths.proposal, templates.proposal)
      await Bun.write(artifactPaths.spec, templates.spec)
      await Bun.write(artifactPaths.design, templates.design)
      await Bun.write(artifactPaths.tasks, templates.tasks)
      await Bun.write(artifactPaths.handoff, templates.handoff)
    }

    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: ctx.sessionID,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: "plan",
      model,
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: "User has requested to enter plan mode. Switch to plan mode and begin planner-first discussion, spec maintenance, and plan refinement. Todo authority is now relaxed: you may use todowrite() freely as a working ledger for exploration, debugging, small fixes, and temporary tracking without requiring planner artifacts first.",
      synthetic: true,
    } satisfies MessageV2.TextPart)

    return {
      title: "Switching to plan agent",
      output: `User confirmed to switch to plan mode. A new message has been created to switch you to plan mode. The implementation spec will be at ${plan} and companion artifacts are available under ${path.relative(Instance.worktree, planRoot)}. Begin planner-first discussion and keep the artifacts aligned. Todo authority is now relaxed (working ledger mode).`,
      metadata: {},
    }
  },
})
