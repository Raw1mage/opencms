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
  enqueueAutonomousContinue,
  getPendingContinuation,
  isPlanTrusting,
  shouldInterruptAutonomousRun,
} from "./workflow-runner"
import { consumeMissionArtifacts, deriveDelegatedExecutionRole } from "./mission-consumption"
import {
  annotateSmartRunnerApprovalAdoption,
  annotateSmartRunnerAskUserAdoption,
  annotateSmartRunnerCompletionAdoption,
  annotateSmartRunnerRiskPauseAdoption,
  annotateSmartRunnerReplanAdoption,
  annotateSmartRunnerTraceAssist,
  annotateSmartRunnerTraceSuggestion,
  applySmartRunnerBoundedAssist,
  evaluateSmartRunnerAskUserAdoption,
  evaluateSmartRunnerHostAdoptionPolicy,
  evaluateSmartRunnerGovernorDryRun,
  getSmartRunnerAskUserQuestionText,
  getSmartRunnerConfig,
  persistSmartRunnerGovernorTrace,
  prefixSmartRunnerText,
} from "./smart-runner-governor"

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
    const hasPlanExitTool = toolParts.some((part) => part.tool === "plan_exit")
    if (hasQuestionTool || hasPlanExitTool || input.finish === "tool-calls") {
      return {
        enforced: true as const,
        violation: false as const,
        reason: hasQuestionTool
          ? ("question_tool" as const)
          : hasPlanExitTool
            ? ("plan_exit_tool" as const)
            : ("tool_calls" as const),
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

  function shouldAutoEnterPlanMode(input: PromptInput) {
    if (input.agent) return false
    if (!["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT)) return false
    const text = input.parts
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim()
      .toLowerCase()
    if (!text) return false

    const hardNegativePatterns = [
      /\bwhat did we do so far\b/,
      /\bstatus update\b/,
      /\bsummarize\b/,
      /\bsummary\b/,
      /\bexplain\b/,
      /\bjust answer\b/,
      /目前進度/,
      /做了什麼/,
      /總結一下/,
      /只要說明/,
    ]
    if (hardNegativePatterns.some((pattern) => pattern.test(text))) return false

    const intentKeywords = [
      "implement",
      "build",
      "refactor",
      "debug",
      "fix",
      "investigate",
      "design",
      "architecture",
      "autonomous",
      "automation",
      "daemon",
      "spec",
      "multi-step",
      "continue work",
      "continue working",
      "subagent",
      "planner",
      "workflow",
      "需求",
      "規劃",
      "計畫",
      "實作",
      "重構",
      "除錯",
      "修復",
      "架構",
      "自治",
      "自動",
      "持續工作",
    ]
    const complexityKeywords = [
      "scope",
      "validation",
      "phases",
      "checkpoints",
      "handoff",
      "todo",
      "requirements",
      "constraints",
      "risk",
      "驗證",
      "階段",
      "檢查點",
      "交接",
      "任務",
      "限制",
      "風險",
    ]

    const hasIntentKeyword = intentKeywords.some((keyword) => text.includes(keyword))
    const hasComplexityKeyword = complexityKeywords.some((keyword) => text.includes(keyword))
    const lineCount = text.split(/\n+/).filter(Boolean).length
    const longEnough = text.length >= 80 || lineCount >= 3

    let score = 0
    if (hasIntentKeyword) score += 2
    if (hasComplexityKeyword) score += 2
    if (longEnough) score += 1
    if (/\b(plan|planner|planning)\b|規劃|計畫/.test(text)) score += 1

    return score >= 4
  }

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    if (input.autonomous !== undefined) {
      await Session.update(
        input.sessionID,
        (draft) => {
          const current = draft.workflow ?? Session.defaultWorkflow(draft.time.updated)
          draft.workflow = {
            ...current,
            autonomous: Session.mergeAutonomousPolicy(current.autonomous, {
              enabled: input.autonomous!,
            }),
            state: input.autonomous
              ? current.state === "completed"
                ? "idle"
                : current.state
              : current.state === "running"
                ? "waiting_user"
                : current.state,
            stopReason: input.autonomous ? undefined : current.stopReason,
            updatedAt: Date.now(),
          }
        },
        { touch: false },
      )
    }

    const message = await createUserMessage(input)
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
    return runLoop(input.sessionID, { replaceRuntime: shouldReplaceRuntime })
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

  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    cancelRuntime(sessionID)
    void clearPendingContinuation(sessionID).catch(() => undefined)
    void Session.setWorkflowState({
      sessionID,
      state: "waiting_user",
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

  export function buildSmartRunnerQuestion(input: { questionText?: string }): Question.Info | undefined {
    const question = input.questionText?.trim()
    if (!question) return undefined
    return {
      question,
      header: "Decision needed",
      options: [],
      custom: true,
    }
  }

  export function formatSmartRunnerQuestionAnswers(input: { question: Question.Info; answers: Question.Answer[] }) {
    const answer = input.answers[0]?.length ? input.answers[0].join(", ") : "Unanswered"
    return `User answered Smart Runner question \"${input.question.question}\" with: ${answer}. Continue with this answer in mind.`
  }

  export async function handleSmartRunnerAskUserAdoption(input: {
    sessionID: string
    question: Question.Info
    trace: ReturnType<typeof annotateSmartRunnerAskUserAdoption>
    lastUser: Pick<MessageV2.User, "agent" | "model" | "variant" | "format">
    ask?: typeof Question.ask
    persistTrace?: (input: {
      sessionID: string
      trace: ReturnType<typeof annotateSmartRunnerAskUserAdoption>
    }) => Promise<void>
    updateMessage?: typeof Session.updateMessage
    updatePart?: typeof Session.updatePart
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    const ask = input.ask ?? Question.ask
    const persistTrace = input.persistTrace ?? persistSmartRunnerGovernorTrace
    const updateMessage = input.updateMessage ?? Session.updateMessage
    const updatePart = input.updatePart ?? Session.updatePart
    const setWorkflowState = input.setWorkflowState ?? Session.setWorkflowState

    await persistTrace({
      sessionID: input.sessionID,
      trace: input.trace,
    })
    try {
      const answers = await ask({
        sessionID: input.sessionID,
        questions: [input.question],
      })
      const session = await Session.get(input.sessionID).catch(() => undefined)
      const executionModel = session?.execution
        ? {
            providerId: session.execution.providerId,
            modelID: session.execution.modelID,
            accountId: session.execution.accountId,
          }
        : input.lastUser.model
      const userMsg: MessageV2.User = {
        id: Identifier.ascending("message"),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.lastUser.agent,
        model: executionModel,
        variant: input.lastUser.variant,
        format: input.lastUser.format,
      }
      await updateMessage(userMsg)
      await updatePart({
        id: Identifier.ascending("part"),
        messageID: userMsg.id,
        sessionID: input.sessionID,
        type: "text",
        text: formatSmartRunnerQuestionAnswers({ question: input.question, answers }),
        synthetic: true,
      } satisfies MessageV2.TextPart)
      return { outcome: "answered" as const }
    } catch (error) {
      const rejectedTrace = annotateSmartRunnerAskUserAdoption({
        trace: input.trace,
        adopted: true,
        reason: error instanceof Question.RejectedError ? "question_rejected" : "adopted",
      })
      await persistTrace({
        sessionID: input.sessionID,
        trace: rejectedTrace,
      })
      await setWorkflowState({
        sessionID: input.sessionID,
        state: "waiting_user",
        stopReason: "product_decision_needed",
        lastRunAt: Date.now(),
      })
      return { outcome: "rejected" as const }
    }
  }

  export async function handleSmartRunnerApprovalRequest(input: {
    sessionID: string
    trace: ReturnType<typeof annotateSmartRunnerApprovalAdoption>
    persistTrace?: (input: {
      sessionID: string
      trace: ReturnType<typeof annotateSmartRunnerApprovalAdoption>
    }) => Promise<void>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    const persistTrace = input.persistTrace ?? persistSmartRunnerGovernorTrace
    const setWorkflowState = input.setWorkflowState ?? Session.setWorkflowState
    await persistTrace({ sessionID: input.sessionID, trace: input.trace })
    await setWorkflowState({
      sessionID: input.sessionID,
      state: "waiting_user",
      stopReason: "approval_needed",
      lastRunAt: Date.now(),
    })
    return { outcome: "requested" as const }
  }

  export async function handleSmartRunnerRiskPause(input: {
    sessionID: string
    trace: ReturnType<typeof annotateSmartRunnerRiskPauseAdoption>
    persistTrace?: (input: {
      sessionID: string
      trace: ReturnType<typeof annotateSmartRunnerRiskPauseAdoption>
    }) => Promise<void>
    setWorkflowState?: typeof Session.setWorkflowState
  }) {
    const persistTrace = input.persistTrace ?? persistSmartRunnerGovernorTrace
    const setWorkflowState = input.setWorkflowState ?? Session.setWorkflowState
    await persistTrace({ sessionID: input.sessionID, trace: input.trace })
    await setWorkflowState({
      sessionID: input.sessionID,
      state: "waiting_user",
      stopReason: "risk_review_needed",
      lastRunAt: Date.now(),
    })
    return { outcome: "paused" as const }
  }

  export async function handleSmartRunnerReplanAdoption(input: {
    sessionID: string
    todos: Todo.Info[]
    suggestion?: NonNullable<ReturnType<typeof annotateSmartRunnerTraceSuggestion>["suggestion"]>
    roundCount: number
    fallbackDecision: Extract<Awaited<ReturnType<typeof decideAutonomousContinuation>>, { continue: true }>
    updateTodos?: typeof Todo.update
    decideContinuation?: typeof decideAutonomousContinuation
  }) {
    const adoptedReplan = Todo.applyHostAdoptedReplan(input.todos, input.suggestion?.replanAdoption)
    if (!adoptedReplan.adopted) {
      return {
        adopted: false as const,
        reason: adoptedReplan.reason,
        decision: input.fallbackDecision,
      }
    }

    const updateTodos = input.updateTodos ?? Todo.update
    const decideContinuation = input.decideContinuation ?? decideAutonomousContinuation
    await updateTodos({ sessionID: input.sessionID, todos: adoptedReplan.todos })
    const nextDecision = await decideContinuation({
      sessionID: input.sessionID,
      roundCount: input.roundCount,
    })
    return {
      adopted: true as const,
      reason: adoptedReplan.reason,
      decision: nextDecision.continue ? nextDecision : input.fallbackDecision,
      todos: adoptedReplan.todos,
    }
  }

  export async function handleSmartRunnerCompletionAdoption(input: {
    sessionID: string
    todos: Todo.Info[]
    suggestion?: NonNullable<ReturnType<typeof annotateSmartRunnerTraceSuggestion>["suggestion"]>
    roundCount: number
    updateTodos?: typeof Todo.update
    decideContinuation?: typeof decideAutonomousContinuation
    setWorkflowState?: typeof Session.setWorkflowState
    persistTrace?: typeof persistSmartRunnerGovernorTrace
    trace?: ReturnType<typeof annotateSmartRunnerTraceSuggestion>
  }) {
    const adoptedCompletion = Todo.applyHostAdoptedCompletion(input.todos, input.suggestion?.completionRequest)
    const updateTodos = input.updateTodos ?? Todo.update
    const decideContinuation = input.decideContinuation ?? decideAutonomousContinuation
    const setWorkflowState = input.setWorkflowState ?? Session.setWorkflowState
    const persistTrace = input.persistTrace ?? persistSmartRunnerGovernorTrace

    let completionReason:
      | "adopted"
      | "missing_target"
      | "unsupported_action"
      | "policy_not_host_adoptable"
      | "user_confirm_required"
      | "host_review_missing"
      | "target_not_active"
      | "approval_gate"
      | "waiting_gate"
      | "not_terminal_after_completion" = adoptedCompletion.adopted ? "adopted" : adoptedCompletion.reason

    let trace =
      input.trace && input.suggestion?.kind === "complete"
        ? annotateSmartRunnerCompletionAdoption({
            trace: input.trace,
            adopted: adoptedCompletion.adopted,
            reason: completionReason,
          })
        : input.trace

    if (!adoptedCompletion.adopted) {
      if (trace) await persistTrace({ sessionID: input.sessionID, trace })
      return { adopted: false as const, reason: completionReason, trace }
    }

    await updateTodos({ sessionID: input.sessionID, todos: adoptedCompletion.todos })
    const nextDecision = await decideContinuation({
      sessionID: input.sessionID,
      roundCount: input.roundCount,
    })
    if (nextDecision.continue || nextDecision.reason !== "todo_complete") {
      completionReason = "not_terminal_after_completion"
      trace =
        input.trace && input.suggestion?.kind === "complete"
          ? annotateSmartRunnerCompletionAdoption({
              trace: input.trace,
              adopted: false,
              reason: completionReason,
            })
          : trace
      if (trace) await persistTrace({ sessionID: input.sessionID, trace })
      return {
        adopted: false as const,
        reason: completionReason,
        trace,
        todos: adoptedCompletion.todos,
      }
    }

    if (trace) {
      trace = annotateSmartRunnerCompletionAdoption({
        trace: trace,
        adopted: true,
        reason: "adopted",
      })
      await persistTrace({ sessionID: input.sessionID, trace })
    }
    await setWorkflowState({
      sessionID: input.sessionID,
      state: "completed",
      stopReason: "todo_complete",
      lastRunAt: Date.now(),
    })
    return {
      adopted: true as const,
      reason: "adopted" as const,
      outcome: "completed" as const,
      todos: adoptedCompletion.todos,
      trace,
    }
  }

  export async function handleSmartRunnerContinuationSideEffects(input: {
    sessionID: string
    user: MessageV2.User
    decision: Extract<Awaited<ReturnType<typeof decideAutonomousContinuation>>, { continue: true }>
    narrationOverride?: string
    autonomousRounds: number
    emitNarration?: typeof emitAutonomousNarration
    enqueueContinue?: typeof enqueueAutonomousContinue
  }) {
    const session = await Session.get(input.sessionID)
    const missionConsumption = session.mission ? await consumeMissionArtifacts(session.mission) : undefined
    if (session.mission && missionConsumption && !missionConsumption.ok) {
      const emitNarration = input.emitNarration ?? emitAutonomousNarration
      const narration = {
        kind: "pause" as const,
        text: "Paused: approved mission artifacts could not be consumed safely, so autonomous execution stopped.",
      }
      await emitNarration({
        sessionID: input.sessionID,
        parentID: input.user.id,
        agent: input.user.agent,
        variant: input.user.variant,
        model: input.user.model,
        text: narration.text,
        kind: narration.kind,
      })
      await Session.setWorkflowState({
        sessionID: input.sessionID,
        state: "waiting_user",
        stopReason: "mission_not_consumable",
        lastRunAt: Date.now(),
      })
      return {
        halted: true as const,
        nextRoundCount: input.autonomousRounds,
        narration,
      }
    }
    const delegation = missionConsumption?.ok
      ? deriveDelegatedExecutionRole({
          todo: input.decision.todo,
          mission: missionConsumption.trace,
        })
      : undefined
    const narration = describeAutonomousNextAction({
      type: "continue",
      reason: input.decision.reason,
      text: input.decision.text,
      todo: input.decision.todo,
    })
    const emitNarration = input.emitNarration ?? emitAutonomousNarration
    const enqueueContinue = input.enqueueContinue ?? enqueueAutonomousContinue
    const nextRoundCount = input.autonomousRounds + 1

    await emitNarration({
      sessionID: input.sessionID,
      parentID: input.user.id,
      agent: input.user.agent,
      variant: input.user.variant,
      model: input.user.model,
      text: input.narrationOverride ?? narration.text,
      kind: narration.kind,
    })
    await enqueueContinue({
      sessionID: input.sessionID,
      user: input.user,
      roundCount: nextRoundCount,
      text:
        delegation && delegation.role !== "generic"
          ? `Continue with the next planned ${delegation.role} step: ${input.decision.todo.content}`
          : input.decision.text,
      delegation,
    })
    return {
      halted: false as const,
      nextRoundCount,
      narration,
    }
  }

  export async function handleSmartRunnerAdoptedStopNarration(input: {
    sessionID: string
    user: MessageV2.User
    text?: string
    kind?: "pause" | "complete"
    emitNarration?: typeof emitAutonomousNarration
  }) {
    const narrationText = input.text?.trim()
    if (!narrationText) return { emitted: false as const }
    const emitNarration = input.emitNarration ?? emitAutonomousNarration
    await emitNarration({
      sessionID: input.sessionID,
      parentID: input.user.id,
      agent: input.user.agent,
      variant: input.user.variant,
      model: input.user.model,
      text: prefixSmartRunnerText(narrationText),
      kind: input.kind ?? "pause",
    })
    return { emitted: true as const }
  }

  export async function handleSmartRunnerStopDecision(input: {
    sessionID: string
    activeModel: Provider.Model
    autonomousRounds: number
    lastUser: MessageV2.User
    messages: MessageV2.WithParts[]
    todos: Todo.Info[]
    decision: Extract<Awaited<ReturnType<typeof decideAutonomousContinuation>>, { continue: true }>
    mission?: Session.Info["mission"]
    getConfig?: typeof getSmartRunnerConfig
    evaluateGovernor?: typeof evaluateSmartRunnerGovernorDryRun
    listQuestions?: typeof Question.list
    askUser?: typeof handleSmartRunnerAskUserAdoption
    requestApproval?: typeof handleSmartRunnerApprovalRequest
    pauseForRisk?: typeof handleSmartRunnerRiskPause
    completePath?: typeof handleSmartRunnerCompletionAdoption
    replan?: typeof handleSmartRunnerReplanAdoption
    persistTrace?: typeof persistSmartRunnerGovernorTrace
    applyAssist?: typeof applySmartRunnerBoundedAssist
  }) {
    // Plan-trusting short-circuit: when a fully approved mission exists,
    // skip the entire LLM governor pipeline and continue execution directly.
    // Only real blockers (kill-switch, auth errors, test failures, approval gates)
    // should stop a plan-trusting session — those are caught by the deterministic
    // layer in planAutonomousNextAction() before we reach this function.
    const missionForTrust = input.mission ?? (await Session.get(input.sessionID).catch(() => undefined))?.mission
    if (isPlanTrusting(missionForTrust)) {
      return {
        kind: "continue" as const,
        continueDecision: input.decision,
        narrationOverride: undefined,
        trace: undefined,
        adoptedReplan: { adopted: false as const, reason: "plan_trusting" as const, decision: input.decision },
      }
    }

    const getConfig = input.getConfig ?? getSmartRunnerConfig
    const evaluateGovernor = input.evaluateGovernor ?? evaluateSmartRunnerGovernorDryRun
    const listQuestions = input.listQuestions ?? Question.list
    const askUser = input.askUser ?? handleSmartRunnerAskUserAdoption
    const requestApproval = input.requestApproval ?? handleSmartRunnerApprovalRequest
    const pauseForRisk = input.pauseForRisk ?? handleSmartRunnerRiskPause
    const completePath = input.completePath ?? handleSmartRunnerCompletionAdoption
    const replan = input.replan ?? handleSmartRunnerReplanAdoption
    const persistTrace = input.persistTrace ?? persistSmartRunnerGovernorTrace
    const applyAssist = input.applyAssist ?? applySmartRunnerBoundedAssist

    const smartRunnerGovernor = await getConfig()
    const trace = await evaluateGovernor({
      sessionID: input.sessionID,
      model: input.activeModel,
      enabled: smartRunnerGovernor.enabled,
      todos: input.todos,
      roundCount: input.autonomousRounds,
      deterministicDecision: input.decision,
      messages: input.messages,
    })
    const suggestedTrace = annotateSmartRunnerTraceSuggestion({ trace })
    let traceForAssist = suggestedTrace
    const currentPendingQuestions = (await listQuestions()).filter((item) => item.sessionID === input.sessionID).length
    const askUserAdoption = evaluateSmartRunnerAskUserAdoption({
      suggestion: suggestedTrace.suggestion,
      pendingQuestions: currentPendingQuestions,
    })
    const askUserQuestion = buildSmartRunnerQuestion({
      questionText: getSmartRunnerAskUserQuestionText({ suggestion: suggestedTrace.suggestion }),
    })

    if (suggestedTrace.suggestion?.kind === "request_approval") {
      const approvalReason = evaluateSmartRunnerHostAdoptionPolicy(suggestedTrace.suggestion.approvalRequest?.policy)
      const approvalTrace = annotateSmartRunnerApprovalAdoption({
        trace: suggestedTrace,
        adopted: approvalReason === "adopted",
        reason: approvalReason,
      })
      if (approvalReason === "adopted") {
        const approvalResult = await requestApproval({
          sessionID: input.sessionID,
          trace: approvalTrace,
        })
        return {
          kind: "request_approval" as const,
          adopted: true,
          outcome: approvalResult.outcome,
          trace: approvalTrace,
        }
      }
      traceForAssist = approvalTrace
    }

    if (suggestedTrace.suggestion?.kind === "pause_for_risk") {
      const riskPauseReason = evaluateSmartRunnerHostAdoptionPolicy(suggestedTrace.suggestion.riskPauseRequest?.policy)
      const riskPauseTrace = annotateSmartRunnerRiskPauseAdoption({
        trace: suggestedTrace,
        adopted: riskPauseReason === "adopted",
        reason: riskPauseReason,
      })
      if (riskPauseReason === "adopted") {
        const riskPauseResult = await pauseForRisk({
          sessionID: input.sessionID,
          trace: riskPauseTrace,
        })
        return {
          kind: "pause_for_risk" as const,
          adopted: true,
          outcome: riskPauseResult.outcome,
          trace: riskPauseTrace,
        }
      }
      traceForAssist = riskPauseTrace
    }

    if (suggestedTrace.suggestion?.kind === "complete") {
      const completionResult = await completePath({
        sessionID: input.sessionID,
        todos: input.todos,
        suggestion: suggestedTrace.suggestion,
        roundCount: input.autonomousRounds,
        trace: suggestedTrace,
      })
      if (completionResult.adopted) {
        return {
          kind: "complete" as const,
          adopted: true,
          outcome: completionResult.outcome,
          trace: completionResult.trace,
        }
      }
      traceForAssist = completionResult.trace ?? traceForAssist
    }

    if (suggestedTrace.suggestion?.kind === "ask_user" && askUserAdoption.reason) {
      traceForAssist = annotateSmartRunnerAskUserAdoption({
        trace: suggestedTrace,
        adopted: askUserAdoption.adopted,
        reason: askUserAdoption.reason,
      })
      if (askUserAdoption.adopted && askUserQuestion) {
        const adoptedResult = await askUser({
          sessionID: input.sessionID,
          question: askUserQuestion,
          trace: traceForAssist,
          lastUser: input.lastUser,
        })
        return {
          kind: "ask_user" as const,
          adopted: askUserAdoption.adopted,
          outcome: adoptedResult.outcome,
          trace: traceForAssist,
        }
      }
    }

    const adoptedReplan = await replan({
      sessionID: input.sessionID,
      todos: input.todos,
      suggestion: suggestedTrace.suggestion,
      roundCount: input.autonomousRounds,
      fallbackDecision: input.decision,
    })
    const adoptedDecision = adoptedReplan.decision
    const assist = applyAssist({
      enabled: smartRunnerGovernor.assist,
      decision: adoptedDecision,
      trace: traceForAssist,
    })
    const tracedAssist = annotateSmartRunnerTraceAssist({
      trace: annotateSmartRunnerReplanAdoption({
        trace: traceForAssist,
        adopted: adoptedReplan.adopted,
        reason: adoptedReplan.reason,
      }),
      enabled: smartRunnerGovernor.assist,
      assist,
      originalText: adoptedDecision.text,
    })
    await persistTrace({
      sessionID: input.sessionID,
      trace: tracedAssist,
    })
    if (adoptedReplan.adopted) {
      return {
        kind: "replan_required" as const,
        trace: tracedAssist,
      }
    }
    return {
      kind: "continue" as const,
      continueDecision: assist.applied
        ? {
            ...assist.decision,
            text: prefixSmartRunnerText(assist.decision.text),
          }
        : assist.decision,
      narrationOverride:
        assist.applied && assist.narration ? prefixSmartRunnerText(assist.narration) : assist.narration,
      trace: tracedAssist,
      adoptedReplan,
    }
  }

  async function runLoop(sessionID: string, options?: { replaceRuntime?: boolean }) {
    const runtime = start(sessionID, { replace: options?.replaceRuntime })
    if (!runtime) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        enqueueCallback(sessionID, { resolve, reject })
      })
    }

    const abort = runtime.signal
    using _ = defer(() => finishRuntime(sessionID, runtime.runID))

    let structuredOutput: unknown | undefined

    let step = 0
    let autonomousRounds = 0
    const session = await Session.get(sessionID)
    const cachedInstructionPrompts = await InstructionPrompt.system()
    const environmentCache = new Map<string, string[]>()
    debugCheckpoint("prompt", "loop:session_loaded", {
      sessionID,
      parentID: session.parentID,
      isSubagent: !!session.parentID,
      title: session.title,
    })
    while (true) {
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

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
          if (part.type === "compaction") {
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
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
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

      const model = await Provider.getModel(lastUser.model.providerId, lastUser.model.modelID).catch((e) => {
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
          onMetadata: (input) => {
            // Metadata persistence can be handled here if needed in the future
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
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
        })
        if (result === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
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

      const tools = await resolveTools({
        agent,
        session,
        model: activeModel,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
      })

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

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        accountId: lastUser.model.accountId,
        system: [
          await getPreloadedContext(sessionID),
          ...environmentPrompts,
          // Only include heavy instruction prompts (AGENTS.md) for Main Agents (no parentID).
          // Subagents should rely on the task description and SYSTEM.md.
          ...(session.parentID ? [] : instructionPrompts),
          ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
        ],
        messages: [
          ...MessageV2.toModelMessages(sessionMessages, activeModel),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
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
              `Bounded or execution-shaping questions must use MCP question; allowed endings are question tool, plan_exit, or non-question progress summary.`,
          }).toObject()
          await Session.updateMessage(processor.message)
          break
        }

        const decision = await decideAutonomousContinuation({
          sessionID,
          roundCount: autonomousRounds,
        })
        let continueDecision = decision.continue ? decision : undefined
        let narrationOverride: string | undefined
        if (decision.continue) {
          const todos = await Todo.get(sessionID)
          const stopResult = await handleSmartRunnerStopDecision({
            sessionID,
            activeModel,
            autonomousRounds,
            lastUser,
            messages: msgs,
            todos,
            decision,
            mission: session.mission,
          })
          if (stopResult.kind === "ask_user") {
            if (stopResult.outcome === "answered") continue
            break
          }
          if (stopResult.kind === "request_approval") {
            await handleSmartRunnerAdoptedStopNarration({
              sessionID,
              user: lastUser,
              text: stopResult.trace?.decision?.nextAction.narration,
            })
            break
          }
          if (stopResult.kind === "pause_for_risk") {
            await handleSmartRunnerAdoptedStopNarration({
              sessionID,
              user: lastUser,
              text: stopResult.trace?.decision?.nextAction.narration,
            })
            break
          }
          if (stopResult.kind === "complete") {
            await handleSmartRunnerAdoptedStopNarration({
              sessionID,
              user: lastUser,
              text: stopResult.trace?.decision?.nextAction.narration,
              kind: "complete",
            })
            break
          }
          if (stopResult.kind === "replan_required") {
            await handleSmartRunnerAdoptedStopNarration({
              sessionID,
              user: lastUser,
              text:
                stopResult.trace?.decision?.nextAction.narration ?? "Planner re-entry required before continuation.",
            })
            await Session.setWorkflowState({
              sessionID,
              state: "waiting_user",
              stopReason: "replan_required",
              lastRunAt: Date.now(),
            })
            break
          }
          continueDecision = stopResult.continueDecision
          narrationOverride = stopResult.narrationOverride
        }
        const narration = continueDecision
          ? describeAutonomousNextAction({
              type: "continue",
              reason: continueDecision.reason,
              text: continueDecision.text,
              todo: continueDecision.todo,
            })
          : describeAutonomousNextAction({
              type: "stop",
              reason: decision.reason as Exclude<typeof decision.reason, "todo_pending" | "todo_in_progress">,
            })
        if (continueDecision) {
          const continuationResult = await handleSmartRunnerContinuationSideEffects({
            sessionID,
            user: lastUser,
            decision: continueDecision,
            narrationOverride,
            autonomousRounds,
          })
          autonomousRounds = continuationResult.nextRoundCount
          if (continuationResult.halted) break
          continue
        }
        if (
          [
            "approval_needed",
            "product_decision_needed",
            "wait_subagent",
            "mission_not_approved",
            "mission_not_consumable",
            "spec_dirty",
            "replan_required",
            "max_continuous_rounds",
            "todo_complete",
          ].includes(decision.reason)
        ) {
          await emitAutonomousNarration({
            sessionID,
            parentID: lastUser.id,
            agent: lastUser.agent,
            variant: lastUser.variant,
            model: lastUser.model,
            text: narration.text,
            kind: narration.kind,
          })
        }
        if (decision.reason === "todo_complete") {
          await Session.setWorkflowState({
            sessionID,
            state: "completed",
            stopReason: "todo_complete",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "max_continuous_rounds") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "max_continuous_rounds",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "approval_needed") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "approval_needed",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "product_decision_needed") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "product_decision_needed",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "wait_subagent") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "wait_subagent",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "mission_not_approved") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "mission_not_approved",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "mission_not_consumable") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "mission_not_consumable",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "spec_dirty") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "spec_dirty",
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "replan_required") {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: "replan_required",
            lastRunAt: Date.now(),
          })
        }
        break
      }
      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          format: lastUser.format,
          auto: true,
        })
      }
      continue
    }
    SessionCompaction.prune({ sessionID })
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = consumeCallbacks(sessionID)
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => runLoop(sessionID))

  async function createUserMessage(input: PromptInput) {
    const effectiveAgent = shouldAutoEnterPlanMode(input) ? "plan" : input.agent
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
