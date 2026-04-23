import z from "zod"
import { type Tool as AITool, jsonSchema, tool } from "ai"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { debugCheckpoint } from "@/util/debug"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { SessionCompaction } from "./compaction"
import { SharedContext } from "./shared-context"
import { Config } from "@/config/config"
import { Instance } from "../project/instance"
import { Todo } from "./todo"
import { Bus } from "../bus"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { clone } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { Command } from "../command"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { resolveTools } from "./resolve-tools"
import { resolveImageRequest, stripImageParts } from "./image-router"
import { TaskTool } from "@/tool/task"
import { ToolInvoker } from "./tool-invoker"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { SessionStatus } from "./status"
import {
  assertNotBusy as assertNotBusyRuntime,
  start as startRuntime,
  cancel as cancelRuntime,
  finish as finishRuntime,
  enqueueCallback,
  consumeCallbacks,
  waitForSlot as waitForRuntimeSlot,
  type CancelReason,
} from "./prompt-runtime"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { runShellPrompt } from "./shell-runner"
import { getPreloadedContext } from "./preloaded-context"
import { insertReminders } from "./reminders"
import { ensureTitle } from "./title-manager"
import { resolvePromptParts as resolvePromptPartsInner } from "./prompt-part-resolver"
import { renderCommandTemplate } from "./command-template"
import { executeHandledCommand } from "./command-handler-executor"
import { prepareCommandPrompt } from "./command-prompt-prep"
import { dispatchCommandPrompt } from "./command-dispatcher"
import { persistUserMessage } from "./user-message-persist"
import { prepareUserMessageContext } from "./user-message-context"
import { buildUserMessageParts } from "./user-message-parts"
import { materializeToolAttachments } from "./attachment-ownership"
import { emitSessionNarration, isNarrationAssistantMessage } from "./narration"
import {
  decideAutonomousContinuation,
  describeAutonomousNextAction,
  clearPendingContinuation,
  collectCompletedSubagents,
  enqueueAutonomousContinue,
  getPendingContinuation,
  shouldInterruptAutonomousRun,
} from "./workflow-runner"
import { resolveDialogTriggerPolicy } from "./dialog-trigger"
import { RebindEpoch } from "./rebind-epoch"
import { CapabilityLayer } from "./capability-layer"
import { registerProductionCapabilityLoader } from "./capability-layer-loader"

// Production capability-layer loader is registered once per process. The
// context resolver reads runtime-known fields (agent, isSubagent) from the
// session the loader is asked to serve. prompt.ts is a natural bootstrap
// location because every LLM round flows through this module.
let _capabilityLoaderRegistered = false
/**
 * responsive-orchestrator DD-3 / DD-3.1 — render one PendingSubagentNotice
 * into a one-line system-prompt addendum. Main agent consumes this string
 * as part of its system message on the next turn; the user never sees it.
 *
 * Format design (keep LLM-friendly, human-parseable, stable wording):
 *   [subagent <childSessionID> finished status=<status> elapsed=<seconds>s<extras>]
 *
 * extras:
 *   rate_limited → errorDetail.resetsInSeconds
 *   quota_low    → rotateHint.exhaustedAccountId + remainingPercent
 *                  + explicit "rotate before next dispatch" instruction
 *   cancelled    → cancelReason (echo)
 */
function renderNoticeAddendum(n: MessageV2.PendingSubagentNotice): string {
  const elapsedSec = Math.round(n.elapsedMs / 1000)
  const base = `[subagent ${n.childSessionID} finished status=${n.status} finish=${n.finish} elapsed=${elapsedSec}s`
  const tail: string[] = []
  if (n.status === "rate_limited" && n.errorDetail?.resetsInSeconds) {
    tail.push(`resets_in_seconds=${n.errorDetail.resetsInSeconds}`)
  }
  if (n.status === "quota_low" && n.rotateHint) {
    tail.push(`exhaustedAccount=${n.rotateHint.exhaustedAccountId}`)
    if (typeof n.rotateHint.remainingPercent === "number") {
      tail.push(`remainingPercent=${n.rotateHint.remainingPercent}`)
    }
    tail.push(`directive=${n.rotateHint.directive}`)
  }
  if (n.status === "cancelled" && n.cancelReason) {
    tail.push(`reason=${JSON.stringify(n.cancelReason)}`)
  }
  const tailStr = tail.length > 0 ? " " + tail.join(" ") : ""
  const hint =
    n.status === "quota_low"
      ? " Switch to a different account before any further dispatch; read the child session for the wrap-up summary."
      : n.status === "rate_limited"
        ? " The account is rate-limited; pick a different account or wait for reset before redispatching."
        : n.status === "worker_dead" || n.status === "silent_kill"
          ? " The subagent did not complete cleanly; read the child session for any partial progress before deciding recovery."
          : ""
  return `${base}${tailStr}]${hint}`
}

function ensureCapabilityLoaderRegistered() {
  if (_capabilityLoaderRegistered) return
  _capabilityLoaderRegistered = true
  registerProductionCapabilityLoader(async (sessionID) => {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session) return undefined
    // Agent selection: prefer the session's latest user-message agent; fall
    // back to "main" for silent refresh (where no user message exists).
    const stream = MessageV2.stream(sessionID)
    let agentName: string | undefined
    try {
      for await (const item of stream) {
        if (item.info.role === "user") {
          agentName = (item.info as MessageV2.User).agent
        }
      }
    } catch {
      // best-effort; silent-refresh path lacks a recent user message
    }
    return {
      sessionID,
      epoch: RebindEpoch.current(sessionID),
      agent: { name: agentName ?? (session.parentID ? "coding" : "main") },
      isSubagent: !!session.parentID,
    }
  })
}

globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  const PLAN_ENFORCEMENT_ALLOWED_PROGRESS_PATTERNS = [
    /^(progress|status|current plan|current goal|resolved decisions|remaining open questions|next step)/i,
    /^(I (have|will|am)|We (have|will|are))/i,
  ]

  const PLAN_DECISION_QUESTION_PATTERNS = [
    /\?$/,
    /\b(should|which|what should|do you want|would you like|prefer|pick|choose|A or B|name|naming)\b/i,
    /還是|或者|要不要|是否|命名|選哪|哪個/i,
  ]

  const PLAN_DECISION_KEYWORDS = [
    "scope",
    "priority",
    "approval",
    "validation",
    "delegate",
    "delegation",
    "risk",
    "naming",
    "model",
    "provider",
    "account",
    "session-local",
    "global",
    "範圍",
    "優先",
    "批准",
    "驗證",
    "委派",
    "風險",
    "命名",
    "provider",
    "account",
    "model",
  ]

  export function classifyPlanModeAssistantTurn(input: {
    agentName: string
    finish?: string
    parts: MessageV2.WithParts["parts"]
  }) {
    if (input.agentName !== "plan")
      return { enforced: false as const, violation: false as const, reason: "not_plan" as const }

    const toolParts = input.parts.filter((part) => part.type === "tool")
    const hasQuestionTool = toolParts.some((part) => part.tool === "question")
    if (hasQuestionTool || input.finish === "tool-calls") {
      return {
        enforced: true as const,
        violation: false as const,
        reason: hasQuestionTool ? ("question_tool" as const) : ("tool_calls" as const),
      }
    }

    const textParts = input.parts.filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    const text = textParts
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim()
    if (!text) return { enforced: true as const, violation: false as const, reason: "empty_text" as const }

    const looksLikeProgress = PLAN_ENFORCEMENT_ALLOWED_PROGRESS_PATTERNS.some((pattern) => pattern.test(text))
    const looksLikeDecisionQuestion =
      PLAN_DECISION_QUESTION_PATTERNS.some((pattern) => pattern.test(text)) &&
      PLAN_DECISION_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()))

    if (looksLikeDecisionQuestion) {
      return {
        enforced: true as const,
        violation: true as const,
        reason: "plain_text_decision_question" as const,
        text,
      }
    }

    if (text.includes("?") && !looksLikeProgress) {
      return {
        enforced: true as const,
        violation: true as const,
        reason: "plain_text_question" as const,
        text,
      }
    }

    return {
      enforced: true as const,
      violation: false as const,
      reason: looksLikeProgress ? ("progress_summary" as const) : ("non_question_text" as const),
    }
  }

  export function assertNotBusy(sessionID: string) {
    return assertNotBusyRuntime(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerId: z.string(),
        modelID: z.string(),
        accountId: z.string().optional(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    autonomous: z.boolean().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    // Ensure workflow exists; reset completed sessions to idle without force-enabling autorun
    await Session.update(
      input.sessionID,
      (draft) => {
        const current = draft.workflow ?? Session.defaultWorkflow(draft.time.updated)
        if (!draft.workflow || current.state === "completed") {
          draft.workflow = {
            ...current,
            state: current.state === "completed" ? "idle" : current.state,
            stopReason: undefined,
            updatedAt: Date.now(),
          }
        }
      },
      { touch: false },
    )

    const message = await createUserMessage(input, session)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.update(session.id, (draft) => {
        draft.permission = permissions
      })
    }

    if (input.noReply === true) {
      return message
    }

    const shouldReplaceRuntime = await shouldInterruptForIncomingPrompt(input.sessionID)
    if (shouldReplaceRuntime) {
      await emitSessionNarration({
        sessionID: input.sessionID,
        parentID: message.info.id,
        agent: message.info.agent,
        variant: message.info.variant,
        model: message.info.model,
        text: "Interrupted the previous autonomous run and replanning around your latest message.",
        kind: "interrupt",
      })
    }
    return runLoop(input.sessionID, { replaceRuntime: shouldReplaceRuntime, incomingModel: input.model })
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    return (await resolvePromptPartsInner(template)) as PromptInput["parts"]
  }

  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    const { $schema, ...toolSchema } = input.schema
    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as Record<string, unknown>),
      async execute(args) {
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        return {
          type: "text",
          value: result.output,
        }
      },
    })
  }

  function start(sessionID: string, options?: { replace?: boolean }) {
    return startRuntime(sessionID, options)
  }

  export function cancel(sessionID: string, reason: CancelReason) {
    log.info("cancel", { sessionID, reason })
    cancelRuntime(sessionID, reason)
    void clearPendingContinuation(sessionID).catch(() => undefined)
    void Session.setWorkflowState({
      sessionID,
      state: "waiting_user",
      // `manual_interrupt` remains the canonical workflow stop reason so the
      // NON_RESUMABLE_WAITING_REASONS gate continues to block auto-resume.
      // The `reason` argument is separately surfaced via the telemetry log
      // line above and via AbortSignal.reason inside prompt-runtime.cancel.
      stopReason: "manual_interrupt",
      lastRunAt: Date.now(),
    }).catch(() => undefined)
  }

  const emitAutonomousNarration = emitSessionNarration

  async function shouldInterruptForIncomingPrompt(sessionID: string) {
    const status = SessionStatus.get(sessionID)
    if (status.type !== "busy") return false
    const session = await Session.get(sessionID)
    const pending = await getPendingContinuation(sessionID)
    let lastUserSynthetic = false
    for await (const message of MessageV2.stream(sessionID)) {
      if (message.info.role !== "user") continue
      lastUserSynthetic =
        message.parts.length > 0 &&
        message.parts.every((part) => part.type !== "text" || part.synthetic === true || part.ignored === true)
      break
    }
    return shouldInterruptAutonomousRun({
      session,
      status,
      lastUserSynthetic,
      hasPendingContinuation: !!pending,
    })
  }

  export async function handleContinuationSideEffects(input: {
    sessionID: string
    user: MessageV2.User
    decision: Extract<Awaited<ReturnType<typeof decideAutonomousContinuation>>, { continue: true }>
    autonomousRounds: number
    enqueueContinue?: typeof enqueueAutonomousContinue
  }) {
    const enqueueContinue = input.enqueueContinue ?? enqueueAutonomousContinue
    const nextRoundCount = input.autonomousRounds + 1

    await enqueueContinue({
      sessionID: input.sessionID,
      user: input.user,
      roundCount: nextRoundCount,
      text: input.decision.text,
    })
    return {
      halted: false as const,
      nextRoundCount,
      narration: undefined,
    }
  }

  export function resolveTerminalContinuationStopState(
    decision: Extract<Awaited<ReturnType<typeof decideAutonomousContinuation>>, { continue: false }>,
  ) {
    if (decision.reason === "todo_complete") {
      return {
        state: "completed" as const,
        stopReason: "todo_complete" as const,
      }
    }

    return {
      state: "waiting_user" as const,
      stopReason: decision.reason,
    }
  }

  export function buildSmartRunnerQuestion(input: { questionText?: string }) {
    const questionText = input.questionText?.trim()
    if (!questionText) return undefined
    return {
      question: questionText,
      header: "Decision needed",
      options: [],
      custom: true,
    } satisfies Question.Info
  }

  export function formatSmartRunnerQuestionAnswers(input: {
    question: Pick<Question.Info, "question">
    answers: Array<{ answer?: string[] }>
  }) {
    const answerText =
      input.answers
        .flatMap((item) => item.answer ?? [])
        .filter(Boolean)
        .join(", ") || "Unanswered"
    return `User answered Smart Runner question "${input.question.question}" with: ${answerText}. Continue with this answer in mind.`
  }

  function prefixAINarration(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return "[AI]"
    return trimmed.startsWith("[AI]") ? trimmed : `[AI] ${trimmed}`
  }

  async function persistSmartRunnerTrace(input: {
    sessionID: string
    trace: any
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
  }) {
    if (!input.persistTrace) return
    await input.persistTrace({
      sessionID: input.sessionID,
      trace: clone(input.trace),
    })
  }

  export async function handleSmartRunnerAskUserAdoption(input: {
    sessionID: string
    question: Question.Info
    trace: any
    lastUser: Pick<MessageV2.User, "agent" | "model" | "variant" | "format"> & { id?: string }
    ask?: (input: { sessionID: string; question: Question.Info }) => Promise<Question.Answer[]>
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    updateMessage?: (message: any) => Promise<unknown>
    updatePart?: (part: any) => Promise<unknown>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    const ask =
      input.ask ??
      (async ({ sessionID, question }: { sessionID: string; question: Question.Info }) =>
        Question.ask({ sessionID, questions: [question] }))
    const updateMessage = input.updateMessage ?? Session.updateMessage
    const updatePart = input.updatePart ?? Session.updatePart
    const setWorkflowState = input.setWorkflowState ?? Session.setWorkflowState

    try {
      const answers = await ask({ sessionID: input.sessionID, question: input.question })
      await persistSmartRunnerTrace(input)

      const userMessage: MessageV2.User = {
        id: Identifier.ascending("message"),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.lastUser.agent,
        model: input.lastUser.model,
        variant: input.lastUser.variant,
        format: input.lastUser.format,
      }
      await updateMessage(userMessage)
      await updatePart({
        id: Identifier.ascending("part"),
        messageID: userMessage.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: formatSmartRunnerQuestionAnswers({
          question: input.question,
          answers: [{ answer: answers[0] }],
        }),
      })
      return { outcome: "answered" as const }
    } catch (error) {
      if (!(error instanceof Question.RejectedError)) throw error
      await persistSmartRunnerTrace(input)
      await persistSmartRunnerTrace(input)
      await setWorkflowState({
        sessionID: input.sessionID,
        state: "waiting_user",
        stopReason: "product_decision_needed",
      })
      return { outcome: "rejected" as const }
    }
  }

  export async function handleSmartRunnerApprovalRequest(input: {
    sessionID: string
    trace: any
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    await persistSmartRunnerTrace(input)
    await (input.setWorkflowState ?? Session.setWorkflowState)({
      sessionID: input.sessionID,
      state: "waiting_user",
      stopReason: "approval_needed",
    })
    return { outcome: "requested" as const }
  }

  export async function handleSmartRunnerRiskPause(input: {
    sessionID: string
    trace: any
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    await persistSmartRunnerTrace(input)
    await (input.setWorkflowState ?? Session.setWorkflowState)({
      sessionID: input.sessionID,
      state: "waiting_user",
      stopReason: "risk_review_needed",
    })
    return { outcome: "paused" as const }
  }

  export async function handleSmartRunnerCompletionAdoption(input: {
    sessionID: string
    todos: Todo.Info[]
    suggestion: any
    roundCount: number
    updateTodos: (input: any) => Promise<unknown>
    decideContinuation: (input: { sessionID: string; roundCount: number }) => Promise<any>
    setWorkflowState?: typeof Session.setWorkflowState
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    trace: any
  }) {
    const adopted = Todo.applyHostAdoptedCompletion(input.todos, input.suggestion.completionRequest)
    const trace = clone(input.trace)
    if (trace?.suggestion?.completionRequest) {
      trace.suggestion.completionRequest.hostAdopted = adopted.adopted
      trace.suggestion.completionRequest.hostAdoptionReason = adopted.reason
    }
    await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
    if (!adopted.adopted) return adopted

    await input.updateTodos({ sessionID: input.sessionID, todos: adopted.todos, mode: "status_update" })
    const decision = await input.decideContinuation({ sessionID: input.sessionID, roundCount: input.roundCount })
    if (decision.continue) {
      return {
        adopted: false as const,
        reason: "not_terminal_after_completion" as const,
        decision,
        todos: adopted.todos,
      }
    }
    await (input.setWorkflowState ?? Session.setWorkflowState)({
      sessionID: input.sessionID,
      state: "completed",
      stopReason: decision.reason,
    })
    return {
      adopted: true as const,
      reason: "adopted" as const,
      outcome: "completed" as const,
      decision,
      todos: adopted.todos,
    }
  }

  export async function handleSmartRunnerReplanAdoption(input: {
    sessionID: string
    todos: Todo.Info[]
    suggestion: any
    roundCount: number
    fallbackDecision: any
    updateTodos: (input: any) => Promise<unknown>
    decideContinuation: (input: { sessionID: string; roundCount: number }) => Promise<any>
  }) {
    const adopted = Todo.applyHostAdoptedReplan(input.todos, input.suggestion.replanAdoption)
    if (!adopted.adopted) return { ...adopted, decision: input.fallbackDecision }
    await input.updateTodos({ sessionID: input.sessionID, todos: adopted.todos, mode: "status_update" })
    const decision = await input.decideContinuation({ sessionID: input.sessionID, roundCount: input.roundCount })
    return {
      adopted: true as const,
      reason: "adopted" as const,
      decision,
      todos: adopted.todos,
    }
  }

  export async function handleSmartRunnerContinuationSideEffects(
    input: Parameters<typeof handleContinuationSideEffects>[0],
  ) {
    // Runner silent: no narration emitted
    // The autonomous runner operates silently in the background
    const enqueueContinue = input.enqueueContinue ?? enqueueAutonomousContinue
    const nextRoundCount = input.autonomousRounds + 1
    await enqueueContinue({
      sessionID: input.sessionID,
      user: input.user,
      roundCount: nextRoundCount,
      text: input.decision.text,
    })
    return {
      halted: false as const,
      nextRoundCount,
      narration: undefined, // Runner no longer emits narration
    }
  }

  export async function handleSmartRunnerAdoptedStopNarration(input: {
    sessionID: string
    user: Pick<MessageV2.User, "id" | "agent" | "variant" | "model">
    text: string
    kind?: "pause" | "complete"
    emitNarration?: typeof emitAutonomousNarration
  }) {
    await (input.emitNarration ?? emitAutonomousNarration)({
      sessionID: input.sessionID,
      parentID: input.user.id,
      agent: input.user.agent,
      variant: input.user.variant,
      model: input.user.model,
      kind: input.kind ?? "pause",
      text: prefixAINarration(input.text),
    })
    return { emitted: true as const }
  }

  export async function handleSmartRunnerStopDecision(input: {
    sessionID: string
    activeModel: any
    autonomousRounds: number
    lastUser: MessageV2.User
    messages: MessageV2.WithParts[]
    todos: Todo.Info[]
    decision: any
    getConfig: () => Promise<{ enabled?: boolean; assist?: boolean }>
    evaluateGovernor: (input: any) => Promise<any>
    listQuestions: () => Promise<any[]>
    askUser?: (input: any) => Promise<any>
    requestApproval?: (input: any) => Promise<any>
    pauseForRisk?: (input: any) => Promise<any>
    completePath?: (input: any) => Promise<any>
    replan?: (input: any) => Promise<any>
    persistTrace?: (input: { sessionID: string; trace: any }) => Promise<unknown>
    applyAssist?: (input: any) => any
  }) {
    const config = await input.getConfig()
    if (!config.enabled) return { kind: "continue" as const, continueDecision: input.decision }

    const trace = await input.evaluateGovernor({
      sessionID: input.sessionID,
      activeModel: input.activeModel,
      autonomousRounds: input.autonomousRounds,
      lastUser: input.lastUser,
      messages: input.messages,
      todos: input.todos,
      decision: input.decision,
    })

    if (
      trace.suggestion?.approvalRequest?.policy?.adoptionMode &&
      trace.suggestion.approvalRequest.policy.adoptionMode !== "host_adoptable"
    ) {
      trace.suggestion.approvalRequest.hostAdoptionReason = "policy_not_host_adoptable"
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
      return { kind: "continue" as const, continueDecision: input.decision }
    }

    if (
      trace.suggestion?.riskPauseRequest?.policy?.adoptionMode &&
      trace.suggestion.riskPauseRequest.policy.adoptionMode !== "host_adoptable"
    ) {
      trace.suggestion.riskPauseRequest.hostAdoptionReason = "policy_not_host_adoptable"
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
      return { kind: "continue" as const, continueDecision: input.decision }
    }

    const governorDecision = trace.decision?.decision
    if (governorDecision === "ask_user") {
      const question = buildSmartRunnerQuestion({
        questionText: trace.decision?.nextAction?.narration ?? trace.decision?.reason,
      })
      const outcome = await input.askUser?.({
        sessionID: input.sessionID,
        question,
        trace,
        lastUser: input.lastUser,
      })
      return { kind: "ask_user" as const, adopted: true as const, ...outcome }
    }

    if (governorDecision === "request_approval") {
      const outcome = await input.requestApproval?.({ sessionID: input.sessionID, trace })
      return { kind: "request_approval" as const, adopted: true as const, ...outcome }
    }

    if (governorDecision === "pause_for_risk") {
      const outcome = await input.pauseForRisk?.({ sessionID: input.sessionID, trace })
      return { kind: "pause_for_risk" as const, adopted: true as const, ...outcome }
    }

    if (governorDecision === "complete") {
      const outcome = await input.completePath?.({ sessionID: input.sessionID, trace })
      return { kind: "complete" as const, adopted: true as const, ...outcome }
    }

    let continueDecision = input.decision
    if (input.replan) {
      const replanned = await input.replan({
        sessionID: input.sessionID,
        todos: input.todos,
        roundCount: input.autonomousRounds,
        trace,
      })
      continueDecision = replanned?.decision ?? continueDecision
    }

    if (input.applyAssist && config.assist) {
      const assisted = input.applyAssist({
        trace,
        decision: continueDecision,
        todos: input.todos,
      })
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
      if (assisted?.applied && assisted.decision) {
        return {
          kind: "continue" as const,
          narrationOverride: assisted.narration ? prefixAINarration(assisted.narration) : undefined,
          continueDecision: {
            ...assisted.decision,
            text: prefixAINarration(assisted.decision.text),
          },
        }
      }
    }

    if (input.persistTrace) {
      await persistSmartRunnerTrace({ sessionID: input.sessionID, trace, persistTrace: input.persistTrace })
    }
    return { kind: "continue" as const, continueDecision }
  }

  async function runLoop(
    sessionID: string,
    options?: {
      replaceRuntime?: boolean
      incomingModel?: { providerId: string; modelID: string }
    },
  ) {
    // Race-condition fix: previously, when start() returned undefined because
    // a runloop was still in its post-reply cleanup window (SharedContext
    // update / compaction / pruning — line ~1884-1932), we would enqueue a
    // result-callback that later got drained at the end of the OLD runloop
    // and resolved with the OLD runloop's assistant reply. That silently
    // absorbed the new user message: "here's the reply" the daemon thought
    // it was serving was actually a reply to a different, older prompt.
    // User-visible symptom: first prompt typed right after a runloop just
    // finished got no response, probabilistic with the exact typing timing.
    //
    // Fix: wait for the current runtime slot to release, then start our own
    // runloop against the user message we were invoked for. Bounded retry
    // with replace-on-last-resort so a pathological never-finish runtime
    // can't livelock a fresh prompt.
    let runtime = start(sessionID, { replace: options?.replaceRuntime })
    if (!runtime) {
      for (let attempt = 0; attempt < 3 && !runtime; attempt++) {
        await waitForRuntimeSlot(sessionID)
        runtime = start(sessionID)
      }
      if (!runtime) {
        log.warn("runLoop: slot never opened after waits — forcing replace", { sessionID })
        runtime = start(sessionID, { replace: true })
      }
      if (!runtime) {
        // Absolute last resort: the enqueue path. This should be
        // essentially unreachable, but keep it so a pathological state
        // never blocks the caller silently.
        return new Promise<MessageV2.WithParts>((resolve, reject) => {
          enqueueCallback(sessionID, { resolve, reject })
        })
      }
    }

    const abort = runtime!.signal
    using _ = defer(() => finishRuntime(sessionID, runtime!.runID))

    let structuredOutput: unknown | undefined

    let step = 0
    let autonomousRounds = 0
    let lastDecisionReason: Awaited<ReturnType<typeof decideAutonomousContinuation>>["reason"] | undefined
    let emptyRoundCount = 0
    let consecutiveCompactions = 0
    const session = await Session.get(sessionID)
    const cachedInstructionPrompts = await InstructionPrompt.system()
    const environmentCache = new Map<string, string[]>()

    // Context Sharing v3: lightweight parent context for child sessions.
    // Priority: checkpoint → SharedContext snapshot → last 10 rounds.
    // Subagents always receive a task instruction, so parent context is
    // supplementary — full history is wasteful and risks overflow.
    const PARENT_CONTEXT_MAX_ROUNDS = 10
    let parentMessagePrefix: MessageV2.WithParts[] | undefined
    let parentContextSource: "checkpoint" | "shared_context" | "recent_history" | "none" = "none"
    if (session.parentID) {
      // Priority 1: checkpoint-based reduction (~4K tokens)
      const checkpoint = await SessionCompaction.loadRebindCheckpoint(session.parentID)
      if (checkpoint) {
        const parentFiltered = await MessageV2.filterCompacted(MessageV2.stream(session.parentID))
        const parentSession = await Session.get(session.parentID).catch(() => undefined)
        const exec = parentSession?.execution
        const stubModel = {
          id: exec?.modelID ?? "unknown",
          providerId: exec?.providerId ?? "unknown",
        } as Provider.Model
        const result = SessionCompaction.applyRebindCheckpoint({
          sessionID: session.parentID,
          checkpoint,
          messages: parentFiltered.messages,
          model: stubModel,
        })
        if (result.applied) {
          parentMessagePrefix = result.messages
          parentContextSource = "checkpoint"
          log.info("context sharing: checkpoint applied", {
            sessionID,
            parentID: session.parentID,
            fullCount: parentFiltered.messages.length,
            reducedCount: parentMessagePrefix.length,
          })
        }
      }

      // Priority 2: SharedContext snapshot (structured summary, no message history)
      if (!parentMessagePrefix) {
        const snap = await SharedContext.snapshot(session.parentID)
        if (snap) {
          parentMessagePrefix = [
            {
              info: {
                id: Identifier.ascending("message"),
                role: "assistant" as const,
                sessionID: session.parentID,
                time: { created: Date.now() },
                summary: true,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
                modelID: "system",
                providerId: "system",
                agent: "system",
                variant: "normal" as const,
                path: { cwd: Instance.directory, root: Instance.worktree },
              } as MessageV2.Assistant,
              parts: [
                {
                  id: Identifier.ascending("part"),
                  messageID: "",
                  sessionID: session.parentID,
                  type: "text" as const,
                  text: `<parent_session_context source="shared_context">\n${snap}\n</parent_session_context>`,
                } as MessageV2.TextPart,
              ],
            },
          ]
          parentContextSource = "shared_context"
          log.info("context sharing: SharedContext snapshot used", {
            sessionID,
            parentID: session.parentID,
            snapshotChars: snap.length,
          })
        }
      }

      // Priority 3: last N rounds of parent history (bounded)
      if (!parentMessagePrefix) {
        const parentFiltered = await MessageV2.filterCompacted(MessageV2.stream(session.parentID))
        const allMsgs = parentFiltered.messages
        if (allMsgs.length > 0) {
          // Count rounds: each user→assistant pair is one round.
          // Take the last PARENT_CONTEXT_MAX_ROUNDS rounds from the end.
          let roundCount = 0
          let cutoffIndex = allMsgs.length
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            if (allMsgs[i].info.role === "user") {
              roundCount++
              if (roundCount >= PARENT_CONTEXT_MAX_ROUNDS) {
                cutoffIndex = i
                break
              }
            }
          }
          parentMessagePrefix = cutoffIndex === 0 ? allMsgs : allMsgs.slice(cutoffIndex)
          parentContextSource = "recent_history"
          log.info("context sharing: recent history fallback", {
            sessionID,
            parentID: session.parentID,
            fullCount: allMsgs.length,
            slicedCount: parentMessagePrefix.length,
            rounds: roundCount,
          })
        }
      }

      if (parentContextSource === "none") {
        log.info("context sharing: no parent context available", {
          sessionID,
          parentID: session.parentID,
        })
      }
    }

    debugCheckpoint("prompt", "loop:session_loaded", {
      sessionID,
      parentID: session.parentID,
      isSubagent: !!session.parentID,
      title: session.title,
    })

    // ── Pre-loop provider switch detection ──
    // Must run BEFORE the main loop to avoid the expensive filterCompacted scan
    // on a session whose entire history is incompatible with the new provider.
    // Uses incomingModel from the caller — zero storage reads needed.
    if (!session.parentID && session.execution?.providerId && options?.incomingModel) {
      const prevProvider = session.execution.providerId
      const nextProvider = options.incomingModel.providerId
      if (prevProvider !== nextProvider) {
        log.warn("provider switch detected (pre-loop), forcing context reinit", {
          sessionID,
          prevProvider,
          nextProvider,
        })
        // DD-4 order contract: bump rebind epoch FIRST (capability layer will
        // naturally cache-miss on next runLoop iteration and re-read fresh
        // AGENTS.md / driver / skills for the new provider). Only then can
        // compactWithSharedContext safely rebuild conversation-layer messages
        // with the new provider's context — capability layer must be fresh
        // before checkpoint apply.
        ensureCapabilityLoaderRegistered()
        await RebindEpoch.bumpEpoch({
          sessionID,
          trigger: "provider_switch",
          reason: `provider ${prevProvider} → ${nextProvider}`,
        })
        const model = await Provider.getModel(nextProvider, options.incomingModel.modelID).catch(() => undefined)
        if (model) {
          // Resolution chain: SharedContext (in-memory) → rebind checkpoint (disk) → minimal stub.
          // LLM compaction is NOT safe because old provider's tool call history is incompatible.
          const snap =
            (await SharedContext.snapshot(sessionID)) ??
            (await SessionCompaction.loadRebindCheckpoint(sessionID))?.snapshot
          SessionCompaction.recordCompaction(sessionID, 1)
          await SessionCompaction.compactWithSharedContext({
            sessionID,
            snapshot:
              snap ??
              `[Provider switched from ${prevProvider} to ${nextProvider}. Previous conversation context was not recoverable. The user may re-state their request.]`,
            model,
            auto: true,
          })
          log.info("provider switch compaction complete, entering main loop", { sessionID })
        }
      }
    }

    while (true) {
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break

      // ── Poll subagent mailbox ──────────────────────────────────
      // Dispatch and collect live in the same loop. Every iteration
      // checks if a dispatched subagent has completed.
      // The push path (task-worker-continuation) already persisted the
      // completion message in this session — we just consume the queue
      // entry so the supervisor doesn't also try to resume us, and set
      // a flag so the break logic below knows not to exit this iteration.
      const hasSubagentCompletion = !!(await collectCompletedSubagents(sessionID))
      if (hasSubagentCompletion) {
        log.info("loop: subagent completion collected from queue", { sessionID, step })
      }
      const filteredResult = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
      let msgs = filteredResult.messages
      if (filteredResult.stoppedByBudget) {
        log.warn("filterCompacted stopped by token budget guard", { sessionID, messageCount: msgs.length })
      }
      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      const processedCompactionParents = new Set<string>()
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.info.role === "assistant") {
          if (isNarrationAssistantMessage(msg.info, msg.parts)) continue
          if (msg.info.parentID) {
            processedCompactionParents.add(msg.info.parentID)
          }
          if (!lastAssistant) lastAssistant = msg.info as MessageV2.Assistant
          if (!lastFinished && msg.info.finish) lastFinished = msg.info as MessageV2.Assistant
        }
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part): part is MessageV2.CompactionPart | MessageV2.SubtaskPart => {
          if (part.type === "compaction-request") {
            // Prevent re-processing the same compaction request when a child assistant
            // message already exists (including failed/unfinished attempts).
            // Otherwise, a failed compaction can get stuck in a retry loop that keeps
            // spawning empty summary messages and blocks normal replies.
            return !processedCompactionParents.has(msg.info.id)
          }
          return part.type === "subtask"
        })
        if (task.length > 0 && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      const format = lastUser.format ?? { type: "text" }

      // Guard: detect empty-response loop (finish=unknown, 0 tokens).
      // The model returned nothing — retrying won't help. Break after 3 consecutive empty rounds.
      if (
        lastAssistant?.finish === "unknown" &&
        lastAssistant.tokens.input === 0 &&
        lastAssistant.tokens.output === 0 &&
        lastUser.id < lastAssistant.id
      ) {
        emptyRoundCount = (emptyRoundCount ?? 0) + 1
        if (emptyRoundCount >= 3) {
          log.warn("breaking empty-response loop", { sessionID, emptyRounds: emptyRoundCount, step })
          // Surface error to user instead of silent stop
          lastAssistant.error = new NamedError.Unknown({
            message: `Model returned empty responses ${emptyRoundCount} times consecutively. This may indicate an issue with the provider, account, or session context. Try sending a different message or starting a new session.`,
          }).toObject()
          lastAssistant.finish = "error"
          await Session.updateMessage(lastAssistant)
          break
        }
      } else {
        emptyRoundCount = 0
      }

      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id &&
        !hasSubagentCompletion
      ) {
        if (
          format.type === "json_schema" &&
          lastAssistant.structured === undefined &&
          !lastAssistant.error &&
          !["tool-calls", "unknown"].includes(lastAssistant.finish)
        ) {
          lastAssistant.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(lastAssistant)
        }
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerId: lastUser.model.providerId,
          history: msgs,
        })

      // Respect session's pinned execution identity (set by rotation3d after rate-limit fallback).
      // Without this, each tool-loop iteration re-resolves to the original (rate-limited) model,
      // causing a retry storm as rotation fires on every iteration.
      const sessionExec = step > 1 ? (await Session.get(sessionID).catch(() => undefined))?.execution : undefined
      const effectiveProviderId = sessionExec?.providerId ?? lastUser.model.providerId
      const effectiveModelID = sessionExec?.modelID ?? lastUser.model.modelID
      const effectiveAccountId = sessionExec?.accountId ?? lastUser.model.accountId
      const model = await Provider.getModel(effectiveProviderId, effectiveModelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerId}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })

      if (step === 1 && !session.parentID) {
        try {
          const checkpoint = await SessionCompaction.loadRebindCheckpoint(sessionID)
          if (checkpoint) {
            const boundaryIndex = msgs.findIndex((message) => message.info.id === checkpoint.lastMessageId)
            const postBoundary = boundaryIndex === -1 ? [] : msgs.slice(boundaryIndex + 1)
            debugCheckpoint("prompt", "loop:rebind_checkpoint_loaded", {
              sessionID,
              step,
              boundaryId: checkpoint.lastMessageId,
              boundaryFound: boundaryIndex !== -1,
              postBoundaryCount: postBoundary.length,
              postBoundaryFirstId: postBoundary[0]?.info.id,
              postBoundaryLastId: postBoundary.at(-1)?.info.id,
            })
            const applied = SessionCompaction.applyRebindCheckpoint({
              sessionID,
              checkpoint,
              messages: msgs,
              model,
            })
            const skipReason = "reason" in applied ? applied.reason : undefined
            if (!applied.applied) {
              debugCheckpoint("prompt", "loop:rebind_checkpoint_skipped", {
                sessionID,
                step,
                reason: skipReason,
                boundaryId: checkpoint.lastMessageId,
                postBoundaryCount: postBoundary.length,
              })
              log.warn("rebind checkpoint skipped", {
                sessionID,
                reason: skipReason,
                boundaryId: checkpoint.lastMessageId,
              })
            } else {
              msgs = applied.messages
              // Checkpoint is persistent — new compactions overwrite it, not consumed on read.
              debugCheckpoint("prompt", "loop:rebind_checkpoint_applied", {
                sessionID,
                step,
                boundaryId: checkpoint.lastMessageId,
                messageCount: msgs.length,
                postBoundaryCount: postBoundary.length,
              })
              log.info("rebind checkpoint applied", {
                sessionID,
                boundaryId: checkpoint.lastMessageId,
                messageCount: msgs.length,
              })
            }
          }
        } catch (error) {
          log.warn("failed to apply rebind checkpoint", { sessionID, error: String(error) })
        }
      }
      const task = tasks.pop()
      // pending subtask (invocation routed via ToolInvoker)
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerId, task.model.modelID) : model
        const sessionExecution = (await Session.get(sessionID).catch(() => undefined))?.execution
        const taskAccountId =
          task.model?.providerId === (sessionExecution?.providerId ?? lastUser.model.providerId)
            ? (sessionExecution?.accountId ?? lastUser.model.accountId)
            : task.model?.accountId
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerId: taskModel.providerId,
          accountId: taskAccountId,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        const taskPromptInput = task.prompt_input ?? task.prompt
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: taskPromptInput,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
              model: task.model ? `${task.model.providerId}/${task.model.modelID}` : undefined,
              account_id: taskAccountId,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const result = await ToolInvoker.execute(TaskTool, {
          sessionID,
          messageID: assistantMessage.id,
          toolID: TaskTool.id,
          args: {
            prompt: taskPromptInput,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
            model: task.model ? `${task.model.providerId}/${task.model.modelID}` : undefined,
            account_id: taskAccountId,
          },
          agent: task.agent,
          abort,
          messages: msgs,
          extra: { bypassAgentCheck: true },
          callID: part.callID,
          onMetadata: async (val) => {
            // Persist metadata (including child sessionId) so frontend can render SubagentActivityCard
            if (part.state.status === "running") {
              part = (await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  title: val.title,
                  metadata: val.metadata,
                },
              })) as MessageV2.ToolPart
            }
          },
          onAsk: async (req) => {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          const attachments = materializeToolAttachments(result.attachments, {
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
          })
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
            variant: lastUser.variant,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction-request") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
        })
        debugCheckpoint("prompt", "loop:compaction_done", {
          sessionID,
          step,
          result,
          auto: task.auto,
        })
        if (result === "stop") break
        continue
      }

      // Continuation rebind compaction: server rejected previous_response_id,
      // use pre-built checkpoint to compact instead of resending full history.
      if (lastFinished && lastFinished.summary !== true && SessionCompaction.consumeRebindCompaction(sessionID)) {
        log.info("rebind compaction triggered after continuation invalidation", { sessionID })
        debugCheckpoint("prompt", "loop:rebind_compaction_triggered", {
          sessionID,
          step,
          source: "continuation_invalidation",
        })
        SessionCompaction.recordCompaction(sessionID, step)
        if (!session.parentID) {
          // Priority: use pre-built checkpoint (saved during normal operation)
          const checkpoint = await SessionCompaction.loadRebindCheckpoint(sessionID)
          const snap = checkpoint?.snapshot || (await SharedContext.snapshot(sessionID))
          if (snap) {
            debugCheckpoint("prompt", "loop:rebind_compaction_snapshot_selected", {
              sessionID,
              step,
              source: checkpoint ? "checkpoint" : "shared-context",
              boundaryId: checkpoint?.lastMessageId,
              snapshotChars: snap.length,
            })
            await SessionCompaction.compactWithSharedContext({
              sessionID,
              snapshot: snap,
              model,
              auto: true,
            })
            continue
          }
        }
      }

      // Rebind checkpoint: quietly snapshot context for restart recovery.
      // Does NOT compact the live message chain (that would break cache).
      // Only produces a checkpoint file that rebind uses if restart happens.
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        !session.parentID &&
        SessionCompaction.shouldRebindBudgetCompact({ tokens: lastFinished.tokens, sessionID, currentRound: step })
      ) {
        // Fire-and-forget: snapshot in background, don't block the conversation
        debugCheckpoint("prompt", "loop:rebind_checkpoint_save_scheduled", {
          sessionID,
          step,
          boundaryId: msgs.at(-1)?.info.id,
        })
        SessionCompaction.saveRebindCheckpoint({
          sessionID,
          lastMessageId: msgs.at(-1)?.info.id,
          currentRound: step,
        }).catch(() => {})
      }

      // context overflow OR cache-aware compaction
      const overflowTriggered =
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model, sessionID, currentRound: step }))
      const cacheAwareTriggered =
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.shouldCacheAwareCompact({
          tokens: lastFinished.tokens,
          model,
          sessionID,
          currentRound: step,
        }))
      if (overflowTriggered || cacheAwareTriggered) {
        debugCheckpoint("prompt", "loop:compaction_triggered", {
          sessionID,
          step,
          overflowTriggered,
          cacheAwareTriggered,
        })
        SessionCompaction.recordCompaction(sessionID, step)
        // Priority path: use shared context snapshot as summary (no LLM call)
        if (!session.parentID) {
          const overflowConfig = await Config.get()
          if (overflowConfig.compaction?.sharedContext !== false) {
            const snap = await SharedContext.snapshot(sessionID)
            // Snapshot must fit within ~30% of the target model's context to
            // leave room for system prompt + new conversation. Without this
            // check, switching from a large-context model to a small one
            // produces a snapshot that is itself bigger than the new model's
            // context window, making conversation impossible.
            const snapTokenEstimate = snap ? Math.ceil(snap.length / 4) : 0
            const snapBudget = Math.floor((model.limit.context || 0) * 0.3)
            if (snap && snapTokenEstimate <= snapBudget) {
              debugCheckpoint("prompt", "loop:compaction_snapshot_selected", {
                sessionID,
                step,
                source: "shared-context",
                snapshotChars: snap.length,
                snapTokenEstimate,
                snapBudget,
              })
              await SessionCompaction.compactWithSharedContext({
                sessionID,
                snapshot: snap,
                model,
                auto: true,
              })
              continue
            }
            if (snap) {
              debugCheckpoint("prompt", "loop:compaction_snapshot_too_large", {
                sessionID,
                step,
                snapTokenEstimate,
                snapBudget,
                modelContext: model.limit.context,
              })
              // Fall through to LLM compaction which truncates properly
            }
          }
        }
        // Fallback: LLM compaction agent
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          format: lastUser.format,
          auto: true,
        })
        continue
      }

      // normal processing
      const userMsg = msgs.findLast((m) => m.info.role === "user")
      const imageResolution = await resolveImageRequest({
        model,
        accountId: lastUser.model.accountId,
        message: userMsg,
        sessionID,
      })
      const activeModel = imageResolution.model
      if (imageResolution.rotated) {
        const change = `${activeModel.providerId}/${activeModel.id}`
        Bus.publish(TuiEvent.ToastShow, {
          title: "Model Rotated",
          message: `Using ${change} for image input`,
          variant: "info",
          duration: 4000,
        }).catch(() => {})

        // PERSISTENCE: Update the user message to use this working model as the preference.
        // This ensures subsequent turns (which check `lastModel`) will default to this capability-verified model.
        if (lastUser) {
          const updatedInfo = { ...lastUser }
          updatedInfo.model = {
            providerId: activeModel.providerId,
            modelID: activeModel.id,
            accountId: lastUser.model.accountId,
          }
          await Session.updateMessage(updatedInfo)
        }

        // SSOT: pin session execution to the image-capable model so UI (footer,
        // selector, quota) reflects what the next LLM call will actually use.
        // Without this, processor's preflight pin is skipped (session already
        // has an account pinned) and UI shows the pre-rotation model.
        await Session.pinExecutionIdentity({
          sessionID,
          model: {
            providerId: activeModel.providerId,
            modelID: activeModel.id,
            accountId: lastUser?.model.accountId,
          },
        }).catch((err) => {
          log.warn("image-router: failed to pin execution identity", {
            sessionID,
            providerId: activeModel.providerId,
            modelID: activeModel.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: activeModel.id,
          providerId: activeModel.providerId,
          accountId: lastUser.model.accountId,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model: activeModel,
        accountId: lastUser.model.accountId,
        abort,
      })
      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const resolvedToolsOutput = await resolveTools({
        agent,
        session,
        model: activeModel,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
      })

      const tools = resolvedToolsOutput.tools
      const lazyTools = resolvedToolsOutput.lazyTools
      const lazyCatalogPrompt = resolvedToolsOutput.lazyCatalogPrompt

      // Active Loader: lazy tools are NOT injected into the tools dict.
      // They are passed separately via `lazyTools` to the processor/LLM,
      // which handles on-demand unlock via experimental_repairToolCall.
      // A compact catalog prompt is injected as a system message so the AI
      // knows what deferred tools exist and can call them directly.

      if (format.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      const sessionMessages = clone(msgs)
      if (imageResolution.dropImages) {
        stripImageParts(sessionMessages)
      }

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of sessionMessages) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

      // Determine if we should load instruction prompts
      // Subagent sessions (parentID set) or subagent modes still need to adhere to the core constitution
      // to ensure consistent behavioral standards (e.g., Read-Before-Write, Absolute Paths).
      const instructionPrompts = cachedInstructionPrompts
      const environmentKey = `${activeModel.providerId}/${activeModel.api.id}`
      let environmentPrompts = environmentCache.get(environmentKey)
      if (!environmentPrompts) {
        environmentPrompts = await SystemPrompt.environment(activeModel, sessionID, session.parentID)
        environmentCache.set(environmentKey, environmentPrompts)
      }
      debugCheckpoint("prompt", "loop:instruction_decision", {
        sessionID,
        parentID: session.parentID,
        agentName: agent.name,
        agentMode: agent.mode,
        instructionCount: instructionPrompts.length,
      })

      // ── Capability layer refresh (session-rebind-capability-refresh) ──
      // DD-15: the existing mandatory-skills hook is now a forwarder onto
      // CapabilityLayer.get. Cache-hit rounds do zero disk I/O; cache-miss
      // (after a rebind event bumps the epoch) triggers the production loader
      // which internally performs resolve + reconcile + preload for skills
      // AND picks up the freshly-read AGENTS.md.
      //
      // Lazy daemon_start bump (Phase 4.1): if this session has never been
      // bumped (epoch=0) — e.g. first round after a fresh daemon — mark it as
      // the implicit daemon_start rebind so the capability-layer cache gets
      // populated at epoch=1 on the next CapabilityLayer.get call.
      try {
        ensureCapabilityLoaderRegistered()
        if (RebindEpoch.current(sessionID) === 0) {
          await RebindEpoch.bumpEpoch({
            sessionID,
            trigger: "daemon_start",
            reason: "first runLoop iteration after daemon start",
          })
        }
        await CapabilityLayer.get(sessionID, RebindEpoch.current(sessionID))
      } catch (err) {
        // Loud warn — AGENTS.md 第一條 prohibits silent fallback.
        log.warn("capability-layer refresh failed (non-fatal, continuing prompt assembly)", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // responsive-orchestrator R2/R6 DD-3: drain pendingSubagentNotices.
      // Each notice becomes a one-line system-prompt addendum so main agent
      // sees subagent results on its very next turn without polluting the
      // visible chat log. Drain is atomic: notices are removed from the
      // session info in the same Session.update pass so they never render
      // twice.
      const pendingNotices = session.pendingSubagentNotices ?? []
      const noticeAddenda: string[] = []
      if (pendingNotices.length > 0) {
        for (const n of pendingNotices) {
          noticeAddenda.push(renderNoticeAddendum(n))
        }
        await Session.update(sessionID, (draft) => {
          // Remove only the notices we consumed — new arrivals between read
          // and write survive.
          const consumed = new Set(pendingNotices.map((n) => n.jobId))
          draft.pendingSubagentNotices = (draft.pendingSubagentNotices ?? []).filter(
            (n) => !consumed.has(n.jobId),
          )
        }).catch(() => undefined)
      }

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        accountId: effectiveAccountId,
        system: [
          await getPreloadedContext(sessionID),
          ...environmentPrompts,
          // Only include heavy instruction prompts (AGENTS.md) for Main Agents (no parentID).
          // Subagents should rely on the task description and SYSTEM.md.
          ...(session.parentID ? [] : instructionPrompts),
          ...(lazyCatalogPrompt ? [lazyCatalogPrompt] : []),
          ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
          ...noticeAddenda,
        ],
        messages: SessionCompaction.sanitizeOrphanedToolCalls([
          // Context Sharing v2: prepend parent messages as stable prefix for child sessions.
          // This gives the child full visibility into parent's context (plan, discoveries, etc.)
          // at near-zero cost due to automatic prompt caching on the stable prefix.
          ...(parentMessagePrefix
            ? [
                ...MessageV2.toModelMessages(parentMessagePrefix, activeModel),
                {
                  role: "user" as const,
                  content: [
                    {
                      type: "text" as const,
                      text: "--- You are now operating as a delegated subagent. Above is the parent session's full context. Your assigned task follows below. ---",
                    },
                  ],
                },
              ]
            : []),
          ...MessageV2.toModelMessages(sessionMessages, activeModel),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ]),
        tools,
        lazyTools,
        model: activeModel,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })

      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        break
      }

      if (
        result === "stop" &&
        format.type === "json_schema" &&
        !processor.message.error &&
        !["tool-calls", "unknown"].includes(processor.message.finish ?? "")
      ) {
        processor.message.error = new MessageV2.StructuredOutputError({
          message: "Model did not produce structured output",
          retries: 0,
        }).toObject()
        await Session.updateMessage(processor.message)
        break
      }
      if (result === "stop") {
        const planTurnCheck = classifyPlanModeAssistantTurn({
          agentName: agent.name,
          finish: processor.message.finish,
          parts: await MessageV2.parts(processor.message.id),
        })
        if (planTurnCheck.enforced && planTurnCheck.violation) {
          processor.message.error = new NamedError.Unknown({
            message:
              `Plan mode enforcement violation: ${planTurnCheck.reason}. ` +
              `Bounded or execution-shaping questions must use MCP question; allowed endings are question tool or non-question progress summary.`,
          }).toObject()
          await Session.updateMessage(processor.message)
          break
        }

        // processor returned "stop" → blocked (permission/question rejected)
        // or assistant error. Workflow state is already set inside processor.
        // Child sessions must also stop here — parent/task completion wiring
        // owns any follow-up, and child self-nudging can create synthetic loops.
        break
      }
      if (result === "compact") {
        consecutiveCompactions++
        if (consecutiveCompactions >= 3) {
          log.warn("breaking compaction loop — model may be unable to reduce context", {
            sessionID,
            step,
            consecutiveCompactions,
            model: lastUser.model,
          })
          break
        }
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          format: lastUser.format,
          auto: true,
        })
      } else {
        consecutiveCompactions = 0
      }
      // Terminal finish boundary: decide whether the session continues.
      //   • Subagent: always break (child is done). The parent-side watchdog
      //     in task.ts owns hang recovery — no retry needed here.
      //   • Root session: evaluate autonomous continuation. If there's a
      //     pending todo, enqueue a synthetic continuation and loop again.
      //     Otherwise persist the stop reason and break.
      if (processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)) {
        if (session.parentID) {
          log.info("loop: subagent terminal finish", {
            sessionID,
            step,
            finish: processor.message.finish,
            result,
          })
          break
        }
        const decision = await decideAutonomousContinuation({
          sessionID,
          lastDecisionReason,
        })
        lastDecisionReason = decision.reason
        if (decision.continue) {
          const continuationResult = await handleContinuationSideEffects({
            sessionID,
            user: lastUser,
            decision,
            autonomousRounds,
          })
          autonomousRounds = continuationResult.nextRoundCount
          continue
        }
        // Stop. Persist workflow state by reason.
        const stopState = resolveTerminalContinuationStopState(decision)
        await Session.setWorkflowState({
          sessionID,
          state: stopState.state,
          stopReason: stopState.stopReason,
          lastRunAt: Date.now(),
        })
        debugCheckpoint("prompt", "loop:continuation_stopped", {
          sessionID,
          step,
          reason: decision.reason,
          autonomousRounds,
        })
        log.info("loop:continuation_stopped", { sessionID, reason: decision.reason })
        break
      }
      continue
    }

    // ── Session Snapshot + Shared Context: incremental update + idle compaction at turn boundary ──
    {
      const config = await Config.get()
      if (config.compaction?.sharedContext !== false) {
        try {
          const { messages: finalMsgs } = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
          const lastAssistantMsg = finalMsgs.findLast((m) => m.info.role === "assistant")
          if (lastAssistantMsg) {
            const assistantText = lastAssistantMsg.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")

            await SharedContext.updateFromTurn({
              sessionID,
              parts: lastAssistantMsg.parts,
              assistantText,
              turnNumber: step,
            })

            void SharedContext.persistSnapshot(sessionID)

            if (!session.parentID) {
              const hasTaskDispatch = lastAssistantMsg.parts.some(
                (p) => p.type === "tool" && p.tool === "task" && p.state.status !== "pending",
              )
              if (hasTaskDispatch) {
                const lastFinishedInfo = lastAssistantMsg.info as MessageV2.Assistant
                if (lastFinishedInfo.tokens) {
                  const model = await Provider.getModel(lastFinishedInfo.providerId, lastFinishedInfo.modelID)
                  await SessionCompaction.idleCompaction({
                    sessionID,
                    model,
                    config,
                  })
                }
              }
            }
          }
        } catch (err) {
          log.warn("shared context update failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    log.info("loop:pruning_compacting_and_returning", { sessionID })
    SessionCompaction.prune({ sessionID })
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = consumeCallbacks(sessionID)
      log.info("loop:found_assistant_message_returning", {
        sessionID,
        returnedMessageID: item.info.id,
        queuedCallbacks: queued.length,
      })
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => runLoop(sessionID))

  async function createUserMessage(
    input: PromptInput,
    session: Session.Info,
  ): Promise<{ info: MessageV2.User; parts: MessageV2.WithParts["parts"] }> {
    const triggerPolicy = await resolveDialogTriggerPolicy({
      agent: input.agent,
      client: Flag.OPENCODE_CLIENT,
      parts: input.parts,
      session,
    })
    const triggerDecision = triggerPolicy.decision

    const effectiveAgent = triggerDecision.routeAgent ?? input.agent
    const { agent, partsInput, info } = await prepareUserMessageContext({
      sessionID: input.sessionID,
      messageID: input.messageID,
      agent: effectiveAgent,
      model: input.model,
      format: input.format,
      variant: input.variant,
      noReply: input.noReply,
      tools: input.tools,
      system: input.system,
      parts: input.parts,
    })

    const safePartsInput = partsInput as PromptInput["parts"]
    const parts = await buildUserMessageParts({
      partsInput: safePartsInput,
      info: info as MessageV2.User,
      sessionID: input.sessionID,
      agentName: agent.name,
      agentPermission: agent.permission,
    })

    await persistUserMessage({
      info,
      parts,
      sessionID: input.sessionID,
      agent: effectiveAgent,
      model: input.model,
      messageID: input.messageID,
      variant: input.variant,
    })

    return {
      info,
      parts,
    }
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerId: z.string(),
        modelID: z.string(),
        accountId: z.string().optional(),
      })
      .optional(),
    variant: z.string().optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const runtime = start(input.sessionID)
    if (!runtime) {
      throw new Session.BusyError(input.sessionID)
    }
    using _ = defer(() => finishRuntime(input.sessionID, runtime.runID))

    return runShellPrompt(input, runtime.signal)
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z
      .union([
        z.string(),
        z.object({
          providerId: z.string(),
          modelID: z.string(),
          accountId: z.string().optional(),
        }),
      ])
      .optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)

    const commandInfo = await Command.get(input.command)
    if (!commandInfo) {
      throw new Error(`Command not found: ${input.command}`)
    }

    if (commandInfo.handler) {
      return executeHandledCommand({
        commandInfo: commandInfo as Command.Info & { handler: () => Promise<{ output: string; title?: string }> },
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      })
    }

    const templateCommand = await commandInfo.template
    const template = await renderCommandTemplate({
      templateCommand,
      argumentsText: input.arguments,
    })
    const { parts, userAgent, userModel } = await prepareCommandPrompt({
      commandInfo: commandInfo,
      commandName: input.command,
      sessionID: input.sessionID,
      inputAgent: input.agent,
      inputModel: input.model,
      inputParts: input.parts,
      template,
      resolvePromptParts,
    })

    return dispatchCommandPrompt({
      commandName: input.command,
      sessionID: input.sessionID,
      argumentsText: input.arguments,
      parts,
      invoke: () =>
        prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          parts,
          variant: input.variant,
        }) as Promise<MessageV2.WithParts>,
    })
  }
}
