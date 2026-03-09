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
  decision: z.enum(["continue", "replan", "ask_user", "pause", "complete", "docs_sync_first", "debug_preflight_first"]),
  reason: z.string(),
  nextAction: z.object({
    kind: z.enum([
      "continue_current",
      "start_next_todo",
      "replan_todos",
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
      kind: z.enum(["replan", "ask_user"]),
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
      replanRequest: z
        .object({
          targetTodoID: z.string().optional(),
          requestedAction: z.string().optional(),
          proposedNextStep: z.string().optional(),
          note: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  error: z.string().optional(),
})

export type SmartRunnerTrace = z.infer<typeof SmartRunnerTraceSchema>
const SMART_RUNNER_TRACE_HISTORY_LIMIT = 5
const SMART_RUNNER_LABEL = "[AI]"

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
  if (!["replan", "ask_user"].includes(input.trace.decision.decision)) return input.trace

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

  return SmartRunnerTraceSchema.parse({
    ...input.trace,
    suggestion: {
      kind: input.trace.decision.decision,
      reason: input.trace.decision.reason,
      suggestedTodoID: input.trace.decision.nextAction.todoID,
      suggestedAction: input.trace.decision.nextAction.kind,
      draftQuestion,
      askUserHandoff,
      replanRequest,
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
