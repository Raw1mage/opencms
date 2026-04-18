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
import { debugCheckpoint } from "@/util/debug"
import { Log } from "@/util/log"

const log = Log.create({ service: "workflow-runner" })
import RUNNER_CONTRACT from "./prompt/runner.txt"
import {
  type RunTrigger,
  buildContinuationTrigger,
  buildApiTrigger,
} from "./trigger"
import { RunQueue, type QueueEntry } from "./queue"
import { type Lane, LANES_BY_PRIORITY, LANE_CONFIGS } from "./lane-policy"
import { KillSwitchService } from "@/server/killswitch/service"

// Single continuation message sent on every autonomous pump.
// The if/else gate in runner.txt tells the AI when to continue vs silently
// end; per-scenario bodies (pending/in-progress/drain) were removed because
// the AI can already see todo state in its context.
export const RUNNER_CONTINUATION_TEXT = RUNNER_CONTRACT.trim()

export type HardBlocker = "abort_signal" | "kill_switch_active" | "user_message_pending"

export async function checkHardBlockers(sessionID: string, abort: AbortSignal): Promise<HardBlocker | null> {
  if (abort.aborted) return "abort_signal"
  const ksState = await KillSwitchService.getState().catch(() => undefined)
  if (ksState?.active) return "kill_switch_active"
  return null
}

// Runloop continuation decision surface.
//
// Design contract (2026-04-18): autonomous runner is a dumb todolist engine
// layered on top of the turn-based conversation. It stimulates the AI to
// keep the todolist up-to-date and exits when the AI declines to add more.
// The runner itself never synthesises stop conditions — the AI decides all
// blocking/approval/question behaviour via its normal tool calls.
export type ContinuationDecisionReason =
  | "subagent_session"
  | "todo_complete"
  | "todo_in_progress"
  | "todo_pending"
  | "completion_verify"

export type AutonomousNextAction =
  | {
      type: "stop"
      reason: Exclude<ContinuationDecisionReason, "todo_pending" | "todo_in_progress" | "completion_verify">
    }
  | {
      type: "continue"
      reason: "todo_pending" | "todo_in_progress" | "completion_verify"
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
const resumeInFlight = new Map<string, number>()
const RESUME_IN_FLIGHT_TIMEOUT_MS = 5 * 60_000 // 5 minutes — if a resume takes longer, allow re-entry
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
  session: Pick<Session.Info, "parentID" | "workflow" | "time">
  todos: Todo.Info[]
  lastDecisionReason?: ContinuationDecisionReason
}) {
  const next = planAutonomousNextAction(input)
  return next.type === "continue"
    ? { continue: true as const, reason: next.reason, text: next.text, todo: next.todo }
    : { continue: false as const, reason: next.reason }
}

/**
 * Plan the next autonomous action for a session.
 *
 * Pure-logic counterpart to decideAutonomousContinuation. Given a session
 * and todo list, decide whether to continue (pending/in-progress todo or
 * a first-time completion-verify nudge) or stop (subagent / todo_complete).
 */
export function planAutonomousNextAction(input: {
  session: Pick<Session.Info, "parentID" | "workflow" | "time">
  todos: Todo.Info[]
  lastDecisionReason?: ContinuationDecisionReason
}): AutonomousNextAction {
  // Structural boundary: subagents are driven by their parent; they never
  // run the autonomous continuation engine themselves.
  if (input.session.parentID) {
    return { type: "stop", reason: "subagent_session" }
  }

  const current = Todo.nextActionableTodo(input.todos)
  const trigger = buildContinuationTrigger({
    todo: current,
    textForPending: RUNNER_CONTINUATION_TEXT,
    textForInProgress: RUNNER_CONTINUATION_TEXT,
  })

  // No actionable todo → send "update the todolist" nudge once.
  // If AI already got nudged (lastDecisionReason === completion_verify) and
  // still did not update the todo list, treat as genuine completion and stop.
  if (!trigger) {
    const alreadyVerified = input.lastDecisionReason === "completion_verify"
    if (!alreadyVerified) {
      const verifyTodo: Todo.Info = {
        id: "_runner_completion_verify",
        content: "[runner] update the todolist",
        status: "pending",
        priority: "high",
        action: { kind: "decision", risk: "low", needsApproval: false, canDelegate: false },
      }
      return {
        type: "continue",
        reason: "completion_verify",
        text: RUNNER_CONTINUATION_TEXT,
        todo: verifyTodo,
      }
    }
    return { type: "stop", reason: "todo_complete" }
  }

  // Trigger exists → continue. No pre-emptive gates.
  // AI decides on blockers / approvals / questions itself and signals stop
  // by ending the turn without updating the todolist. The runloop only
  // stimulates the AI to update its todolist; it never silently gates work.
  return {
    type: "continue",
    reason: trigger.source,
    text: trigger.payload.text,
    todo: trigger.payload.todo,
  }
}

export function describeAutonomousNextAction(action: AutonomousNextAction): AutonomousNarration {
  if (action.type === "continue") {
    if (action.reason === "completion_verify") {
      return { kind: "continue", text: "Runner verifying completion before stopping." }
    }
    return {
      kind: "continue",
      text:
        action.reason === "todo_in_progress"
          ? `Runner continuing current step: ${action.todo.content}`
          : `Runner starting next planned step: ${action.todo.content}`,
    }
  }

  switch (action.reason) {
    case "todo_complete":
      return { kind: "complete", text: "Runner complete: the current planned todo set is done." }
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

export async function decideAutonomousContinuation(input: {
  sessionID: string
  lastDecisionReason?: ContinuationDecisionReason
}) {
  const session = await Session.get(input.sessionID)
  const todos = await Todo.get(input.sessionID)
  const decision = evaluateAutonomousContinuation({
    session,
    todos,
    lastDecisionReason: input.lastDecisionReason,
  })
  debugCheckpoint("workflow", "continuation_decision", {
    sessionID: input.sessionID,
    continue: decision.continue,
    reason: decision.reason,
    todosTotal: todos.length,
    todosPending: todos.filter((t) => t.status === "pending").length,
    todosInProgress: todos.filter((t) => t.status === "in_progress").length,
    todosCompleted: todos.filter((t) => t.status === "completed").length,
    workflowState: session.workflow?.state,
  })
  return decision
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
  const inFlightSince = resumeInFlight.get(sessionID)
  const inFlight = inFlightSince !== undefined && (Date.now() - inFlightSince) < RESUME_IN_FLIGHT_TIMEOUT_MS
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
    const inFlightSince = resumeInFlight.get(item.sessionID)
    const inFlight = inFlightSince !== undefined && (Date.now() - inFlightSince) < RESUME_IN_FLIGHT_TIMEOUT_MS
    if (inFlightSince !== undefined && !inFlight) {
      log.warn("resumePendingContinuations: clearing stale in-flight entry", {
        sessionID: item.sessionID,
        staleSinceMs: Date.now() - inFlightSince,
      })
      resumeInFlight.delete(item.sessionID)
    }
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
    resumeInFlight.set(sessionID, Date.now())
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
}) {
  const now = Date.now()
  const session = await Session.get(input.sessionID)
  const text = input.text ?? RUNNER_CONTINUATION_TEXT
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
export { type RunTrigger, type TriggerPriority } from "./trigger"
export { buildContinuationTrigger, buildApiTrigger } from "./trigger"

/**
 * Collect completed subagent results from the RunQueue.
 *
 * Called at the runloop boundary — after model output is finalized but BEFORE
 * the autonomous continuation decision. This is the "return half" of the
 * dispatch/collect pair: every subagent dispatch must eventually be collected.
 *
 * Returns the consumed queue entry if a completion was found, undefined otherwise.
 */
export async function collectCompletedSubagents(sessionID: string) {
  const entry = await RunQueue.peek(sessionID)
  if (!entry) return undefined
  if (entry.triggerType !== "task_completion" && entry.triggerType !== "task_failure") return undefined

  await RunQueue.remove(sessionID)
  log.info("collectCompletedSubagents: consumed", {
    sessionID,
    triggerType: entry.triggerType,
    messageID: entry.messageID,
  })
  return entry
}

// Re-export queue and lane types for consumers
export { RunQueue, type QueueEntry } from "./queue"
export { type Lane, LANE_CONFIGS, LANES_BY_PRIORITY, triggerPriorityToLane, laneHasCapacity } from "./lane-policy"
