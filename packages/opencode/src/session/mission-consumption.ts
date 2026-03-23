import path from "path"
import { realpath } from "fs/promises"
import { createHash } from "crypto"
import { Instance } from "@/project/instance"
import { Session } from "./index"
import { extractChecklistItems } from "./tasks-checklist"

export const BETA_ADMISSION_FIELDS = [
  "mainRepo",
  "mainWorktree",
  "baseBranch",
  "implementationRepo",
  "implementationWorktree",
  "implementationBranch",
  "docsWriteRepo",
] as const

export type BetaAdmissionField = (typeof BETA_ADMISSION_FIELDS)[number]

export type BetaAdmissionMismatch = {
  field: BetaAdmissionField
  expected: string
  actual: string
}

export type BetaAdmissionAuthority = {
  mainRepo: string
  mainWorktree: string
  baseBranch: string
  implementationRepo: string
  implementationWorktree: string
  implementationBranch: string
  docsWriteRepo: string
}

function normalizeAdmissionValue(value: string) {
  return path.normalize(value.trim())
}

export function resolveBetaAdmissionAuthority(mission: Session.Info["mission"]): BetaAdmissionAuthority {
  const beta = mission?.beta
  if (!mission || !beta) throw new Error("beta admission requires mission.beta metadata")
  const mainRepo = normalizeAdmissionValue(beta.repoPath ?? Instance.worktree)
  const mainWorktree = normalizeAdmissionValue(beta.mainWorktreePath ?? beta.repoPath ?? Instance.worktree)
  const implementationRepo = normalizeAdmissionValue(beta.betaPath)
  const implementationWorktree = normalizeAdmissionValue(beta.betaPath)
  const docsWriteRepo = mainRepo
  const baseBranch = beta.baseBranch?.trim()
  const implementationBranch = beta.branchName?.trim()

  if (!mainRepo) throw new Error("beta admission missing authoritative mainRepo")
  if (!mainWorktree) throw new Error("beta admission missing authoritative mainWorktree")
  if (!baseBranch) throw new Error("beta admission missing authoritative baseBranch")
  if (!implementationRepo) throw new Error("beta admission missing authoritative implementationRepo")
  if (!implementationWorktree) throw new Error("beta admission missing authoritative implementationWorktree")
  if (!implementationBranch) throw new Error("beta admission missing authoritative implementationBranch")
  if (!docsWriteRepo) throw new Error("beta admission missing authoritative docsWriteRepo")

  return {
    mainRepo,
    mainWorktree,
    baseBranch,
    implementationRepo,
    implementationWorktree,
    implementationBranch,
    docsWriteRepo,
  }
}

export function evaluateBetaAdmissionAnswers(input: {
  authority: BetaAdmissionAuthority
  answers: Partial<Record<BetaAdmissionField, string>>
}) {
  const mismatches: BetaAdmissionMismatch[] = []
  for (const field of BETA_ADMISSION_FIELDS) {
    const expected = input.authority[field]
    const actual = input.answers[field]?.trim() ?? ""
    const normalizedExpected =
      field.includes("Repo") || field.includes("Worktree") ? normalizeAdmissionValue(expected) : expected
    const normalizedActual =
      field.includes("Repo") || field.includes("Worktree") ? normalizeAdmissionValue(actual) : actual
    if (normalizedExpected !== normalizedActual) {
      mismatches.push({ field, expected, actual })
    }
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
  }
}

function digest(text: string) {
  return createHash("sha1").update(text).digest("hex")
}

function isWithinWorktree(candidate: string) {
  const worktree = path.resolve(Instance.worktree)
  const relative = path.relative(worktree, path.resolve(candidate))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function resolveArtifactPath(relativeOrAbsolute: string) {
  const absolutePath = path.isAbsolute(relativeOrAbsolute)
    ? path.resolve(relativeOrAbsolute)
    : path.resolve(Instance.worktree, relativeOrAbsolute)
  return isWithinWorktree(absolutePath) ? absolutePath : undefined
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

async function readRequiredArtifact(filePath: string, label: string, issues: string[]) {
  const absolutePath = resolveArtifactPath(filePath)
  if (!absolutePath) {
    issues.push(`${label} outside worktree: ${filePath}`)
    return { absolutePath: "", text: "" }
  }
  const file = Bun.file(absolutePath)
  if (!(await file.exists())) {
    issues.push(`${label} missing: ${filePath}`)
    return { absolutePath, text: "" }
  }
  const canonicalPath = await realpath(absolutePath).catch(() => absolutePath)
  if (!isWithinWorktree(canonicalPath)) {
    issues.push(`${label} outside worktree: ${filePath}`)
    return { absolutePath, text: "" }
  }
  const text = await file.text().catch(() => "")
  if (!text.trim()) {
    issues.push(`${label} empty: ${filePath}`)
  }
  return { absolutePath, text }
}

export type MissionConsumptionTrace = {
  source: "openspec_compiled_plan"
  contract: "implementation_spec"
  planPath: string
  consumedArtifacts: {
    implementationSpec: string
    tasks: string
    handoff: string
  }
  goal: string
  scopeSummary: string
  validationChecks: string[]
  executionChecklist: string[]
  requiredReads: string[]
  stopGates: string[]
}

export type DelegatedExecutionRole = "coding" | "testing" | "docs" | "review" | "generic"

export type DelegationTrace = {
  role: DelegatedExecutionRole
  source: "todo_action" | "todo_content" | "mission_validation" | "generic"
  todoID: string
  todoContent: string
}

export function deriveDelegatedExecutionRole(input: {
  todo: { id: string; content: string; action?: { kind?: string } }
  mission: MissionConsumptionTrace
}): DelegationTrace {
  const text = input.todo.content.toLowerCase()
  const actionKind = input.todo.action?.kind
  const validationText = input.mission.validationChecks.join(" \n ").toLowerCase()
  const hasTodoTestingSignal =
    text.includes("test") ||
    text.includes("validate") ||
    text.includes("validation") ||
    text.includes("coverage") ||
    text.includes("integration") ||
    text.includes("e2e") ||
    text.includes("unit") ||
    text.includes("regression") ||
    text.includes("smoke")
  const hasMissionTestingSignal =
    validationText.includes("test") ||
    validationText.includes("validate") ||
    validationText.includes("validation") ||
    validationText.includes("coverage") ||
    validationText.includes("integration") ||
    validationText.includes("e2e") ||
    validationText.includes("unit") ||
    validationText.includes("regression") ||
    validationText.includes("smoke")
  const hasMissionInferredTestingSignal = (text.includes("check") || text.includes("verify")) && hasMissionTestingSignal

  if (actionKind === "docs" || text.includes("docs") || text.includes("readme") || text.includes("documentation")) {
    return {
      role: "docs",
      source: actionKind === "docs" ? "todo_action" : "todo_content",
      todoID: input.todo.id,
      todoContent: input.todo.content,
    }
  }

  if (text.includes("review") || text.includes("audit") || text.includes("inspect")) {
    return {
      role: "review",
      source: "todo_content",
      todoID: input.todo.id,
      todoContent: input.todo.content,
    }
  }

  if (actionKind === "test" || hasTodoTestingSignal || hasMissionInferredTestingSignal) {
    return {
      role: "testing",
      source: actionKind === "test" ? "todo_action" : hasTodoTestingSignal ? "todo_content" : "mission_validation",
      todoID: input.todo.id,
      todoContent: input.todo.content,
    }
  }

  if (
    actionKind === "implement" ||
    actionKind === "delegate" ||
    text.includes("implement") ||
    text.includes("build") ||
    text.includes("fix") ||
    text.includes("refactor") ||
    text.includes("add ") ||
    text.includes("update ")
  ) {
    return {
      role: "coding",
      source: actionKind === "implement" || actionKind === "delegate" ? "todo_action" : "todo_content",
      todoID: input.todo.id,
      todoContent: input.todo.content,
    }
  }

  return {
    role: "generic",
    source: "generic",
    todoID: input.todo.id,
    todoContent: input.todo.content,
  }
}

export type MissionConsumptionResult =
  | {
      ok: true
      trace: MissionConsumptionTrace
    }
  | {
      ok: false
      issues: string[]
      consumedArtifacts: {
        implementationSpec: string
        tasks: string
        handoff: string
      }
    }

export async function consumeMissionArtifacts(mission: Session.Info["mission"]): Promise<MissionConsumptionResult> {
  if (!mission) {
    return {
      ok: false,
      issues: ["mission missing"],
      consumedArtifacts: {
        implementationSpec: "",
        tasks: "",
        handoff: "",
      },
    }
  }

  const issues: string[] = []
  const implementationSpec = await readRequiredArtifact(
    mission.artifactPaths.implementationSpec,
    "implementationSpec",
    issues,
  )
  const tasks = await readRequiredArtifact(mission.artifactPaths.tasks, "tasks", issues)
  const handoff = await readRequiredArtifact(mission.artifactPaths.handoff, "handoff", issues)

  const goal = extractSection(implementationSpec.text, "Goal")
  const scope = extractSection(implementationSpec.text, "Scope")
  const validation = extractSection(implementationSpec.text, "Validation")
  const stopGates = extractSection(implementationSpec.text, "Stop Gates")
  const checklistItems = extractChecklistItems(tasks.text, { includeChecked: true })
  const requiredReads = extractBulletItems(extractSection(handoff.text, "Required Reads"))
  const handoffStopGates = extractBulletItems(extractSection(handoff.text, "Stop Gates In Force"))

  if (mission.artifactIntegrity) {
    if (digest(implementationSpec.text) !== mission.artifactIntegrity.implementationSpec) {
      issues.push("spec_dirty: implementationSpec changed after approval")
    }
    // tasks.md is expected to change during execution (checkbox updates = progress).
    // Only implementationSpec and handoff integrity violations are real spec corruption.
    if (digest(handoff.text) !== mission.artifactIntegrity.handoff) {
      issues.push("spec_dirty: handoff changed after approval")
    }
  }

  if (!goal) issues.push("implementationSpec missing Goal section")
  if (!scope) issues.push("implementationSpec missing Scope section")
  if (!validation) issues.push("implementationSpec missing Validation section")
  if (!stopGates) issues.push("implementationSpec missing Stop Gates section")
  if (checklistItems.length === 0) issues.push("tasks missing checklist items")
  if (requiredReads.length === 0) issues.push("handoff missing Required Reads items")
  if (handoffStopGates.length === 0) issues.push("handoff missing Stop Gates In Force items")

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      consumedArtifacts: {
        implementationSpec: mission.artifactPaths.implementationSpec,
        tasks: mission.artifactPaths.tasks,
        handoff: mission.artifactPaths.handoff,
      },
    }
  }

  return {
    ok: true,
    trace: {
      source: mission.source,
      contract: mission.contract,
      planPath: mission.planPath,
      consumedArtifacts: {
        implementationSpec: mission.artifactPaths.implementationSpec,
        tasks: mission.artifactPaths.tasks,
        handoff: mission.artifactPaths.handoff,
      },
      goal,
      scopeSummary: scope
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(" | "),
      validationChecks: extractBulletItems(validation),
      executionChecklist: checklistItems,
      requiredReads,
      stopGates: handoffStopGates,
    },
  }
}
