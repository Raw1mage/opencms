import { Identifier } from "@/id/id"
import { Session } from "./index"
import { Todo } from "./todo"
import { MessageV2 } from "./message-v2"
import { Storage } from "@/storage/storage"
import z from "zod"
import { SessionStatus } from "./status"
import { Lock } from "@/util/lock"
import { Agent } from "@/agent/agent"
import { orchestrateModelSelection, shouldAutoSwitchMainModel } from "./model-orchestration"
import { Account } from "@/account"
import { isAuthError, isRateLimitError } from "@/account/rate-limit-judge"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { RuntimeEventService } from "@/system/runtime-event-service"
import {
  BETA_ADMISSION_FIELDS,
  consumeMissionArtifacts,
  evaluateBetaAdmissionAnswers,
  resolveBetaAdmissionAuthority,
} from "./mission-consumption"
import { debugCheckpoint } from "@/util/debug"
import { Log } from "@/util/log"

const log = Log.create({ service: "workflow-runner" })
import RUNNER_CONTRACT from "./prompt/runner.txt"
import {
  type RunTrigger,
  type TriggerGateResult,
  evaluateGates,
  buildContinuationTrigger,
  buildApiTrigger,
  CONTINUATION_GATE_POLICY,
  API_GATE_POLICY,
} from "./trigger"
import { RunQueue, type QueueEntry } from "./queue"
import { type Lane, LANES_BY_PRIORITY, LANE_CONFIGS } from "./lane-policy"
import { KillSwitchService } from "@/server/killswitch/service"

export const AUTONOMOUS_CONTINUE_TEXT =
  "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision."

export const AUTONOMOUS_PROGRESS_TEXT =
  "Continue the task already in progress. Finish or unblock it before starting new work, unless reprioritization is clearly necessary."

function applyRunnerContract(text: string) {
  return `${RUNNER_CONTRACT.trim()}\n\n${text}`
}

function buildBetaAdmissionPrompt(session: Pick<Session.Info, "mission">) {
  const authority = resolveBetaAdmissionAuthority(session.mission)
  return applyRunnerContract(
    [
      "Beta build admission quiz: restate the authoritative execution metadata exactly before continuing.",
      "Answer these fields exactly and machine-checkably:",
      ...BETA_ADMISSION_FIELDS.map((field) => `- ${field}: ${authority[field]}`),
    ].join("\n"),
  )
}

function applyBetaWorkflowContract(input: { text: string; session: Pick<Session.Info, "mission"> }) {
  const mission = input.session.mission as (Session.Info["mission"] & { beta?: unknown }) | undefined
  if (!mission?.beta) return applyRunnerContract(input.text)
  if (mission.admission?.betaQuiz?.status !== "passed") return buildBetaAdmissionPrompt(input.session)
  return applyRunnerContract(
    [
      'FIRST: Load skill "beta-workflow" before continuing beta-enabled build execution.',
      "Use the admitted beta execution context for implementation work.",
      input.text,
    ].join("\n\n"),
  )
}

/**
 * Plan-trusting mode: when a session has a fully approved mission
 * (openspec_compiled_plan + implementation_spec + executionReady),
 * the runner should trust the plan and not stop for advisory reasons.
 */
export function isPlanTrusting(mission: Session.Info["mission"]): boolean {
  return (
    !!mission &&
    mission.source === "openspec_compiled_plan" &&
    mission.contract === "implementation_spec" &&
    mission.executionReady === true
  )
}

/**
 * Stage 5 — Tight loop drain mode.
 * Lowered threshold: autonomous + executionReady + hasPendingTodos.
 * Does NOT require openspec_compiled_plan or implementation_spec contract.
 */
export function isPlanTrustingTight(session: Pick<Session.Info, "workflow" | "mission">): boolean {
  return (
    // autonomous is always-on
    !!session.mission?.executionReady && true // hasPendingTodos checked separately via getNextActionableTodo
  )
}

export type HardBlocker = "abort_signal" | "kill_switch_active" | "user_message_pending"

/**
 * Stage 5 — Hard blocker check for drain-on-stop.
 * Only factual checks, no decisions. Returns the blocker reason or null.
 *
 * User message preemption is handled by the while(true) loop itself:
 * new user message → loop re-reads messages → lastUser.id > lastAssistant.id → natural flow.
 */
export async function checkHardBlockers(sessionID: string, abort: AbortSignal): Promise<HardBlocker | null> {
  if (abort.aborted) return "abort_signal"

  // Kill-switch: check if globally active
  const ksState = await KillSwitchService.getState().catch(() => undefined)
  if (ksState?.active) return "kill_switch_active"

  return null
}

function buildMissionMetadata(session: Pick<Session.Info, "mission">) {
  const mission = session.mission
  if (!mission) return undefined
  return {
    source: mission.source,
    contract: mission.contract,
    approvedAt: mission.approvedAt,
    executionReady: mission.executionReady,
    planPath: mission.planPath,
    artifactPaths: mission.artifactPaths,
    beta: mission.beta,
    admission: mission.admission,
  }
}

export async function recordBetaAdmissionResult(input: {
  sessionID: string
  answers: Partial<Record<(typeof BETA_ADMISSION_FIELDS)[number], string>>
}) {
  const session = await Session.get(input.sessionID)
  if (!session.mission?.beta) return { ok: true as const, mismatches: [] }
  const authority = resolveBetaAdmissionAuthority(session.mission)
  const result = evaluateBetaAdmissionAnswers({ authority, answers: input.answers })
  await Session.update(
    input.sessionID,
    (draft) => {
      if (!draft.mission) return
      draft.mission.admission ??= {}
      draft.mission.admission.betaQuiz = {
        status: result.ok ? "passed" : "failed",
        reflectionUsed: draft.mission.admission.betaQuiz?.reflectionUsed ?? false,
        passedAt: result.ok ? Date.now() : draft.mission.admission.betaQuiz?.passedAt,
        mismatchCount: result.mismatches.length,
        lastMismatches: result.mismatches,
      }
    },
    { touch: false },
  )
  return result
}

export type ContinuationDecisionReason =
  | "subagent_session"
  | "autonomous_disabled"
  | "mission_not_approved"
  | "mission_not_consumable"
  | "spec_dirty"
  | "replan_required"
  | "blocked"
  | "max_continuous_rounds"
  | "todo_complete"
  | "wait_subagent"
  | "approval_needed"
  | "product_decision_needed"
  | "todo_in_progress"
  | "todo_pending"

export type ApprovalGate = "push" | "destructive" | "architecture_change"

export type AutonomousNextAction =
  | { type: "stop"; reason: Exclude<ContinuationDecisionReason, "todo_pending" | "todo_in_progress"> }
  | {
      type: "continue"
      reason: "todo_pending" | "todo_in_progress"
      text: string
      todo: Todo.Info
    }

export type AutonomousNarration = {
  kind: "continue" | "pause" | "complete"
  text: string
}

export type AutonomousWorkflowHealth = {
  state: Session.WorkflowState
  stopReason?: string
  queue: {
    hasPendingContinuation: boolean
    roundCount?: number
    reason?: PendingContinuationInfo["reason"]
    queuedAt?: number
  }
  supervisor: {
    leaseOwner?: string
    leaseExpiresAt?: number
    retryAt?: number
    consecutiveResumeFailures: number
    lastResumeCategory?: string
    lastResumeError?: string
  }
  anomalies: {
    recentCount: number
    latestEventType?: string
    latestAt?: number
    flags: string[]
    countsByType: Record<string, number>
  }
  summary: {
    health: "healthy" | "queued" | "paused" | "degraded" | "blocked" | "completed"
    label: string
  }
}

export type PendingContinuationResumeBlockReason =
  | "no_pending_continuation"
  | "in_flight"
  | "status_busy"
  | "status_retry"
  | "autonomous_disabled"
  | "workflow_blocked"
  | "workflow_completed"
  | `waiting_user_non_resumable:${string}`
  | "supervisor_retry_backoff"
  | "supervisor_foreign_lease"

export type PendingContinuationQueueInspection = {
  hasPendingContinuation: boolean
  pending?: PendingContinuationInfo
  status: SessionStatus.Info["type"]
  inFlight: boolean
  resumable: boolean
  blockedReasons: PendingContinuationResumeBlockReason[]
  health: AutonomousWorkflowHealth
}

export type PendingContinuationQueueControlAction = "resume_once" | "drop_pending"

export type PendingContinuationQueueControlResult = {
  action: PendingContinuationQueueControlAction
  applied: boolean
  reason: "resumed" | "dropped" | "no_pending_continuation" | "not_resumable" | "resume_dispatch_skipped"
  blockedReasons?: PendingContinuationResumeBlockReason[]
  inspection: PendingContinuationQueueInspection
}

export function summarizeAutonomousWorkflowHealth(input: {
  workflow?: Session.WorkflowInfo
  pending?: PendingContinuationInfo
  events?: RuntimeEventService.Event[]
}): AutonomousWorkflowHealth {
  const workflow = input.workflow ?? Session.defaultWorkflow()
  const events = input.events ?? []
  const anomalyEvents = events.filter((event) => event.domain === "anomaly")
  const countsByType = Object.fromEntries(
    anomalyEvents
      .reduce((map, event) => {
        map.set(event.eventType, (map.get(event.eventType) ?? 0) + 1)
        return map
      }, new Map<string, number>())
      .entries(),
  )
  const latestAnomaly = anomalyEvents.at(-1)
  const queue = {
    hasPendingContinuation: !!input.pending,
    roundCount: input.pending?.roundCount,
    reason: input.pending?.reason,
    queuedAt: input.pending?.createdAt,
  }
  const supervisor = {
    leaseOwner: workflow.supervisor?.leaseOwner,
    leaseExpiresAt: workflow.supervisor?.leaseExpiresAt,
    retryAt: workflow.supervisor?.retryAt,
    consecutiveResumeFailures: workflow.supervisor?.consecutiveResumeFailures ?? 0,
    lastResumeCategory: workflow.supervisor?.lastResumeCategory,
    lastResumeError: workflow.supervisor?.lastResumeError,
  }

  let health: AutonomousWorkflowHealth["summary"]["health"] = "healthy"
  let label = "Autonomous runner idle"
  if (workflow.state === "completed") {
    health = "completed"
    label = "Autonomous workflow completed"
  } else if (workflow.state === "blocked") {
    health = "blocked"
    label = workflow.stopReason ? `Workflow blocked: ${workflow.stopReason}` : "Workflow blocked"
  } else if (queue.hasPendingContinuation) {
    health = "queued"
    label = queue.reason === "todo_in_progress" ? "Queued to resume current step" : "Queued to start next step"
  } else if (workflow.state === "waiting_user") {
    health = "paused"
    label = workflow.stopReason ? `Waiting: ${workflow.stopReason}` : "Waiting for user"
  }
  if (health !== "blocked" && health !== "completed") {
    if (supervisor.consecutiveResumeFailures > 0 || anomalyEvents.length > 0) {
      health = "degraded"
      label = latestAnomaly?.eventType
        ? `Degraded: ${latestAnomaly.eventType}`
        : workflow.stopReason
          ? `Degraded: ${workflow.stopReason}`
          : "Degraded autonomous workflow health"
    }
  }

  return {
    state: workflow.state,
    stopReason: workflow.stopReason,
    queue,
    supervisor,
    anomalies: {
      recentCount: anomalyEvents.length,
      latestEventType: latestAnomaly?.eventType,
      latestAt: latestAnomaly?.ts,
      flags: [...new Set(anomalyEvents.flatMap((event) => event.anomalyFlags))],
      countsByType,
    },
    summary: {
      health,
      label,
    },
  }
}

export async function getAutonomousWorkflowHealth(sessionID: string, input?: { eventLimit?: number }) {
  const session = await Session.get(sessionID)
  const [pending, events] = await Promise.all([
    getPendingContinuation(sessionID),
    RuntimeEventService.list(sessionID, { limit: input?.eventLimit ?? 20 }),
  ])
  return summarizeAutonomousWorkflowHealth({
    workflow: session.workflow,
    pending,
    events,
  })
}

export function detectWaitSubagentMismatch(input: {
  todos: Todo.Info[]
  activeSubtasks?: number
  decision: { continue: boolean; reason: ContinuationDecisionReason }
}) {
  if (input.decision.reason !== "wait_subagent") return undefined
  if ((input.activeSubtasks ?? 0) > 0) return undefined
  const waitingTodos = actionableTodos(input.todos).filter(
    (todo) => todo.action?.waitingOn === "subagent" || todo.action?.kind === "wait",
  )
  if (!waitingTodos.length) return undefined
  return {
    anomalyCode: "unreconciled_wait_subagent",
    waitingTodoIDs: waitingTodos.map((todo) => todo.id),
    waitingTodoContents: waitingTodos.map((todo) => todo.content),
    activeSubtasks: input.activeSubtasks ?? 0,
  }
}

function actionableTodos(todos: Todo.Info[]) {
  return todos.filter((todo) => {
    if (todo.status === "in_progress") return true
    if (todo.status !== "pending") return false
    return Todo.isDependencyReady(todo, todos)
  })
}

function detectStructuredStopReason(
  todos: Todo.Info[],
): Extract<ContinuationDecisionReason, "approval_needed" | "product_decision_needed" | "wait_subagent"> | undefined {
  const actionable = actionableTodos(todos)
  if (
    actionable.some(
      (todo) => todo.action?.waitingOn === "approval" || todo.action?.kind === "approval" || todo.action?.needsApproval,
    )
  ) {
    return "approval_needed"
  }
  if (actionable.some((todo) => todo.action?.waitingOn === "decision" || todo.action?.kind === "decision")) {
    return "product_decision_needed"
  }
  if (actionable.some((todo) => todo.action?.waitingOn === "subagent" || todo.action?.kind === "wait")) {
    return "wait_subagent"
  }
}

function detectStructuredApprovalGate(todos: Todo.Info[]): ApprovalGate | undefined {
  const actionable = actionableTodos(todos)
  if (actionable.some((todo) => todo.action?.kind === "push")) return "push"
  if (actionable.some((todo) => todo.action?.kind === "destructive")) return "destructive"
  if (actionable.some((todo) => todo.action?.kind === "architecture_change")) return "architecture_change"
}

function normalizeApprovalGates(gates?: string[]) {
  return new Set(
    (gates ?? []).filter((gate): gate is ApprovalGate => ["push", "destructive", "architecture_change"].includes(gate)),
  )
}

export function detectApprovalRequiredForTodos(input: { gates?: string[]; todos: Todo.Info[] }) {
  const required = normalizeApprovalGates(input.gates)
  if (required.size === 0) return undefined
  const structured = detectStructuredApprovalGate(input.todos)
  if (structured && required.has(structured)) return structured
  const actionable = actionableTodos(input.todos)
  const text = actionable.map((todo) => todo.content.toLowerCase()).join("\n")

  if (
    required.has("push") &&
    (text.includes("push") || text.includes("deploy") || text.includes("release") || text.includes("publish"))
  ) {
    return "push" as const
  }
  if (
    required.has("destructive") &&
    (text.includes("delete") ||
      text.includes("remove") ||
      text.includes("drop ") ||
      text.includes("reset") ||
      text.includes("destroy"))
  ) {
    return "destructive" as const
  }
  if (
    required.has("architecture_change") &&
    (text.includes("architecture") ||
      text.includes("refactor") ||
      text.includes("schema") ||
      text.includes("migration") ||
      text.includes("breaking change"))
  ) {
    return "architecture_change" as const
  }
}

export const PendingContinuationInfo = z.object({
  sessionID: Identifier.schema("session"),
  messageID: Identifier.schema("message"),
  createdAt: z.number(),
  roundCount: z.number(),
  reason: z.enum(["todo_pending", "todo_in_progress"]),
  text: z.string(),
})
export type PendingContinuationInfo = z.infer<typeof PendingContinuationInfo>

const RESUME_LOCK = "session.workflow.resume"
const LEASE_MS = 30_000
const MAX_RESUME_FAILURES = 3
const SUPERVISOR_OWNER = `supervisor:${process.pid}:${Date.now().toString(36)}`
const resumeInFlight = new Set<string>()
let supervisorStarted = false
let supervisorTimer: ReturnType<typeof setInterval> | undefined

type ResumeCandidate = {
  pending: PendingContinuationInfo
  session: Pick<Session.Info, "workflow" | "directory">
  status: SessionStatus.Info
  inFlight: boolean
  health?: AutonomousWorkflowHealth
  budget?: {
    family: string
    waitTimeMs: number
  }
}

const NON_RESUMABLE_WAITING_REASONS = new Set([
  "approval_needed",
  "product_decision_needed",
  "mission_not_approved",
  "mission_not_consumable",
  "max_continuous_rounds",
  "manual_interrupt",
  "risk_review_needed",
  // "wait_subagent" removed: subagent completion auto-resumes via
  // task-worker-continuation → RunQueue, so supervisor should not block.
])

function healthRankForResume(health: AutonomousWorkflowHealth["summary"]["health"]) {
  switch (health) {
    case "healthy":
      return 0
    case "queued":
      return 1
    case "paused":
      return 2
    case "degraded":
      return 3
    case "blocked":
      return 4
    case "completed":
      return 5
  }
}

export function shouldResumePendingContinuation(input: {
  session: Pick<Session.Info, "workflow">
  status: SessionStatus.Info
  inFlight: boolean
  health?: AutonomousWorkflowHealth
  owner?: string
  now?: number
}) {
  return inspectPendingContinuationResumability(input).resumable
}

export function inspectPendingContinuationResumability(input: {
  session: Pick<Session.Info, "workflow">
  status: SessionStatus.Info
  inFlight: boolean
  health?: AutonomousWorkflowHealth
  owner?: string
  now?: number
}) {
  const blockedReasons: PendingContinuationResumeBlockReason[] = []
  if (input.inFlight) blockedReasons.push("in_flight")
  if (input.status.type === "busy") blockedReasons.push("status_busy")
  if (input.status.type === "retry") blockedReasons.push("status_retry")

  const workflow = input.session.workflow
  // autonomous is always-on — no enabled check

  const health = input.health ?? summarizeAutonomousWorkflowHealth({ workflow })
  if (health.state === "blocked") blockedReasons.push("workflow_blocked")
  if (health.state === "completed") blockedReasons.push("workflow_completed")
  if (health.state === "waiting_user" && NON_RESUMABLE_WAITING_REASONS.has(health.stopReason ?? "")) {
    blockedReasons.push(`waiting_user_non_resumable:${health.stopReason}`)
  }

  const now = input.now ?? Date.now()
  const supervisor = health.supervisor
  if ((supervisor.retryAt ?? 0) > now) blockedReasons.push("supervisor_retry_backoff")
  if ((supervisor.leaseExpiresAt ?? 0) > now && supervisor.leaseOwner && supervisor.leaseOwner !== input.owner) {
    blockedReasons.push("supervisor_foreign_lease")
  }

  return {
    resumable: blockedReasons.length === 0,
    blockedReasons,
    health,
  }
}

export function computeResumeBackoffMs(consecutiveFailures: number) {
  const step = Math.max(1, consecutiveFailures)
  return Math.min(5 * 60_000, 15_000 * 2 ** (step - 1))
}

export function computeResumeRetryAt(input: {
  now: number
  consecutiveFailures: number
  category: ResumeFailureCategory
  budgetWaitTimeMs?: number
}) {
  const backoffMs = computeResumeBackoffMs(input.consecutiveFailures)
  const effectiveWaitMs =
    input.category === "provider_rate_limit" ? Math.max(backoffMs, input.budgetWaitTimeMs ?? 0) : backoffMs
  return input.now + effectiveWaitMs
}

function shouldBlockAfterResumeFailure(consecutiveFailures: number) {
  return consecutiveFailures >= MAX_RESUME_FAILURES
}

export type ResumeFailureCategory =
  | "provider_rate_limit"
  | "provider_auth"
  | "provider_transient"
  | "tool_runtime"
  | "session_state"
  | "unknown"

export function classifyResumeFailure(error: unknown): {
  category: ResumeFailureCategory
  shouldRetry: boolean
  shouldBlockImmediately: boolean
  reason: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (error instanceof PermissionNext.RejectedError || error instanceof PermissionNext.DeniedError) {
    return {
      category: "tool_runtime",
      shouldRetry: false,
      shouldBlockImmediately: true,
      reason: `approval_needed:${message}`,
    }
  }
  if (error instanceof PermissionNext.CorrectedError || error instanceof Question.RejectedError) {
    return {
      category: "tool_runtime",
      shouldRetry: false,
      shouldBlockImmediately: true,
      reason: `product_decision_needed:${message}`,
    }
  }
  if (normalized.includes("approval_needed:")) {
    return {
      category: "tool_runtime",
      shouldRetry: false,
      shouldBlockImmediately: true,
      reason: message,
    }
  }
  if (normalized.includes("product_decision_needed:")) {
    return {
      category: "tool_runtime",
      shouldRetry: false,
      shouldBlockImmediately: true,
      reason: message,
    }
  }

  if (isRateLimitError(error)) {
    return {
      category: "provider_rate_limit",
      shouldRetry: true,
      shouldBlockImmediately: false,
      reason: message,
    }
  }
  if (isAuthError(error)) {
    return {
      category: "provider_auth",
      shouldRetry: false,
      shouldBlockImmediately: true,
      reason: message,
    }
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("tool execution failed") ||
    normalized.includes("command not found")
  ) {
    return {
      category: "tool_runtime",
      shouldRetry: false,
      shouldBlockImmediately: true,
      reason: message,
    }
  }
  if (normalized.includes("no user message found") || normalized.includes("impossible")) {
    return {
      category: "session_state",
      shouldRetry: false,
      shouldBlockImmediately: true,
      reason: message,
    }
  }
  if (
    normalized.includes("timeout") ||
    normalized.includes("temporar") ||
    normalized.includes("network") ||
    normalized.includes("econn") ||
    normalized.includes("503") ||
    normalized.includes("502")
  ) {
    return {
      category: "provider_transient",
      shouldRetry: true,
      shouldBlockImmediately: false,
      reason: message,
    }
  }
  return {
    category: "unknown",
    shouldRetry: true,
    shouldBlockImmediately: false,
    reason: message,
  }
}

export function pickPendingContinuationsForResume(input: {
  items: ResumeCandidate[]
  maxCount: number
  preferredSessionID?: string
}) {
  const eligible = input.items
    .filter((item) =>
      shouldResumePendingContinuation({
        session: item.session,
        status: item.status,
        inFlight: item.inFlight,
        health: item.health,
        owner: SUPERVISOR_OWNER,
      }),
    )
    .sort((a, b) => {
      const aHealthRank = healthRankForResume(a.health?.summary.health ?? "healthy")
      const bHealthRank = healthRankForResume(b.health?.summary.health ?? "healthy")
      if (aHealthRank !== bHealthRank) return aHealthRank - bHealthRank
      const aReady = (a.budget?.waitTimeMs ?? 0) === 0 ? 0 : 1
      const bReady = (b.budget?.waitTimeMs ?? 0) === 0 ? 0 : 1
      if (aReady !== bReady) return aReady - bReady
      const aWait = a.budget?.waitTimeMs ?? 0
      const bWait = b.budget?.waitTimeMs ?? 0
      if (aWait !== bWait) return aWait - bWait
      const aFailures = a.session.workflow?.supervisor?.consecutiveResumeFailures ?? 0
      const bFailures = b.session.workflow?.supervisor?.consecutiveResumeFailures ?? 0
      if (aFailures !== bFailures) return aFailures - bFailures
      const aRun = a.session.workflow?.lastRunAt ?? 0
      const bRun = b.session.workflow?.lastRunAt ?? 0
      if (aRun !== bRun) return aRun - bRun
      if (a.pending.createdAt !== b.pending.createdAt) return a.pending.createdAt - b.pending.createdAt
      return a.pending.sessionID.localeCompare(b.pending.sessionID)
    })

  const picked: ResumeCandidate[] = []
  const usedFamilies = new Set<string>()
  const maxCount = Math.max(0, input.maxCount)

  if (input.preferredSessionID) {
    const preferred = eligible.find((item) => item.pending.sessionID === input.preferredSessionID)
    if (preferred && picked.length < maxCount) {
      picked.push(preferred)
      const family = preferred.budget?.family
      if (family) usedFamilies.add(family)
    }
  }

  for (const item of eligible) {
    if (picked.length >= maxCount) break
    const family = item.budget?.family
    if (family && usedFamilies.has(family)) continue
    picked.push(item)
    if (family) usedFamilies.add(family)
  }

  for (const item of eligible) {
    if (picked.length >= maxCount) break
    if (picked.includes(item)) continue
    picked.push(item)
  }

  return picked
}

async function resolvePendingContinuationBudget(item: PendingContinuationInfo) {
  const message = await MessageV2.get({ sessionID: item.sessionID, messageID: item.messageID }).catch(() => undefined)
  if (!message || message.info.role !== "user") return undefined

  const textPart = message.parts.findLast((part) => part.type === "text")
  const selectedProviderId =
    textPart?.type === "text" ? (textPart.metadata?.modelArbitration as any)?.selected?.providerId : undefined
  const providerId = selectedProviderId ?? message.info.model.providerId
  const modelID =
    (textPart?.type === "text" ? (textPart.metadata?.modelArbitration as any)?.selected?.modelID : undefined) ??
    message.info.model.modelID
  const family = (await Account.resolveFamily(providerId)) ?? providerId
  const waitTimeMs = await Account.getMinWaitTime(family, modelID).catch(() => 0)
  return { family, waitTimeMs }
}

export function evaluateAutonomousContinuation(input: {
  session: Pick<Session.Info, "parentID" | "workflow" | "time" | "mission">
  todos: Todo.Info[]
  roundCount: number
  activeSubtasks?: number
  pendingApprovals?: number
  pendingQuestions?: number
}) {
  const next = planAutonomousNextAction(input)
  return next.type === "continue"
    ? { continue: true as const, reason: next.reason, text: next.text, todo: next.todo }
    : { continue: false as const, reason: next.reason }
}

/**
 * Plan the next autonomous action for a session.
 *
 * Internally delegates to the trigger system (Phase 5B):
 * 1. Build a continuation trigger from the next actionable todo
 * 2. Evaluate session-level gates via TriggerEvaluator
 * 3. Convert the result back to AutonomousNextAction format
 *
 * External signature and semantics are unchanged — all 14 ContinuationDecisionReasons
 * are preserved with identical evaluation order.
 */
export function planAutonomousNextAction(input: {
  session: Pick<Session.Info, "parentID" | "workflow" | "time" | "mission">
  todos: Todo.Info[]
  roundCount: number
  activeSubtasks?: number
  pendingApprovals?: number
  pendingQuestions?: number
}): AutonomousNextAction {
  // Build a continuation trigger from the next actionable todo
  const current = Todo.nextActionableTodo(input.todos)
  const trigger = buildContinuationTrigger({
    todo: current,
    textForPending: applyBetaWorkflowContract({ text: AUTONOMOUS_CONTINUE_TEXT, session: input.session }),
    textForInProgress: applyBetaWorkflowContract({ text: AUTONOMOUS_PROGRESS_TEXT, session: input.session }),
  })

  // If no actionable todo, we still need to run gates first (they may stop earlier)
  // Use a placeholder trigger for gate evaluation when no todo exists
  const triggerForGates: RunTrigger = trigger ?? {
    type: "continuation",
    source: "todo_pending",
    payload: { text: "", todo: { id: "", content: "", status: "pending", priority: "low" } as Todo.Info },
    priority: "normal",
    gatePolicy: CONTINUATION_GATE_POLICY,
  }

  const gateResult = evaluateGates({
    trigger: triggerForGates,
    session: input.session,
    todos: input.todos,
    roundCount: input.roundCount,
    activeSubtasks: input.activeSubtasks,
    pendingApprovals: input.pendingApprovals,
    pendingQuestions: input.pendingQuestions,
    isPlanTrusting: isPlanTrusting(input.session.mission),
    detectStructuredStopReason,
    detectApprovalGate: detectApprovalRequiredForTodos,
  })

  if (!gateResult.pass) {
    // Gate evaluator never produces "todo_pending" or "todo_in_progress" as stop reasons
    return {
      type: "stop",
      reason: gateResult.reason as Exclude<ContinuationDecisionReason, "todo_pending" | "todo_in_progress">,
    }
  }

  // Gates passed — check if we have a real todo to continue with
  if (!trigger) {
    return { type: "stop", reason: "todo_complete" }
  }

  return {
    type: "continue",
    reason: trigger.source,
    text: trigger.payload.text,
    todo: trigger.payload.todo,
  }
}

/**
 * Evaluate gates for an arbitrary RunTrigger.
 *
 * This is the generic entry point for non-continuation triggers (e.g. API triggers).
 * Continuation triggers should use planAutonomousNextAction() which wraps this.
 */
export function evaluateTriggerGates(input: {
  trigger: RunTrigger
  session: Pick<Session.Info, "parentID" | "workflow" | "time" | "mission">
  todos: Todo.Info[]
  roundCount: number
  activeSubtasks?: number
  pendingApprovals?: number
  pendingQuestions?: number
}): TriggerGateResult {
  return evaluateGates({
    trigger: input.trigger,
    session: input.session,
    todos: input.todos,
    roundCount: input.roundCount,
    activeSubtasks: input.activeSubtasks,
    pendingApprovals: input.pendingApprovals,
    pendingQuestions: input.pendingQuestions,
    isPlanTrusting: isPlanTrusting(input.session.mission),
    detectStructuredStopReason,
    detectApprovalGate: detectApprovalRequiredForTodos,
  })
}

export function describeAutonomousNextAction(action: AutonomousNextAction): AutonomousNarration {
  if (action.type === "continue") {
    return {
      kind: "continue",
      text:
        action.reason === "todo_in_progress"
          ? `Runner continuing current step: ${action.todo.content}`
          : `Runner starting next planned step: ${action.todo.content}`,
    }
  }

  switch (action.reason) {
    case "approval_needed":
      return { kind: "pause", text: "Paused: approval is required before the next gated step." }
    case "product_decision_needed":
      return {
        kind: "pause",
        text: "Paused: I need a product decision or beta admission correction before continuing.",
      }
    case "wait_subagent":
      return { kind: "pause", text: "Runner paused: a delegated subagent task is still running." }
    case "max_continuous_rounds":
      return {
        kind: "pause",
        text: "Paused: I hit the current autonomous round limit and am waiting for your next instruction.",
      }
    case "todo_complete":
      return { kind: "complete", text: "Runner complete: the current planned todo set is done." }
    case "blocked":
      return { kind: "pause", text: "Paused: the workflow is currently blocked." }
    case "mission_not_approved":
      return {
        kind: "pause",
        text: "Paused: autonomous runner requires an approved OpenSpec mission contract before continuing.",
      }
    case "mission_not_consumable":
      return {
        kind: "pause",
        text: "Paused: approved mission artifacts could not be consumed safely, so autonomous execution stopped.",
      }
    case "spec_dirty":
      return {
        kind: "pause",
        text: "Paused: approved planner artifacts changed after approval. Re-enter plan mode before continuing.",
      }
    case "replan_required":
      return {
        kind: "pause",
        text: "Paused: execution now requires a planner re-entry before autonomous continuation can proceed.",
      }
    case "autonomous_disabled":
      return { kind: "pause", text: "Autonomous continuation is disabled, so I am waiting for your next instruction." }
    case "subagent_session":
      return { kind: "pause", text: "Autonomous continuation only runs for root sessions." }
  }
}

export function shouldInterruptAutonomousRun(input: {
  session: Pick<Session.Info, "parentID" | "workflow">
  status: SessionStatus.Info
  lastUserSynthetic: boolean
  hasPendingContinuation: boolean
}) {
  if (input.status.type !== "busy") return false
  if (input.session.parentID) return false
  // autonomous is always-on
  return input.lastUserSynthetic || input.hasPendingContinuation
}

export async function decideAutonomousContinuation(input: { sessionID: string; roundCount: number }) {
  const session = await Session.get(input.sessionID)
  const todos = await Todo.get(input.sessionID)
  const activeSubtasks = await countActiveSubtasks(input.sessionID)
  const [pendingApprovals, pendingQuestions] = await Promise.all([
    countPendingApprovals(input.sessionID),
    countPendingQuestions(input.sessionID),
  ])
  const decision = evaluateAutonomousContinuation({
    session,
    todos,
    roundCount: input.roundCount,
    activeSubtasks,
    pendingApprovals,
    pendingQuestions,
  })
  debugCheckpoint("workflow", "continuation_decision", {
    sessionID: input.sessionID,
    continue: decision.continue,
    reason: decision.reason,
    roundCount: input.roundCount,
    todosTotal: todos.length,
    todosPending: todos.filter((t) => t.status === "pending").length,
    todosInProgress: todos.filter((t) => t.status === "in_progress").length,
    todosCompleted: todos.filter((t) => t.status === "completed").length,
    activeSubtasks,
    pendingApprovals,
    pendingQuestions,
    workflowState: session.workflow?.state,
    missionExists: !!session.mission,
    missionReady: session.mission?.executionReady,
  })
  // Race condition guard: if the gate says "stop" but a task completion
  // continuation was enqueued while we were busy (e.g. answering a question),
  // override the decision to continue so we don't miss the subagent's report.
  // The synthetic completion message is already persisted in the session;
  // we just need to keep the loop alive so the LLM processes it.
  if (!decision.continue) {
    const pendingEntry = await RunQueue.peek(input.sessionID)
    if (
      pendingEntry &&
      (pendingEntry.triggerType === "task_completion" || pendingEntry.triggerType === "task_failure")
    ) {
      // Consume the queue entry so the supervisor doesn't double-resume
      await RunQueue.remove(input.sessionID)
      return {
        continue: true as const,
        reason: "todo_pending" as const,
        text: pendingEntry.text,
        todo: todos.find((t) => t.status === "pending" || t.status === "in_progress"),
      }
    }
  }
  if (decision.continue && session.mission) {
    const missionConsumption = await consumeMissionArtifacts(session.mission)
    if (!missionConsumption.ok) {
      const specDirty = missionConsumption.issues.some((issue) => issue.startsWith("spec_dirty:"))
      await RuntimeEventService.append({
        sessionID: input.sessionID,
        level: "warn",
        domain: "anomaly",
        eventType: specDirty ? "workflow.spec_dirty" : "workflow.mission_not_consumable",
        anomalyFlags: [specDirty ? "spec_dirty" : "mission_not_consumable"],
        payload: {
          issues: missionConsumption.issues,
          consumedArtifacts: missionConsumption.consumedArtifacts,
        },
      }).catch(() => undefined)
      return {
        continue: false as const,
        reason: specDirty ? ("spec_dirty" as const) : ("mission_not_consumable" as const),
      }
    }
  }
  const mismatch = detectWaitSubagentMismatch({
    todos,
    activeSubtasks,
    decision: {
      continue: decision.continue,
      reason: decision.reason,
    },
  })
  if (mismatch) {
    await RuntimeEventService.append({
      sessionID: input.sessionID,
      level: "warn",
      domain: "anomaly",
      eventType: "workflow.unreconciled_wait_subagent",
      todoID: mismatch.waitingTodoIDs[0],
      anomalyFlags: [mismatch.anomalyCode],
      payload: mismatch,
    }).catch(() => undefined)
  }
  return decision
}

async function countPendingApprovals(sessionID: string) {
  return (await PermissionNext.list()).filter((item) => item.sessionID === sessionID).length
}

async function countPendingQuestions(sessionID: string) {
  return (await Question.list()).filter((item) => item.sessionID === sessionID).length
}

async function countActiveSubtasks(sessionID: string) {
  let active = 0
  for await (const message of MessageV2.stream(sessionID)) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "task") continue
      if (part.state.status === "pending" || part.state.status === "running") active++
    }
  }
  return active
}

function queueKey(sessionID: string) {
  return ["session_workflow_queue", sessionID]
}

export async function getPendingContinuation(sessionID: string) {
  return Storage.read<PendingContinuationInfo>(queueKey(sessionID)).catch(() => undefined)
}

export async function clearPendingContinuation(sessionID: string) {
  // Clear from both RunQueue (all lanes) and legacy key
  await RunQueue.remove(sessionID)
}

export async function listPendingContinuations() {
  // Read from RunQueue (lane-aware) with legacy fallback
  const queueEntries = await RunQueue.listAll()
  if (queueEntries.length > 0) {
    return queueEntries.map(
      (entry): PendingContinuationInfo => ({
        sessionID: entry.sessionID,
        messageID: entry.messageID,
        createdAt: entry.createdAt,
        roundCount: entry.roundCount,
        reason: entry.reason,
        text: entry.text,
      }),
    )
  }
  // Legacy fallback: read from old storage keys
  const result: PendingContinuationInfo[] = []
  for (const item of await Storage.list(["session_workflow_queue"]).catch(() => [])) {
    const entry = await Storage.read<PendingContinuationInfo>(item).catch(() => undefined)
    if (entry) result.push(entry)
  }
  return result.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getPendingContinuationQueueInspection(
  sessionID: string,
): Promise<PendingContinuationQueueInspection> {
  const session = await Session.get(sessionID)
  const pending = await getPendingContinuation(sessionID)
  const status = SessionStatus.get(sessionID)
  const inFlight = resumeInFlight.has(sessionID)
  const events = await RuntimeEventService.list(sessionID, { limit: 20 }).catch(() => [])
  const health = summarizeAutonomousWorkflowHealth({
    workflow: session.workflow,
    pending,
    events,
  })

  if (!pending) {
    return {
      hasPendingContinuation: false,
      status: status.type,
      inFlight,
      resumable: false,
      blockedReasons: ["no_pending_continuation"],
      health,
    }
  }

  const resumability = inspectPendingContinuationResumability({
    session,
    status,
    inFlight,
    health,
    owner: SUPERVISOR_OWNER,
  })

  return {
    hasPendingContinuation: true,
    pending,
    status: status.type,
    inFlight,
    resumable: resumability.resumable,
    blockedReasons: resumability.blockedReasons,
    health: resumability.health,
  }
}

export async function mutatePendingContinuationQueue(input: {
  sessionID: string
  action: PendingContinuationQueueControlAction
}): Promise<PendingContinuationQueueControlResult> {
  if (input.action === "drop_pending") {
    const pending = await getPendingContinuation(input.sessionID)
    if (!pending) {
      return {
        action: input.action,
        applied: false,
        reason: "no_pending_continuation",
        inspection: await getPendingContinuationQueueInspection(input.sessionID),
      }
    }
    await clearPendingContinuation(input.sessionID)
    await RuntimeEventService.append({
      sessionID: input.sessionID,
      level: "info",
      domain: "workflow",
      eventType: "workflow.pending_continuation_dropped",
      anomalyFlags: [],
      payload: {
        source: "operator_control",
      },
    }).catch(() => undefined)
    return {
      action: input.action,
      applied: true,
      reason: "dropped",
      inspection: await getPendingContinuationQueueInspection(input.sessionID),
    }
  }

  const inspection = await getPendingContinuationQueueInspection(input.sessionID)
  if (!inspection.hasPendingContinuation) {
    return {
      action: input.action,
      applied: false,
      reason: "no_pending_continuation",
      inspection,
    }
  }
  if (!inspection.resumable) {
    return {
      action: input.action,
      applied: false,
      reason: "not_resumable",
      blockedReasons: inspection.blockedReasons,
      inspection,
    }
  }

  await resumePendingContinuations({
    maxCount: 1,
    preferredSessionID: input.sessionID,
  })
  const after = await getPendingContinuationQueueInspection(input.sessionID)
  const resumed = after.inFlight || after.status === "busy"
  await RuntimeEventService.append({
    sessionID: input.sessionID,
    level: resumed ? "info" : "warn",
    domain: resumed ? "workflow" : "anomaly",
    eventType: resumed
      ? "workflow.pending_continuation_resume_requested"
      : "workflow.pending_continuation_resume_dispatch_skipped",
    anomalyFlags: resumed ? [] : ["pending_continuation_resume_dispatch_skipped"],
    payload: {
      source: "operator_control",
      blockedReasons: resumed ? undefined : after.blockedReasons,
    },
  }).catch(() => undefined)
  return {
    action: input.action,
    applied: resumed,
    reason: resumed ? "resumed" : "resume_dispatch_skipped",
    blockedReasons: resumed ? undefined : after.blockedReasons,
    inspection: after,
  }
}

export async function enqueuePendingContinuation(
  input: PendingContinuationInfo & { triggerType?: string; priority?: "critical" | "normal" | "background" },
) {
  const validated = PendingContinuationInfo.parse(input)
  // Write to RunQueue (lane-aware) + legacy key (backward compat handled inside RunQueue)
  await RunQueue.enqueue({
    sessionID: validated.sessionID,
    messageID: validated.messageID,
    createdAt: validated.createdAt,
    roundCount: validated.roundCount,
    reason: validated.reason,
    text: validated.text,
    triggerType: input.triggerType ?? "continuation",
    priority: input.priority ?? "normal",
  })
}

export async function resumePendingContinuations(input?: { maxCount?: number; preferredSessionID?: string }) {
  using _lock = await Lock.write(RESUME_LOCK)

  log.info("resumePendingContinuations: start", { maxCount: input?.maxCount, preferredSessionID: input?.preferredSessionID })

  // Kill-switch gate: if active, skip all resume attempts (Slice 3: kill-switch blocks dequeue)
  const { KillSwitchService } = await import("@/server/killswitch/service")
  const globalGate = await KillSwitchService.assertSchedulingAllowed()
  if (!globalGate.ok) {
    log.info("resumePendingContinuations: blocked by kill-switch")
    return
  }

  const items = await listPendingContinuations()
  log.info("resumePendingContinuations: pending items", { count: items.length, sessionIDs: items.map((i) => i.sessionID) })
  const resumable: ResumeCandidate[] = []
  for (const item of items) {
    const inFlight = resumeInFlight.has(item.sessionID)
    if (inFlight) {
      log.info("resumePendingContinuations: skipping in-flight", { sessionID: item.sessionID })
      continue
    }
    const session = await Session.get(item.sessionID).catch(() => undefined)
    if (!session) {
      await clearPendingContinuation(item.sessionID)
      continue
    }

    // Workspace-scoped kill-switch: check per-session workspace
    const workspaceId = await resolveWorkspaceIdForSession(session)
    if (workspaceId) {
      const wsGate = await KillSwitchService.assertSchedulingAllowed(workspaceId)
      if (!wsGate.ok) continue
    }

    resumable.push({
      pending: item,
      session,
      status: SessionStatus.get(item.sessionID),
      inFlight,
      health: summarizeAutonomousWorkflowHealth({
        workflow: session.workflow,
        pending: item,
        events: await RuntimeEventService.list(item.sessionID, { limit: 10 }).catch(() => []),
      }),
      budget: await resolvePendingContinuationBudget(item),
    })
  }

  const maxCount = input?.maxCount ?? 1
  log.info("resumePendingContinuations: resumable", { count: resumable.length, sessionIDs: resumable.map((r) => r.pending.sessionID) })
  const selected = pickPendingContinuationsForResume({
    items: resumable,
    maxCount,
    preferredSessionID: input?.preferredSessionID,
  })
  log.info("resumePendingContinuations: selected", { count: selected.length, sessionIDs: selected.map((s) => s.pending.sessionID) })

  for (const item of selected) {
    const sessionID = item.pending.sessionID
    resumeInFlight.add(sessionID)
    await Session.setWorkflowState({
      sessionID,
      state: "running",
      stopReason: undefined,
      lastRunAt: Date.now(),
    }).catch(() => undefined)
    await Session.updateWorkflowSupervisor({
      sessionID,
      patch: {
        leaseOwner: SUPERVISOR_OWNER,
        leaseExpiresAt: Date.now() + LEASE_MS,
      },
      clear: ["retryAt", "lastResumeError"],
    }).catch(() => undefined)

    // Resolve workspace and route through workspace command lane
    const workspaceId = await resolveWorkspaceIdForSession(item.session)
    void executeResumeInLane(sessionID, workspaceId, item)
  }
}

/**
 * Resolve workspaceId from a session's directory.
 * Returns undefined if resolution fails (graceful degradation to default workspace).
 */
async function resolveWorkspaceIdForSession(session: Pick<Session.Info, "directory">): Promise<string | undefined> {
  try {
    const { resolveWorkspace } = await import("@/project/workspace/resolver")
    const ws = await resolveWorkspace({ directory: session.directory })
    return ws.workspaceId
  } catch {
    return undefined
  }
}

/**
 * Execute a resume through the workspace's command lane for concurrency control.
 * Falls back to direct execution if lane routing fails.
 */
async function executeResumeInLane(sessionID: string, workspaceId: string | undefined, item: ResumeCandidate) {
  const doResume = async () => {
    try {
      const { SessionPrompt } = await import("./prompt")
      await SessionPrompt.loop(sessionID)
      await Session.updateWorkflowSupervisor({
        sessionID,
        patch: {
          consecutiveResumeFailures: 0,
        },
        clear: ["leaseOwner", "leaseExpiresAt", "retryAt", "lastResumeError"],
      }).catch(() => undefined)
    } catch (error) {
      const current = await Session.get(sessionID).catch(() => undefined)
      const nextFailures = (current?.workflow?.supervisor?.consecutiveResumeFailures ?? 0) + 1
      const classified = classifyResumeFailure(error)
      const retryAt = computeResumeRetryAt({
        now: Date.now(),
        consecutiveFailures: nextFailures,
        category: classified.category,
        budgetWaitTimeMs: item.budget?.waitTimeMs,
      })
      const blocked =
        classified.shouldBlockImmediately ||
        (!classified.shouldRetry && nextFailures >= 1) ||
        shouldBlockAfterResumeFailure(nextFailures)
      if (blocked) {
        await clearPendingContinuation(sessionID)
      } else {
        await enqueuePendingContinuation(item.pending).catch(() => undefined)
      }
      await Session.setWorkflowState({
        sessionID,
        state: blocked ? "blocked" : "waiting_user",
        stopReason: blocked
          ? `resume_blocked:${classified.category}:${classified.reason}`
          : `resume_retry_scheduled:${classified.category}:${classified.reason}`,
        lastRunAt: Date.now(),
      }).catch(() => undefined)
      await Session.updateWorkflowSupervisor({
        sessionID,
        patch: {
          consecutiveResumeFailures: nextFailures,
          retryAt: blocked ? undefined : retryAt,
          lastResumeCategory: classified.category,
          lastResumeError: classified.reason,
        },
        clear: blocked ? ["leaseOwner", "leaseExpiresAt", "retryAt"] : ["leaseOwner", "leaseExpiresAt"],
      }).catch(() => undefined)
    } finally {
      resumeInFlight.delete(sessionID)
    }
  }

  // Route through workspace command lane if available
  if (workspaceId) {
    try {
      const { Lanes } = await import("@/daemon/lanes")
      await Lanes.enqueue(Lanes.CommandLane.Main, doResume, workspaceId)
      return
    } catch {
      // Fallback: daemon not started or lane not registered — execute directly
    }
  }

  void doResume()
}

export function ensureAutonomousSupervisor(input?: { intervalMs?: number }) {
  if (supervisorStarted) return supervisorTimer
  supervisorStarted = true
  const intervalMs = input?.intervalMs ?? 5_000
  void resumePendingContinuations()
  supervisorTimer = setInterval(() => {
    void resumePendingContinuations()
  }, intervalMs)
  return supervisorTimer
}

export async function enqueueAutonomousContinue(input: {
  sessionID: string
  user: MessageV2.User
  text?: string
  roundCount?: number
  delegation?: {
    role: "coding" | "testing" | "docs" | "review" | "generic"
    source: "todo_action" | "todo_content" | "mission_validation" | "generic"
    todoID: string
    todoContent: string
  }
}) {
  const now = Date.now()
  const session = await Session.get(input.sessionID)
  const text =
    input.text ??
    (input.delegation && input.delegation.role !== "generic"
      ? applyBetaWorkflowContract({
          text: `Continue with the next planned ${input.delegation.role} step: ${input.delegation.todoContent}`,
          session,
        })
      : applyBetaWorkflowContract({ text: AUTONOMOUS_CONTINUE_TEXT, session }))
  const missionConsumption = session.mission ? await consumeMissionArtifacts(session.mission) : undefined
  if (session.mission && missionConsumption && !missionConsumption.ok) {
    throw new Error(`mission_not_consumable:${missionConsumption.issues.join("; ")}`)
  }
  const pinnedModel = session.execution
    ? {
        providerId: session.execution.providerId,
        modelID: session.execution.modelID,
        accountId: session.execution.accountId,
      }
    : input.user.model
  const messageID = Identifier.ascending("message")
  const textPart: MessageV2.TextPart = {
    id: Identifier.ascending("part"),
    messageID,
    sessionID: input.sessionID,
    type: "text",
    text,
    synthetic: true,
    time: {
      start: now,
      end: now,
    },
  }
  const arbitration = shouldAutoSwitchMainModel({
    session,
    lastUserParts: [textPart],
  })
    ? await orchestrateModelSelection({
        agentName: input.user.agent,
        agentModel: (await Agent.get(input.user.agent))?.model,
        fallbackModel: pinnedModel,
      })
    : {
        model: pinnedModel,
        trace: {
          agentName: input.user.agent,
          domain: "manual",
          selected: { ...pinnedModel, source: "session_previous" },
          candidates: [{ ...pinnedModel, source: "session_previous", operational: true }],
        },
      }
  const nextModel = arbitration.model
  const message = await Session.updateMessage({
    id: messageID,
    role: "user",
    sessionID: input.sessionID,
    time: { created: now },
    agent: input.user.agent,
    model: nextModel,
    format: input.user.format,
    variant: input.user.variant,
  })
  await Session.updatePart({
    ...textPart,
    messageID: message.id,
    metadata: {
      modelArbitration: arbitration.trace,
      mission: buildMissionMetadata(session),
      missionConsumption: missionConsumption?.ok ? missionConsumption.trace : undefined,
      delegation: input.delegation,
    },
  })
  await enqueuePendingContinuation({
    sessionID: input.sessionID,
    messageID: message.id,
    createdAt: now,
    roundCount: input.roundCount ?? 0,
    reason: "todo_pending",
    text,
  })
  return message
}

// Re-export trigger types for consumers
export { type RunTrigger, type TriggerGateResult, type TriggerPriority, type TriggerGatePolicy } from "./trigger"
export { buildContinuationTrigger, buildApiTrigger, CONTINUATION_GATE_POLICY, API_GATE_POLICY } from "./trigger"

// Re-export queue and lane types for consumers
export { RunQueue, type QueueEntry } from "./queue"
export { type Lane, LANE_CONFIGS, LANES_BY_PRIORITY, triggerPriorityToLane, laneHasCapacity } from "./lane-policy"
