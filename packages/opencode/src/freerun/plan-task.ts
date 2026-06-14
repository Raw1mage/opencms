import type { ContextNode, GoalBinding } from "./types"

export interface PlanTaskCandidate {
  planSlug: string
  taskId: string
  taskText: string
  acceptanceCriteria: string[]
  lineNumber: number
}

export interface PlanTaskSeedInput {
  title: string
  body: string
  goalBinding: Extract<GoalBinding, { source: "plan-task" }>
}

export type PlanTaskCompletionGate =
  | { kind: "tick"; planSlug: string; taskId: string; validationEvidence: string[] }
  | { kind: "wait"; reason: "not-plan-task" | "root-not-done" | "missing-validation-evidence" }

export type PlanTaskStopGate =
  | { kind: "continue" }
  | { kind: "return-control"; stop: "blocked" | "decision" | "approval"; nodeId: string; message: string }

const TASK_LINE = /^(\s*)- \[ \]\s+(.+)$/
const CHECKBOX_LINE = /^(\s*)- \[[^\]]+\]\s+/
const TASK_ID = /^([A-Za-z]?\d+(?:\.\d+)*(?:[a-z])?)\s+(.+)$/

export function parsePlanTaskCandidates(input: { markdown: string; planSlug: string }): PlanTaskCandidate[] {
  const lines = input.markdown.split(/\r?\n/)
  const candidates: PlanTaskCandidate[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const match = TASK_LINE.exec(line)
    if (!match) continue

    const rawText = match[2].trim()
    const parsed = parseTaskText(rawText, index + 1)
    candidates.push({
      planSlug: input.planSlug,
      taskId: parsed.taskId,
      taskText: parsed.taskText,
      acceptanceCriteria: collectAcceptanceCriteria(lines, index + 1, match[1].length),
      lineNumber: index + 1,
    })
  }

  return candidates
}

export function selectPlanTaskCandidate(
  candidates: PlanTaskCandidate[],
  selector?: { taskId?: string; taskTextIncludes?: string },
): PlanTaskCandidate | undefined {
  if (!selector) return candidates[0]
  if (selector.taskId) return candidates.find((candidate) => candidate.taskId === selector.taskId)
  const needle = selector.taskTextIncludes?.trim().toLowerCase()
  if (!needle) return candidates[0]
  return candidates.find((candidate) => candidate.taskText.toLowerCase().includes(needle))
}

export function buildPlanTaskSeedInput(candidate: PlanTaskCandidate): PlanTaskSeedInput {
  const body = [`Plan task ${candidate.planSlug}#${candidate.taskId}`, candidate.taskText]
  if (candidate.acceptanceCriteria.length > 0) {
    body.push("", "Acceptance criteria:", ...candidate.acceptanceCriteria.map((criterion) => `- ${criterion}`))
  }
  return {
    title: `${candidate.taskId} ${candidate.taskText}`.slice(0, 120),
    body: body.join("\n"),
    goalBinding: {
      source: "plan-task",
      plan_slug: candidate.planSlug,
      task_id: candidate.taskId,
      task_text: candidate.taskText,
      acceptance_criteria: candidate.acceptanceCriteria,
    },
  }
}

export function evaluatePlanTaskCompletionGate(
  root: ContextNode,
  validationEvidence: string[],
): PlanTaskCompletionGate {
  if (root.goal_binding?.source !== "plan-task") return { kind: "wait", reason: "not-plan-task" }
  if (root.mode !== "done") return { kind: "wait", reason: "root-not-done" }
  const evidence = validationEvidence.map((item) => item.trim()).filter(Boolean)
  if (evidence.length === 0) return { kind: "wait", reason: "missing-validation-evidence" }
  return {
    kind: "tick",
    planSlug: root.goal_binding.plan_slug,
    taskId: root.goal_binding.task_id,
    validationEvidence: evidence,
  }
}

export function evaluatePlanTaskStopGate(root: ContextNode, nodes: ContextNode[]): PlanTaskStopGate {
  if (root.goal_binding?.source !== "plan-task") return { kind: "continue" }
  for (const node of nodes) {
    const stop = classifyStop(node)
    if (!stop) continue
    return { kind: "return-control", nodeId: node.id, ...stop }
  }
  return { kind: "continue" }
}

function parseTaskText(rawText: string, lineNumber: number) {
  const match = TASK_ID.exec(rawText)
  if (!match) return { taskId: `L${lineNumber}`, taskText: rawText }
  return { taskId: match[1], taskText: match[2] }
}

function collectAcceptanceCriteria(lines: string[], startIndex: number, taskIndent: number) {
  const criteria: string[] = []
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]
    const checkbox = CHECKBOX_LINE.exec(line)
    if (checkbox && checkbox[1].length <= taskIndent) break
    if (line.length - line.trimStart().length <= taskIndent) continue
    const bullet = /^\s+-\s+(.+)$/.exec(line)
    if (bullet) criteria.push(bullet[1].trim())
  }
  return criteria
}

function classifyStop(
  node: ContextNode,
): Pick<PlanTaskStopGate & { kind: "return-control" }, "stop" | "message"> | undefined {
  const blockerText = node.blockers.join("\n")
  if (/approval|approve|批准|核准/i.test(blockerText)) {
    return { stop: "approval", message: blockerText || "Approval required" }
  }
  if (/decision|decide|決策|決定/i.test(blockerText)) {
    return { stop: "decision", message: blockerText || "Decision required" }
  }
  if (node.mode === "blocked") return { stop: "blocked", message: blockerText || "Blocked" }
  return undefined
}
