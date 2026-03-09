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

export const AUTONOMOUS_CONTINUE_TEXT =
  "Continue with the next planned step. Only stop and ask the user if you hit a real blocker or need a product decision."

export const AUTONOMOUS_PROGRESS_TEXT =
  "Continue the task already in progress. Finish or unblock it before starting new work, unless reprioritization is clearly necessary."

export type ContinuationDecisionReason =
  | "subagent_session"
  | "autonomous_disabled"
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

function detectStructuredStopReason(
  todos: Todo.Info[],
): Extract<ContinuationDecisionReason, "approval_needed" | "product_decision_needed" | "wait_subagent"> | undefined {
  const actionable = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress")
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
  const actionable = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress")
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
  const actionable = input.todos.filter(
    (todo) => (todo.status === "pending" || todo.status === "in_progress") && Todo.isDependencyReady(todo, input.todos),
  )
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
  session: Pick<Session.Info, "workflow">
  status: SessionStatus.Info
  inFlight: boolean
  budget?: {
    family: string
    waitTimeMs: number
  }
}

export function shouldResumePendingContinuation(input: {
  session: Pick<Session.Info, "workflow">
  status: SessionStatus.Info
  inFlight: boolean
  owner?: string
  now?: number
}) {
  if (input.inFlight) return false
  if (input.status.type !== "idle") return false
  const workflow = input.session.workflow
  if (!workflow?.autonomous.enabled) return false
  if (workflow.state === "blocked" || workflow.state === "completed") return false
  const now = input.now ?? Date.now()
  const supervisor = workflow.supervisor
  if ((supervisor?.retryAt ?? 0) > now) return false
  if ((supervisor?.leaseExpiresAt ?? 0) > now && supervisor?.leaseOwner && supervisor.leaseOwner !== input.owner)
    return false
  return true
}

export function computeResumeBackoffMs(consecutiveFailures: number) {
  const step = Math.max(1, consecutiveFailures)
  return Math.min(5 * 60_000, 15_000 * 2 ** (step - 1))
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

export function pickPendingContinuationsForResume(input: { items: ResumeCandidate[]; maxCount: number }) {
  const eligible = input.items
    .filter((item) =>
      shouldResumePendingContinuation({
        session: item.session,
        status: item.status,
        inFlight: item.inFlight,
        owner: SUPERVISOR_OWNER,
      }),
    )
    .sort((a, b) => {
      const aReady = (a.budget?.waitTimeMs ?? 0) === 0 ? 0 : 1
      const bReady = (b.budget?.waitTimeMs ?? 0) === 0 ? 0 : 1
      if (aReady !== bReady) return aReady - bReady
      const aWait = a.budget?.waitTimeMs ?? 0
      const bWait = b.budget?.waitTimeMs ?? 0
      if (aWait !== bWait) return aWait - bWait
      const aRun = a.session.workflow?.lastRunAt ?? 0
      const bRun = b.session.workflow?.lastRunAt ?? 0
      if (aRun !== bRun) return aRun - bRun
      if (a.pending.createdAt !== b.pending.createdAt) return a.pending.createdAt - b.pending.createdAt
      return a.pending.sessionID.localeCompare(b.pending.sessionID)
    })

  const picked: ResumeCandidate[] = []
  const usedFamilies = new Set<string>()
  const maxCount = Math.max(0, input.maxCount)

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

export function planAutonomousNextAction(input: {
  session: Pick<Session.Info, "parentID" | "workflow" | "time">
  todos: Todo.Info[]
  roundCount: number
  activeSubtasks?: number
  pendingApprovals?: number
  pendingQuestions?: number
}): AutonomousNextAction {
  const workflow = input.session.workflow ?? Session.defaultWorkflow(input.session.time.updated)
  if (input.session.parentID) {
    return { type: "stop", reason: "subagent_session" }
  }
  if (!workflow.autonomous.enabled) {
    return { type: "stop", reason: "autonomous_disabled" }
  }
  if (workflow.state === "blocked") {
    return { type: "stop", reason: "blocked" }
  }
  const maxRounds = workflow.autonomous.maxContinuousRounds
  if (typeof maxRounds === "number" && input.roundCount >= maxRounds) {
    return { type: "stop", reason: "max_continuous_rounds" }
  }
  if ((input.pendingApprovals ?? 0) > 0) {
    return { type: "stop", reason: "approval_needed" }
  }
  if ((input.pendingQuestions ?? 0) > 0) {
    return { type: "stop", reason: "product_decision_needed" }
  }
  const structuredStop = detectStructuredStopReason(input.todos)
  if (structuredStop) {
    return { type: "stop", reason: structuredStop }
  }
  const approvalGate = detectApprovalRequiredForTodos({
    gates: workflow.autonomous.requireApprovalFor,
    todos: input.todos,
  })
  if (approvalGate) {
    return { type: "stop", reason: "approval_needed" }
  }
  if ((input.activeSubtasks ?? 0) > 0) {
    return { type: "stop", reason: "wait_subagent" }
  }
  const current = Todo.nextActionableTodo(input.todos)
  if (current?.status === "in_progress") {
    return { type: "continue", reason: "todo_in_progress", text: AUTONOMOUS_PROGRESS_TEXT, todo: current }
  }
  if (current?.status === "pending") {
    return { type: "continue", reason: "todo_pending", text: AUTONOMOUS_CONTINUE_TEXT, todo: current }
  }
  return { type: "stop", reason: "todo_complete" }
}

export function describeAutonomousNextAction(action: AutonomousNextAction): AutonomousNarration {
  if (action.type === "continue") {
    return {
      kind: "continue",
      text:
        action.reason === "todo_in_progress"
          ? `Continuing current step: ${action.todo.content}`
          : `Starting next planned step: ${action.todo.content}`,
    }
  }

  switch (action.reason) {
    case "approval_needed":
      return { kind: "pause", text: "Paused: approval is required before the next gated step." }
    case "product_decision_needed":
      return { kind: "pause", text: "Paused: I need a product decision before continuing." }
    case "wait_subagent":
      return { kind: "pause", text: "Paused: a delegated subagent task is still running." }
    case "max_continuous_rounds":
      return {
        kind: "pause",
        text: "Paused: I hit the current autonomous round limit and am waiting for your next instruction.",
      }
    case "todo_complete":
      return { kind: "complete", text: "Autonomous plan complete for the current todo set." }
    case "blocked":
      return { kind: "pause", text: "Paused: the workflow is currently blocked." }
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
  if (!input.session.workflow?.autonomous.enabled) return false
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
  return evaluateAutonomousContinuation({
    session,
    todos,
    roundCount: input.roundCount,
    activeSubtasks,
    pendingApprovals,
    pendingQuestions,
  })
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
  await Storage.remove(queueKey(sessionID)).catch(() => undefined)
}

export async function listPendingContinuations() {
  const result: PendingContinuationInfo[] = []
  for (const item of await Storage.list(["session_workflow_queue"])) {
    const entry = await Storage.read<PendingContinuationInfo>(item).catch(() => undefined)
    if (entry) result.push(entry)
  }
  return result.sort((a, b) => a.createdAt - b.createdAt)
}

export async function enqueuePendingContinuation(input: PendingContinuationInfo) {
  await Storage.write(queueKey(input.sessionID), PendingContinuationInfo.parse(input))
}

export async function resumePendingContinuations(input?: { maxCount?: number }) {
  using _lock = await Lock.write(RESUME_LOCK)
  const items = await listPendingContinuations()
  const resumable: ResumeCandidate[] = []
  for (const item of items) {
    const inFlight = resumeInFlight.has(item.sessionID)
    if (inFlight) continue
    const session = await Session.get(item.sessionID).catch(() => undefined)
    if (!session) {
      await clearPendingContinuation(item.sessionID)
      continue
    }
    resumable.push({
      pending: item,
      session,
      status: SessionStatus.get(item.sessionID),
      inFlight,
      budget: await resolvePendingContinuationBudget(item),
    })
  }

  const maxCount = input?.maxCount ?? 1
  const selected = pickPendingContinuationsForResume({
    items: resumable,
    maxCount,
  })

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
    void (async () => {
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
        await clearPendingContinuation(sessionID)
        const current = await Session.get(sessionID).catch(() => undefined)
        const nextFailures = (current?.workflow?.supervisor?.consecutiveResumeFailures ?? 0) + 1
        const classified = classifyResumeFailure(error)
        const backoffMs = computeResumeBackoffMs(nextFailures)
        const blocked =
          classified.shouldBlockImmediately ||
          (!classified.shouldRetry && nextFailures >= 1) ||
          shouldBlockAfterResumeFailure(nextFailures)
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
            retryAt: blocked ? undefined : Date.now() + backoffMs,
            lastResumeCategory: classified.category,
            lastResumeError: classified.reason,
          },
          clear: blocked ? ["leaseOwner", "leaseExpiresAt", "retryAt"] : ["leaseOwner", "leaseExpiresAt"],
        }).catch(() => undefined)
      } finally {
        resumeInFlight.delete(sessionID)
      }
    })()
  }
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
  const text = input.text ?? AUTONOMOUS_CONTINUE_TEXT
  const session = await Session.get(input.sessionID)
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
        fallbackModel: input.user.model,
      })
    : {
        model: input.user.model,
        trace: {
          agentName: input.user.agent,
          domain: "manual",
          selected: { ...input.user.model, source: "session_previous" },
          candidates: [{ ...input.user.model, source: "session_previous", operational: true }],
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
