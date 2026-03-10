import { generateObject, streamObject, type ModelMessage } from "ai"
import z from "zod"
import type { Provider } from "@/provider/provider"
import { Provider as ProviderRegistry } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Session } from "."
import { Todo } from "./todo"
import type { MessageV2 } from "./message-v2"
import SMART_RUNNER_GOVERNOR_PROMPT from "./prompt/smart-runner-governor.txt"

const SmartRunnerDecisionSchema = z.object({
  situation: z.enum([
    "ready_to_continue",
    "execution_stalled",
    "plan_invalid",
    "context_gap",
    "waiting_for_human",
    "completed",
  ]),
  assessment: z.string(),
  decision: z.enum([
    "continue",
    "replan",
    "ask_user",
    "request_approval",
    "pause_for_risk",
    "pause",
    "complete",
    "docs_sync_first",
    "debug_preflight_first",
  ]),
  reason: z.string(),
  nextAction: z.object({
    kind: z.enum([
      "continue_current",
      "start_next_todo",
      "replan_todos",
      "request_approval",
      "pause_for_risk",
      "request_docs_sync",
      "request_debug_preflight",
      "request_user_input",
    ]),
    todoID: z.string().optional(),
    skillHints: z.array(z.string()).default([]),
    narration: z.string(),
  }),
  needsUserInput: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
})

export type SmartRunnerDecision = z.infer<typeof SmartRunnerDecisionSchema>

const SmartRunnerTraceSchema = z.object({
  source: z.literal("smart_runner_governor"),
  dryRun: z.literal(true),
  status: z.enum(["disabled", "advisory", "error"]),
  createdAt: z.number(),
  deterministicReason: z.string(),
  model: z
    .object({
      providerId: z.string(),
      modelID: z.string(),
    })
    .optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  decision: SmartRunnerDecisionSchema.optional(),
  assist: z
    .object({
      enabled: z.boolean(),
      applied: z.boolean(),
      mode: z.string().optional(),
      finalTextChanged: z.boolean().optional(),
      narrationUsed: z.boolean().optional(),
    })
    .optional(),
  suggestion: z
    .object({
      kind: z.enum(["replan", "ask_user", "request_approval", "pause_for_risk", "complete", "pause"]),
      reason: z.string(),
      suggestedTodoID: z.string().optional(),
      suggestedAction: z.string().optional(),
      draftQuestion: z.string().optional(),
      askUserHandoff: z
        .object({
          question: z.string().optional(),
          whyNow: z.string().optional(),
          blockingDecision: z.string().optional(),
          impactIfUnanswered: z.string().optional(),
        })
        .optional(),
      askUserAdoption: z
        .object({
          proposalID: z.string().optional(),
          proposedQuestion: z.string().optional(),
          targetTodoID: z.string().optional(),
          rationale: z.string().optional(),
          adoptionNote: z.string().optional(),
          policy: z
            .object({
              trustLevel: z.enum(["low", "medium", "high"]).optional(),
              adoptionMode: z.enum(["advisory_only", "host_adoptable", "user_confirm_required"]).optional(),
              requiresUserConfirm: z.boolean().optional(),
              requiresHostReview: z.boolean().optional(),
            })
            .optional(),
          hostAdopted: z.boolean().optional(),
          hostAdoptionReason: z
            .enum([
              "adopted",
              "missing_question",
              "policy_not_user_confirm_required",
              "user_confirm_missing",
              "host_review_missing",
              "question_already_pending",
              "question_rejected",
            ])
            .optional(),
        })
        .optional(),
      approvalRequest: z
        .object({
          proposalID: z.string().optional(),
          targetTodoID: z.string().optional(),
          rationale: z.string().optional(),
          approvalScope: z.string().optional(),
          adoptionNote: z.string().optional(),
          policy: z
            .object({
              trustLevel: z.enum(["low", "medium", "high"]).optional(),
              adoptionMode: z.enum(["advisory_only", "host_adoptable", "user_confirm_required"]).optional(),
              requiresUserConfirm: z.boolean().optional(),
              requiresHostReview: z.boolean().optional(),
            })
            .optional(),
          hostAdopted: z.boolean().optional(),
          hostAdoptionReason: z
            .enum(["adopted", "policy_not_host_adoptable", "user_confirm_required", "host_review_missing"])
            .optional(),
        })
        .optional(),
      riskPauseRequest: z
        .object({
          proposalID: z.string().optional(),
          targetTodoID: z.string().optional(),
          rationale: z.string().optional(),
          riskSummary: z.string().optional(),
          pauseScope: z.string().optional(),
          adoptionNote: z.string().optional(),
          policy: z
            .object({
              trustLevel: z.enum(["low", "medium", "high"]).optional(),
              adoptionMode: z.enum(["advisory_only", "host_adoptable", "user_confirm_required"]).optional(),
              requiresUserConfirm: z.boolean().optional(),
              requiresHostReview: z.boolean().optional(),
            })
            .optional(),
          hostAdopted: z.boolean().optional(),
          hostAdoptionReason: z
            .enum(["adopted", "policy_not_host_adoptable", "user_confirm_required", "host_review_missing"])
            .optional(),
        })
        .optional(),
      completionRequest: z
        .object({
          proposalID: z.string().optional(),
          targetTodoID: z.string().optional(),
          proposedAction: z.string().optional(),
          rationale: z.string().optional(),
          completionScope: z.string().optional(),
          adoptionNote: z.string().optional(),
          policy: z
            .object({
              trustLevel: z.enum(["low", "medium", "high"]).optional(),
              adoptionMode: z.enum(["advisory_only", "host_adoptable", "user_confirm_required"]).optional(),
              requiresUserConfirm: z.boolean().optional(),
              requiresHostReview: z.boolean().optional(),
            })
            .optional(),
          hostAdopted: z.boolean().optional(),
          hostAdoptionReason: z
            .enum([
              "adopted",
              "missing_target",
              "unsupported_action",
              "policy_not_host_adoptable",
              "user_confirm_required",
              "host_review_missing",
              "target_not_active",
              "approval_gate",
              "waiting_gate",
              "not_terminal_after_completion",
            ])
            .optional(),
        })
        .optional(),
      pauseRequest: z
        .object({
          rationale: z.string().optional(),
          pauseScope: z.string().optional(),
          advisoryNote: z.string().optional(),
          policy: z
            .object({
              trustLevel: z.enum(["low", "medium", "high"]).optional(),
              adoptionMode: z.enum(["advisory_only", "host_adoptable", "user_confirm_required"]).optional(),
              requiresUserConfirm: z.boolean().optional(),
              requiresHostReview: z.boolean().optional(),
            })
            .optional(),
        })
        .optional(),
      replanRequest: z
        .object({
          targetTodoID: z.string().optional(),
          requestedAction: z.string().optional(),
          proposedNextStep: z.string().optional(),
          note: z.string().optional(),
        })
        .optional(),
      replanAdoption: z
        .object({
          proposalID: z.string().optional(),
          targetTodoID: z.string().optional(),
          proposedAction: z.string().optional(),
          proposedNextStep: z.string().optional(),
          rationale: z.string().optional(),
          adoptionNote: z.string().optional(),
          policy: z
            .object({
              trustLevel: z.enum(["low", "medium", "high"]).optional(),
              adoptionMode: z.enum(["advisory_only", "host_adoptable", "user_confirm_required"]).optional(),
              requiresUserConfirm: z.boolean().optional(),
              requiresHostReview: z.boolean().optional(),
            })
            .optional(),
          hostAdopted: z.boolean().optional(),
          hostAdoptionReason: z
            .enum([
              "adopted",
              "missing_target",
              "unsupported_action",
              "policy_not_host_adoptable",
              "user_confirm_required",
              "host_review_missing",
              "active_todo_in_progress",
              "target_not_pending",
              "dependencies_not_ready",
              "approval_gate",
              "waiting_gate",
              "unsupported_todo_kind",
            ])
            .optional(),
        })
        .optional(),
    })
    .optional(),
  error: z.string().optional(),
})

export type SmartRunnerTrace = z.infer<typeof SmartRunnerTraceSchema>
const SMART_RUNNER_TRACE_HISTORY_LIMIT = 5
const SMART_RUNNER_LABEL = "[AI]"

export type SmartRunnerAskUserAdoptionReason = NonNullable<
  NonNullable<NonNullable<SmartRunnerTrace["suggestion"]>["askUserAdoption"]>["hostAdoptionReason"]
>

export type SmartRunnerHostAdoptionPolicyReason =
  | "adopted"
  | "policy_not_host_adoptable"
  | "user_confirm_required"
  | "host_review_missing"

export type SmartRunnerBoundedAssistResult = {
  decision: DeterministicContinueDecision
  narration?: string
  applied: boolean
  mode?: string
}

export function prefixSmartRunnerText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return SMART_RUNNER_LABEL
  if (trimmed.startsWith(SMART_RUNNER_LABEL)) return text
  return `${SMART_RUNNER_LABEL} ${text}`
}

export function getSmartRunnerAskUserQuestionText(input: {
  suggestion?: SmartRunnerTrace["suggestion"]
}): string | undefined {
  const proposed =
    input.suggestion?.askUserAdoption?.proposedQuestion ??
    input.suggestion?.askUserHandoff?.question ??
    input.suggestion?.draftQuestion
  const question = proposed?.trim()
  return question || undefined
}

export function evaluateSmartRunnerAskUserAdoption(input: {
  suggestion?: SmartRunnerTrace["suggestion"]
  pendingQuestions: number
}): {
  adopted: boolean
  reason?: SmartRunnerAskUserAdoptionReason
  questionText?: string
} {
  if (!input.suggestion?.askUserAdoption) return { adopted: false }

  const questionText = getSmartRunnerAskUserQuestionText({ suggestion: input.suggestion })
  const policy = input.suggestion.askUserAdoption.policy
  const reason = !questionText
    ? ("missing_question" as const)
    : policy?.adoptionMode !== "user_confirm_required"
      ? ("policy_not_user_confirm_required" as const)
      : policy?.requiresUserConfirm !== true
        ? ("user_confirm_missing" as const)
        : policy?.requiresHostReview === false
          ? ("host_review_missing" as const)
          : input.pendingQuestions > 0
            ? ("question_already_pending" as const)
            : ("adopted" as const)

  return {
    adopted: reason === "adopted",
    reason,
    questionText,
  }
}

export function evaluateSmartRunnerHostAdoptionPolicy(input?: {
  adoptionMode?: "advisory_only" | "host_adoptable" | "user_confirm_required"
  requiresUserConfirm?: boolean
  requiresHostReview?: boolean
}): SmartRunnerHostAdoptionPolicyReason {
  return input?.adoptionMode !== "host_adoptable"
    ? "policy_not_host_adoptable"
    : input?.requiresUserConfirm === true
      ? "user_confirm_required"
      : input?.requiresHostReview === false
        ? "host_review_missing"
        : "adopted"
}

function buildDocsSyncAssistText(input: { todo: Todo.Info }) {
  return [
    `Smart Runner preflight: docs sync before execution.`,
    `1. Re-read the relevant architecture/event docs for this task and extract only the constraints that matter to the current step.`,
    `2. Verify the current todo still matches that documented context: ${input.todo.content}.`,
    `3. If the docs and task still align, continue the planned work immediately after the docs check. If they conflict, stop and explain the mismatch before changing code.`,
  ].join("\n")
}

function buildDebugPreflightAssistText(input: { todo: Todo.Info }) {
  return [
    `Smart Runner preflight: debug before execution.`,
    `1. Restate the exact symptom and the system/component boundaries involved in: ${input.todo.content}.`,
    `2. Define the evidence to gather next (logs, checkpoints, failing path, or verification signal) before attempting further fixes.`,
    `3. Only after that preflight, continue the planned work. If the evidence points somewhere else, explain the pivot before changing code.`,
  ].join("\n")
}

function buildPauseAssistText(input: { todo: Todo.Info }) {
  return [
    `Smart Runner pause check before execution.`,
    `1. Do not continue implementation blindly on: ${input.todo.content}.`,
    `2. Restate what is still unclear, risky, or weakly evidenced about the next move.`,
    `3. Either ask for the missing decision/input or explain the exact evidence that now makes continuation safe.`,
  ].join("\n")
}

type DeterministicContinueDecision = {
  continue: true
  reason: "todo_pending" | "todo_in_progress"
  text: string
  todo: Todo.Info
}

type GovernorContextPack = {
  goal: string
  workflow: {
    state: string
    autonomous: boolean
    roundCount: number
    stopReason?: string
  }
  todos: {
    inProgress: Array<{ id: string; content: string }>
    actionable: Array<{ id: string; content: string }>
    blocked: Array<{ id: string; content: string; waitingOn?: string }>
  }
  recentProgress: {
    lastNarration?: string
    latestAssistantSummary?: string
    latestToolResults: string[]
  }
  docs: {
    architectureSlice?: string
    eventSlice?: string
  }
  health: {
    pendingApprovals: number
    pendingQuestions: number
    activeSubtasks: number
    budget: "unknown"
  }
  deterministicPlan: {
    reason: DeterministicContinueDecision["reason"]
    todoID: string
    todoContent: string
    continueText: string
  }
}

export function shouldRunSmartRunnerGovernorDryRun(input: { enabled?: boolean; decision: { continue: boolean } }) {
  return !!input.enabled && input.decision.continue
}

export function applySmartRunnerBoundedAssist(input: {
  enabled?: boolean
  decision: DeterministicContinueDecision
  trace?: SmartRunnerTrace
}): SmartRunnerBoundedAssistResult {
  if (!input.enabled) return { decision: input.decision, applied: false }
  if (input.trace?.status !== "advisory" || !input.trace.decision) return { decision: input.decision, applied: false }

  const advisory = input.trace.decision
  if (advisory.confidence === "low") return { decision: input.decision, applied: false }

  if (advisory.decision === "docs_sync_first" && advisory.nextAction.kind === "request_docs_sync") {
    return {
      decision: {
        ...input.decision,
        text: buildDocsSyncAssistText({ todo: input.decision.todo }),
      },
      narration: advisory.nextAction.narration,
      applied: true,
      mode: "docs_sync_first",
    }
  }

  if (advisory.decision === "debug_preflight_first" && advisory.nextAction.kind === "request_debug_preflight") {
    return {
      decision: {
        ...input.decision,
        text: buildDebugPreflightAssistText({ todo: input.decision.todo }),
      },
      narration: advisory.nextAction.narration,
      applied: true,
      mode: "debug_preflight_first",
    }
  }

  if (advisory.decision === "pause") {
    return {
      decision: {
        ...input.decision,
        text: buildPauseAssistText({ todo: input.decision.todo }),
      },
      narration: advisory.nextAction.narration,
      applied: true,
      mode: "pause",
    }
  }

  if (
    advisory.decision === "continue" &&
    advisory.nextAction.kind === "continue_current" &&
    input.decision.reason === "todo_in_progress"
  ) {
    return {
      decision: {
        ...input.decision,
        text: "Continue the task already in progress. Keep scope tight, finish or unblock it first, and avoid starting new work unless the current step is clearly invalid.",
      },
      narration: advisory.nextAction.narration,
      applied: true,
      mode: "continue_current",
    }
  }

  if (
    advisory.decision === "continue" &&
    advisory.nextAction.kind === "start_next_todo" &&
    input.decision.reason === "todo_pending"
  ) {
    return {
      decision: {
        ...input.decision,
        text: "Start the next actionable todo. Stay aligned with the current goal and only stop if you hit a real blocker, approval gate, or product decision.",
      },
      narration: advisory.nextAction.narration,
      applied: true,
      mode: "start_next_todo",
    }
  }

  return { decision: input.decision, applied: false }
}

export function annotateSmartRunnerTraceAssist(input: {
  trace: SmartRunnerTrace
  enabled: boolean
  assist: SmartRunnerBoundedAssistResult
  originalText: string
}) {
  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    assist: {
      enabled: input.enabled,
      applied: input.assist.applied,
      mode: input.assist.mode,
      finalTextChanged: input.originalText !== input.assist.decision.text,
      narrationUsed: !!input.assist.narration,
    },
  })
}

export function annotateSmartRunnerTraceSuggestion(input: { trace: SmartRunnerTrace }) {
  if (input.trace.status !== "advisory" || !input.trace.decision) return input.trace
  if (
    !["replan", "ask_user", "request_approval", "pause_for_risk", "complete", "pause"].includes(
      input.trace.decision.decision,
    )
  )
    return input.trace

  const draftQuestion =
    input.trace.decision.decision === "ask_user"
      ? input.trace.decision.nextAction.narration.trim() || input.trace.decision.reason.trim()
      : undefined
  const askUserHandoff =
    input.trace.decision.decision === "ask_user"
      ? {
          question: draftQuestion,
          whyNow: input.trace.decision.reason,
          blockingDecision: input.trace.decision.nextAction.todoID
            ? `Need a decision before continuing todo ${input.trace.decision.nextAction.todoID}.`
            : "Need a user/product decision before continuing the current plan.",
          impactIfUnanswered:
            "Autonomous progress may continue in the wrong direction or stall on an unresolved product choice.",
        }
      : undefined
  const askUserAdoption =
    input.trace.decision.decision === "ask_user"
      ? {
          proposalID: input.trace.decision.nextAction.todoID
            ? `ask-user:${input.trace.decision.nextAction.todoID}`
            : "ask-user:unspecified",
          proposedQuestion: draftQuestion,
          targetTodoID: input.trace.decision.nextAction.todoID,
          rationale: input.trace.decision.reason,
          adoptionNote:
            "Host may adopt this proposal into a real user question if the current loop should pause for clarification.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "user_confirm_required",
            requiresUserConfirm: true,
            requiresHostReview: true,
          },
        }
      : undefined
  const replanRequest =
    input.trace.decision.decision === "replan"
      ? {
          targetTodoID: input.trace.decision.nextAction.todoID,
          requestedAction: input.trace.decision.nextAction.kind,
          proposedNextStep:
            input.trace.decision.nextAction.todoID || input.trace.decision.nextAction.kind
              ? `Re-evaluate todo ${input.trace.decision.nextAction.todoID ?? "(unspecified)"} before continuing.`
              : undefined,
          note: input.trace.decision.reason,
        }
      : undefined
  const approvalRequest =
    input.trace.decision.decision === "request_approval"
      ? {
          proposalID: input.trace.decision.nextAction.todoID
            ? `approval:${input.trace.decision.nextAction.todoID}`
            : "approval:unspecified",
          targetTodoID: input.trace.decision.nextAction.todoID,
          rationale: input.trace.decision.reason,
          approvalScope: input.trace.decision.nextAction.todoID
            ? `Approval needed before continuing todo ${input.trace.decision.nextAction.todoID}.`
            : "Approval needed before continuing the current plan.",
          adoptionNote: "Host may adopt this proposal into a real approval pause before continuing execution.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        }
      : undefined
  const riskPauseRequest =
    input.trace.decision.decision === "pause_for_risk"
      ? {
          proposalID: input.trace.decision.nextAction.todoID
            ? `risk-pause:${input.trace.decision.nextAction.todoID}`
            : "risk-pause:unspecified",
          targetTodoID: input.trace.decision.nextAction.todoID,
          rationale: input.trace.decision.reason,
          riskSummary: input.trace.decision.assessment,
          pauseScope: input.trace.decision.nextAction.todoID
            ? `Pause before continuing risky todo ${input.trace.decision.nextAction.todoID}.`
            : "Pause before continuing the current risky plan.",
          adoptionNote: "Host may adopt this proposal into a real risk pause before continuing execution.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        }
      : undefined
  const completionRequest =
    input.trace.decision.decision === "complete"
      ? {
          proposalID: input.trace.decision.nextAction.todoID
            ? `complete:${input.trace.decision.nextAction.todoID}`
            : "complete:unspecified",
          targetTodoID: input.trace.decision.nextAction.todoID,
          proposedAction: "mark_todo_complete",
          rationale: input.trace.decision.reason,
          completionScope: input.trace.decision.nextAction.todoID
            ? `Mark todo ${input.trace.decision.nextAction.todoID} complete if the current slice is truly done.`
            : "Mark the current todo complete if the current slice is truly done.",
          adoptionNote:
            "Host may adopt this proposal into a real todo completion only if re-evaluation confirms the workflow is terminal.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        }
      : undefined
  const pauseRequest =
    input.trace.decision.decision === "pause"
      ? {
          rationale: input.trace.decision.reason,
          pauseScope: input.trace.decision.nextAction.todoID
            ? `Pause around todo ${input.trace.decision.nextAction.todoID} until a clearer next step exists.`
            : "Pause the current autonomous plan until a clearer next step exists.",
          advisoryNote:
            "This is an advisory-only Smart Runner pause suggestion; host should observe it but not auto-adopt it into a new stop contract.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "advisory_only",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        }
      : undefined
  const replanAdoption =
    input.trace.decision.decision === "replan"
      ? {
          proposalID: input.trace.decision.nextAction.todoID
            ? `replan:${input.trace.decision.nextAction.todoID}`
            : "replan:unspecified",
          targetTodoID: input.trace.decision.nextAction.todoID,
          proposedAction: input.trace.decision.nextAction.kind,
          proposedNextStep:
            input.trace.decision.nextAction.todoID || input.trace.decision.nextAction.kind
              ? `Host may adopt a replan around todo ${input.trace.decision.nextAction.todoID ?? "(unspecified)"} before continuing.`
              : undefined,
          rationale: input.trace.decision.reason,
          adoptionNote:
            "Host may adopt this proposal into a real todo replan if current execution no longer matches the plan.",
          policy: {
            trustLevel: "medium",
            adoptionMode: "host_adoptable",
            requiresUserConfirm: false,
            requiresHostReview: true,
          },
        }
      : undefined

  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    suggestion: {
      kind: input.trace.decision.decision,
      reason: input.trace.decision.reason,
      suggestedTodoID: input.trace.decision.nextAction.todoID,
      suggestedAction: input.trace.decision.nextAction.kind,
      draftQuestion,
      askUserHandoff,
      askUserAdoption,
      approvalRequest,
      riskPauseRequest,
      completionRequest,
      pauseRequest,
      replanRequest,
      replanAdoption,
    },
  })
}

export function annotateSmartRunnerCompletionAdoption(input: {
  trace: SmartRunnerTrace
  adopted: boolean
  reason?:
    | "adopted"
    | "missing_target"
    | "unsupported_action"
    | "policy_not_host_adoptable"
    | "user_confirm_required"
    | "host_review_missing"
    | "target_not_active"
    | "approval_gate"
    | "waiting_gate"
    | "not_terminal_after_completion"
}) {
  if (
    input.trace.status !== "advisory" ||
    input.trace.suggestion?.kind !== "complete" ||
    !input.trace.suggestion.completionRequest
  ) {
    return input.trace
  }

  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    suggestion: {
      ...input.trace.suggestion,
      completionRequest: {
        ...input.trace.suggestion.completionRequest,
        hostAdopted: input.adopted,
        hostAdoptionReason: input.reason,
      },
    },
  })
}

export function annotateSmartRunnerRiskPauseAdoption(input: {
  trace: SmartRunnerTrace
  adopted: boolean
  reason?: "adopted" | "policy_not_host_adoptable" | "user_confirm_required" | "host_review_missing"
}) {
  if (
    input.trace.status !== "advisory" ||
    input.trace.suggestion?.kind !== "pause_for_risk" ||
    !input.trace.suggestion.riskPauseRequest
  ) {
    return input.trace
  }

  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    suggestion: {
      ...input.trace.suggestion,
      riskPauseRequest: {
        ...input.trace.suggestion.riskPauseRequest,
        hostAdopted: input.adopted,
        hostAdoptionReason: input.reason,
      },
    },
  })
}

export function annotateSmartRunnerApprovalAdoption(input: {
  trace: SmartRunnerTrace
  adopted: boolean
  reason?: "adopted" | "policy_not_host_adoptable" | "user_confirm_required" | "host_review_missing"
}) {
  if (
    input.trace.status !== "advisory" ||
    input.trace.suggestion?.kind !== "request_approval" ||
    !input.trace.suggestion.approvalRequest
  ) {
    return input.trace
  }

  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    suggestion: {
      ...input.trace.suggestion,
      approvalRequest: {
        ...input.trace.suggestion.approvalRequest,
        hostAdopted: input.adopted,
        hostAdoptionReason: input.reason,
      },
    },
  })
}

export function annotateSmartRunnerAskUserAdoption(input: {
  trace: SmartRunnerTrace
  adopted: boolean
  reason?:
    | "adopted"
    | "missing_question"
    | "policy_not_user_confirm_required"
    | "user_confirm_missing"
    | "host_review_missing"
    | "question_already_pending"
    | "question_rejected"
}) {
  if (
    input.trace.status !== "advisory" ||
    input.trace.suggestion?.kind !== "ask_user" ||
    !input.trace.suggestion.askUserAdoption
  ) {
    return input.trace
  }

  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    suggestion: {
      ...input.trace.suggestion,
      askUserAdoption: {
        ...input.trace.suggestion.askUserAdoption,
        hostAdopted: input.adopted,
        hostAdoptionReason: input.reason,
      },
    },
  })
}

export function annotateSmartRunnerReplanAdoption(input: {
  trace: SmartRunnerTrace
  adopted: boolean
  reason?:
    | "adopted"
    | "missing_target"
    | "unsupported_action"
    | "policy_not_host_adoptable"
    | "user_confirm_required"
    | "host_review_missing"
    | "active_todo_in_progress"
    | "target_not_pending"
    | "dependencies_not_ready"
    | "approval_gate"
    | "waiting_gate"
    | "unsupported_todo_kind"
}) {
  if (
    input.trace.status !== "advisory" ||
    input.trace.suggestion?.kind !== "replan" ||
    !input.trace.suggestion.replanAdoption
  ) {
    return input.trace
  }

  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    suggestion: {
      ...input.trace.suggestion,
      replanAdoption: {
        ...input.trace.suggestion.replanAdoption,
        hostAdopted: input.adopted,
        hostAdoptionReason: input.reason,
      },
    },
  })
}

function latestUserGoal(messages: MessageV2.WithParts[], fallback: Todo.Info) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "user") continue
    const part = message.parts.findLast(
      (candidate) => candidate.type === "text" && !candidate.synthetic && !candidate.ignored,
    )
    const text = part?.type === "text" ? part.text.trim() : undefined
    if (text) return text
  }
  return fallback.content
}

function latestNarration(messages: MessageV2.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "assistant") continue
    const text = message.parts.findLast(
      (part) => part.type === "text" && part.synthetic && part.metadata?.autonomousNarration === true,
    )
    if (text?.type === "text") return text.text.trim()
  }
}

function latestAssistantSummary(messages: MessageV2.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "assistant") continue
    const text = message.parts.findLast(
      (part) => part.type === "text" && !part.metadata?.autonomousNarration && typeof part.text === "string",
    )
    if (text?.type === "text") return text.text.trim().slice(0, 500)
  }
}

function latestToolResults(messages: MessageV2.WithParts[]) {
  const results: string[] = []
  for (let i = messages.length - 1; i >= 0 && results.length < 3; i--) {
    const message = messages[i]
    if (message.info.role !== "assistant") continue
    for (let j = message.parts.length - 1; j >= 0 && results.length < 3; j--) {
      const part = message.parts[j]
      if (part.type !== "tool") continue
      const label =
        part.state.status === "completed"
          ? `${part.tool}:${part.state.title ?? "completed"}`
          : `${part.tool}:${part.state.status}`
      results.push(label)
    }
  }
  return results
}

export function buildSmartRunnerGovernorContext(input: {
  session: Pick<Session.Info, "workflow">
  todos: Todo.Info[]
  roundCount: number
  deterministicDecision: DeterministicContinueDecision
  messages: MessageV2.WithParts[]
  pendingApprovals?: number
  pendingQuestions?: number
  activeSubtasks?: number
}): GovernorContextPack {
  const actionable = input.todos.filter((todo) => {
    if (todo.status === "in_progress") return true
    return todo.status === "pending" && Todo.isDependencyReady(todo, input.todos)
  })
  const blocked = input.todos.filter((todo) => todo.status === "pending" && !Todo.isDependencyReady(todo, input.todos))
  return {
    goal: latestUserGoal(input.messages, input.deterministicDecision.todo),
    workflow: {
      state: input.session.workflow?.state ?? "waiting_user",
      autonomous: !!input.session.workflow?.autonomous.enabled,
      roundCount: input.roundCount,
      stopReason: input.session.workflow?.stopReason,
    },
    todos: {
      inProgress: input.todos
        .filter((todo) => todo.status === "in_progress")
        .map((todo) => ({ id: todo.id, content: todo.content })),
      actionable: actionable.map((todo) => ({ id: todo.id, content: todo.content })),
      blocked: blocked.map((todo) => ({
        id: todo.id,
        content: todo.content,
        waitingOn: todo.action?.waitingOn,
      })),
    },
    recentProgress: {
      lastNarration: latestNarration(input.messages),
      latestAssistantSummary: latestAssistantSummary(input.messages),
      latestToolResults: latestToolResults(input.messages),
    },
    docs: {
      architectureSlice: undefined,
      eventSlice: undefined,
    },
    health: {
      pendingApprovals: input.pendingApprovals ?? 0,
      pendingQuestions: input.pendingQuestions ?? 0,
      activeSubtasks: input.activeSubtasks ?? 0,
      budget: "unknown",
    },
    deterministicPlan: {
      reason: input.deterministicDecision.reason,
      todoID: input.deterministicDecision.todo.id,
      todoContent: input.deterministicDecision.todo.content,
      continueText: input.deterministicDecision.text,
    },
  }
}

async function runGovernorModel(input: { model: Provider.Model; context: GovernorContextPack }) {
  const language = await ProviderRegistry.getLanguage(input.model)
  const params = {
    model: language,
    temperature: 0,
    schema: SmartRunnerDecisionSchema,
    messages: [
      { role: "system", content: SMART_RUNNER_GOVERNOR_PROMPT } satisfies ModelMessage,
      {
        role: "user",
        content:
          "Evaluate this autonomous session context pack in dry-run mode and return the best structured governance decision.\n\n" +
          JSON.stringify(input.context, null, 2),
      } satisfies ModelMessage,
    ],
  } satisfies Parameters<typeof generateObject>[0]

  if (input.model.providerId === "openai" && (await Auth.get(input.model.providerId))?.type === "oauth") {
    const result = streamObject({
      ...params,
      providerOptions: ProviderTransform.providerOptions(input.model, {
        instructions: SMART_RUNNER_GOVERNOR_PROMPT,
        store: false,
      }),
      onError: () => {},
    })
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error
    }
    return result.object
  }

  const result = await generateObject(params)
  return result.object
}

export async function evaluateSmartRunnerGovernorDryRun(input: {
  sessionID: string
  model: Provider.Model
  enabled?: boolean
  todos: Todo.Info[]
  roundCount: number
  deterministicDecision: DeterministicContinueDecision
  messages: MessageV2.WithParts[]
  pendingApprovals?: number
  pendingQuestions?: number
  activeSubtasks?: number
}): Promise<SmartRunnerTrace> {
  const createdAt = Date.now()
  if (
    !shouldRunSmartRunnerGovernorDryRun({
      enabled: input.enabled,
      decision: input.deterministicDecision,
    })
  ) {
    return SmartRunnerTraceSchema.parse({
      source: "smart_runner_governor",
      dryRun: true,
      status: "disabled",
      createdAt,
      deterministicReason: input.deterministicDecision.reason,
      model: {
        providerId: input.model.providerId,
        modelID: input.model.id,
      },
    })
  }

  const session = await Session.get(input.sessionID)
  const context = buildSmartRunnerGovernorContext({
    session,
    todos: input.todos,
    roundCount: input.roundCount,
    deterministicDecision: input.deterministicDecision,
    messages: input.messages,
    pendingApprovals: input.pendingApprovals,
    pendingQuestions: input.pendingQuestions,
    activeSubtasks: input.activeSubtasks,
  })

  try {
    const decision = await runGovernorModel({
      model: input.model,
      context,
    })
    return SmartRunnerTraceSchema.parse({
      source: "smart_runner_governor",
      dryRun: true,
      status: "advisory",
      createdAt,
      deterministicReason: input.deterministicDecision.reason,
      model: {
        providerId: input.model.providerId,
        modelID: input.model.id,
      },
      context,
      decision,
    })
  } catch (error) {
    return SmartRunnerTraceSchema.parse({
      source: "smart_runner_governor",
      dryRun: true,
      status: "error",
      createdAt,
      deterministicReason: input.deterministicDecision.reason,
      model: {
        providerId: input.model.providerId,
        modelID: input.model.id,
      },
      context,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function persistSmartRunnerGovernorTrace(input: { sessionID: string; trace: SmartRunnerTrace }) {
  const session = await Session.get(input.sessionID)
  const currentHistory = session.workflow?.supervisor?.governorTraceHistory ?? []
  const nextHistory = [...currentHistory, input.trace].slice(-SMART_RUNNER_TRACE_HISTORY_LIMIT)
  await Session.updateWorkflowSupervisor({
    sessionID: input.sessionID,
    patch: {
      lastGovernorTraceAt: input.trace.createdAt,
      lastGovernorTrace: input.trace,
      governorTraceHistory: nextHistory,
    },
  })
}

export async function getSmartRunnerConfig() {
  const config = await Config.get()
  return {
    enabled: config.experimental?.smart_runner?.enabled === true,
    assist: config.experimental?.smart_runner?.assist === true,
  }
}
