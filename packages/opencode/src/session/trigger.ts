import { Session } from "./index"
import { Todo } from "./todo"
import type { ApprovalGate, ContinuationDecisionReason } from "./workflow-runner"

/**
 * RunTrigger — represents an intent to start or continue work in a session.
 *
 * Decouples "what wants to run" from "should it be allowed to run" (gate evaluation).
 * Currently three trigger types exist:
 *   - continuation: the existing todo-driven autonomous continuation path
 *   - api: scaffold for external API-initiated triggers (Phase 5B.4)
 *   - cron: scheduled job execution triggers (Phase 8 / D.1)
 */
export type RunTrigger = RunTrigger.Continuation | RunTrigger.Api | RunTrigger.Cron

export namespace RunTrigger {
  export type Continuation = {
    type: "continuation"
    source: "todo_pending" | "todo_in_progress"
    payload: {
      text: string
      todo: Todo.Info
    }
    priority: TriggerPriority
    gatePolicy: TriggerGatePolicy
  }

  export type Api = {
    type: "api"
    source: string
    payload: {
      text: string
      todo?: Todo.Info
      apiContext?: Record<string, unknown>
    }
    priority: TriggerPriority
    gatePolicy: TriggerGatePolicy
  }

  export type Cron = {
    type: "cron"
    source: "scheduled" | "heartbeat"
    payload: {
      text: string
      jobId: string
      runId: string
      lightContext: boolean
    }
    priority: TriggerPriority
    gatePolicy: TriggerGatePolicy
  }
}

export type TriggerPriority = "critical" | "normal" | "background"

export type TriggerGatePolicy = {
  respectMaxRounds: boolean
  checkApprovalGates: boolean
  checkStructuredStops: boolean
}

export const CONTINUATION_GATE_POLICY: TriggerGatePolicy = {
  respectMaxRounds: true,
  checkApprovalGates: true,
  checkStructuredStops: true,
}

export const API_GATE_POLICY: TriggerGatePolicy = {
  respectMaxRounds: false,
  checkApprovalGates: true,
  checkStructuredStops: true,
}

export const CRON_GATE_POLICY: TriggerGatePolicy = {
  respectMaxRounds: false,
  checkApprovalGates: false,
  checkStructuredStops: false,
}

/**
 * TriggerGateResult — outcome of gate evaluation for a trigger.
 */
export type TriggerGateResult =
  | { pass: true; trigger: RunTrigger }
  | { pass: false; reason: ContinuationDecisionReason }

/**
 * TriggerEvaluator — evaluates whether a trigger should be allowed to proceed.
 *
 * Extracted from the gate-checking portion of planAutonomousNextAction().
 * The evaluator checks session-level gates (autonomous enabled, mission approved,
 * workflow state, approvals, questions, structured stops, approval policies,
 * active subtasks, max rounds) independently of what *type* of trigger is requesting.
 */
export function evaluateGates(input: {
  trigger: RunTrigger
  session: Pick<Session.Info, "parentID" | "workflow" | "time" | "mission">
  todos: Todo.Info[]
  roundCount: number
  activeSubtasks?: number
  pendingApprovals?: number
  pendingQuestions?: number
  isPlanTrusting: boolean
  detectStructuredStopReason: (todos: Todo.Info[]) => ContinuationDecisionReason | undefined
  detectApprovalGate: (input: { gates?: string[]; todos: Todo.Info[] }) => ApprovalGate | undefined
}): TriggerGateResult {
  const workflow = input.session.workflow ?? Session.defaultWorkflow(input.session.time.updated)
  const policy = input.trigger.gatePolicy

  // Universal gates — always checked regardless of trigger type or policy
  if (input.session.parentID) {
    return { pass: false, reason: "subagent_session" }
  }
  // autonomous is always-on — no enabled gate
  if (workflow.state === "blocked") {
    return { pass: false, reason: "blocked" }
  }

  // Mission / beta-admission gates removed 2026-04-18.
  // Autonomous runner is a dumb todolist engine — the skill / AI layer
  // owns planning. Session.setMission() has no caller since the old
  // plan_enter tool was ripped out on 2026-04-09, so these gates just
  // blocked every non-chat session from continuing. Dead code.

  // Pending approvals / questions
  if ((input.pendingApprovals ?? 0) > 0) {
    return { pass: false, reason: "approval_needed" }
  }
  if ((input.pendingQuestions ?? 0) > 0) {
    return { pass: false, reason: "product_decision_needed" }
  }

  // Structured stop reasons from todo action metadata
  if (policy.checkStructuredStops) {
    const structuredStop = input.detectStructuredStopReason(input.todos)
    if (structuredStop) {
      return { pass: false, reason: structuredStop }
    }
  }

  // Approval gate policy (push / destructive / architecture_change)
  if (policy.checkApprovalGates) {
    const approvalGate = input.detectApprovalGate({
      gates: workflow.autonomous.requireApprovalFor,
      todos: input.todos,
    })
    if (approvalGate) {
      return { pass: false, reason: "approval_needed" }
    }
  }

  // Active subtasks
  if ((input.activeSubtasks ?? 0) > 0) {
    return { pass: false, reason: "wait_subagent" }
  }

  // Max rounds (only when policy says so, and not in plan-trusting mode)
  if (policy.respectMaxRounds && !input.isPlanTrusting) {
    const maxRounds = workflow.autonomous.maxContinuousRounds
    if (typeof maxRounds === "number" && input.roundCount >= maxRounds) {
      return { pass: false, reason: "max_continuous_rounds" }
    }
  }

  return { pass: true, trigger: input.trigger }
}

/**
 * Build a continuation trigger from todo state.
 * Returns undefined if no actionable todo exists (todo_complete).
 */
export function buildContinuationTrigger(input: {
  todo: Todo.Info | undefined
  textForPending: string
  textForInProgress: string
}): RunTrigger.Continuation | undefined {
  if (!input.todo) return undefined

  if (input.todo.status === "in_progress") {
    return {
      type: "continuation",
      source: "todo_in_progress",
      payload: { text: input.textForInProgress, todo: input.todo },
      priority: "normal",
      gatePolicy: CONTINUATION_GATE_POLICY,
    }
  }
  if (input.todo.status === "pending") {
    return {
      type: "continuation",
      source: "todo_pending",
      payload: { text: input.textForPending, todo: input.todo },
      priority: "normal",
      gatePolicy: CONTINUATION_GATE_POLICY,
    }
  }
  return undefined
}

/**
 * Build an API trigger scaffold.
 * The caller provides text and optional todo; gate policy uses API defaults.
 */
export function buildApiTrigger(input: {
  source: string
  text: string
  todo?: Todo.Info
  priority?: TriggerPriority
  apiContext?: Record<string, unknown>
}): RunTrigger.Api {
  return {
    type: "api",
    source: input.source,
    payload: {
      text: input.text,
      todo: input.todo,
      apiContext: input.apiContext,
    },
    priority: input.priority ?? "normal",
    gatePolicy: API_GATE_POLICY,
  }
}

/**
 * Build a cron trigger for a scheduled job execution (D.1).
 * Cron triggers bypass all session-level gates (mission, rounds, approvals, stops).
 */
export function buildCronTrigger(input: {
  source: "scheduled" | "heartbeat"
  text: string
  jobId: string
  runId: string
  lightContext?: boolean
  priority?: TriggerPriority
}): RunTrigger.Cron {
  return {
    type: "cron",
    source: input.source,
    payload: {
      text: input.text,
      jobId: input.jobId,
      runId: input.runId,
      lightContext: input.lightContext ?? false,
    },
    priority: input.priority ?? "background",
    gatePolicy: CRON_GATE_POLICY,
  }
}
