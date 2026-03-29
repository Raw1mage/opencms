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
  shouldInterruptAutonomousRun,
} from "./workflow-runner"
import { consumeMissionArtifacts, deriveDelegatedExecutionRole } from "./mission-consumption"
import { type PlannerIntent, resolveDialogTriggerPolicy } from "./dialog-trigger"

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

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    // Ensure workflow exists with autonomous always-on; reset completed sessions to idle
    await Session.update(
      input.sessionID,
      (draft) => {
        const current = draft.workflow ?? Session.defaultWorkflow(draft.time.updated)
        if (!draft.workflow || current.state === "completed") {
          draft.workflow = {
            ...current,
            autonomous: { ...current.autonomous, enabled: true },
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

  export async function handleContinuationSideEffects(input: {
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
    const todo = input.decision.todo!
    const delegation = missionConsumption?.ok
      ? deriveDelegatedExecutionRole({
          todo,
          mission: missionConsumption.trace,
        })
      : undefined
    const narration = describeAutonomousNextAction({
      type: "continue",
      reason: input.decision.reason,
      text: input.decision.text,
      todo,
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
          ? `Continue with the next planned ${delegation.role} step: ${todo.content}`
          : input.decision.text,
      delegation,
    })
    return {
      halted: false as const,
      nextRoundCount,
      narration,
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
    let emptyRoundCount = 0
    const session = await Session.get(sessionID)
    const cachedInstructionPrompts = await InstructionPrompt.system()
    const environmentCache = new Map<string, string[]>()

    // Context Sharing v2: load parent messages once for child sessions.
    // These form a stable prefix in every LLM call → automatic cache hit.
    let parentMessagePrefix: MessageV2.WithParts[] | undefined
    if (session.parentID) {
      parentMessagePrefix = await MessageV2.filterCompacted(MessageV2.stream(session.parentID))
      log.info("context sharing: loaded parent messages", {
        sessionID,
        parentID: session.parentID,
        parentMessageCount: parentMessagePrefix.length,
      })
    }

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
          lastAssistant.error = {
            name: "EmptyResponseError",
            message: `Model returned empty responses ${emptyRoundCount} times consecutively. This may indicate an issue with the provider, account, or session context. Try sending a different message or starting a new session.`,
          }
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
      if (task?.type === "compaction") {
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

      // context overflow OR cache-aware compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        ((await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model, sessionID, currentRound: step })) ||
          (await SessionCompaction.shouldCacheAwareCompact({ tokens: lastFinished.tokens, model, sessionID, currentRound: step })))
      ) {
        SessionCompaction.recordCompaction(sessionID, step)
        // Priority path: use shared context snapshot as summary (no LLM call)
        if (!session.parentID) {
          const overflowConfig = await Config.get()
          if (overflowConfig.compaction?.sharedContext !== false) {
            const snap = await SharedContext.snapshot(sessionID)
            if (snap) {
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
        accountId: effectiveAccountId,
        system: [
          await getPreloadedContext(sessionID),
          ...environmentPrompts,
          // Only include heavy instruction prompts (AGENTS.md) for Main Agents (no parentID).
          // Subagents should rely on the task description and SYSTEM.md.
          ...(session.parentID ? [] : instructionPrompts),
          ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
        ],
        messages: [
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

        // ── Deterministic continuation decision ──────────────────────
        // No LLM governor. Three conditions: autonomous enabled + plan exists + pending todo.
        const decision = await decideAutonomousContinuation({
          sessionID,
          roundCount: autonomousRounds,
        })
        if (decision.continue) {
          const continuationResult = await handleContinuationSideEffects({
            sessionID,
            user: lastUser,
            decision,
            autonomousRounds,
          })
          autonomousRounds = continuationResult.nextRoundCount
          if (continuationResult.halted) {
            debugCheckpoint("prompt", "loop:continuation_halted", {
              sessionID,
              step,
              autonomousRounds,
            })
            break
          }
          continue
        }
        // Stopped — emit narration and set workflow state
        const narration = describeAutonomousNextAction({
          type: "stop",
          reason: decision.reason as Exclude<typeof decision.reason, "todo_pending" | "todo_in_progress">,
        })
        const NARRATED_STOP_REASONS = [
          "approval_needed",
          "product_decision_needed",
          "wait_subagent",
          "mission_not_approved",
          "max_continuous_rounds",
          "todo_complete",
        ] as const
        if ((NARRATED_STOP_REASONS as readonly string[]).includes(decision.reason)) {
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
        const completedReasons = ["todo_complete"] as const
        const waitingReasons = [
          "max_continuous_rounds",
          "approval_needed",
          "product_decision_needed",
          "mission_not_approved",
        ] as const
        if ((completedReasons as readonly string[]).includes(decision.reason)) {
          await Session.setWorkflowState({
            sessionID,
            state: "completed",
            stopReason: decision.reason,
            lastRunAt: Date.now(),
          })
        } else if (decision.reason === "wait_subagent") {
          // Subagent still running — set idle so supervisor auto-resumes
          // when task-worker-continuation enqueues task_completion.
          // Do NOT set waiting_user: that requires manual user push.
          await Session.setWorkflowState({
            sessionID,
            state: "idle",
            stopReason: "wait_subagent",
            lastRunAt: Date.now(),
          })
        } else if ((waitingReasons as readonly string[]).includes(decision.reason)) {
          await Session.setWorkflowState({
            sessionID,
            state: "waiting_user",
            stopReason: decision.reason,
            lastRunAt: Date.now(),
          })
        }
        debugCheckpoint("prompt", "loop:continuation_stopped", {
          sessionID,
          step,
          reason: decision.reason,
          autonomousRounds,
        })
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

    // ── Shared Context: incremental update + idle compaction at turn boundary ──
    {
      const config = await Config.get()
      if (config.compaction?.sharedContext !== false) {
        try {
          // Find the last assistant message to extract parts
          const finalMsgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
          const lastAssistantMsg = finalMsgs.findLast((m) => m.info.role === "assistant")
          if (lastAssistantMsg) {
            const assistantText = lastAssistantMsg.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")

            // 1. Incremental update — runs for all sessions (parent + child)
            await SharedContext.updateFromTurn({
              sessionID,
              parts: lastAssistantMsg.parts,
              assistantText,
              turnNumber: step,
            })

            // 2. Idle compaction: only for parent sessions, only when task dispatched
            // In daemon fire-and-forget mode, task parts are "running" at turn boundary
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

  async function createUserMessage(
    input: PromptInput,
    session: Session.Info,
  ): Promise<{ info: MessageV2.User; parts: MessageV2.WithParts["parts"] }> {
    const committedPlannerIntent = await getCommittedPlannerIntent(input.sessionID)
    const triggerPolicy = await resolveDialogTriggerPolicy({
      agent: input.agent,
      client: Flag.OPENCODE_CLIENT,
      parts: input.parts,
      session,
      committedPlannerIntent,
    })
    const triggerDecision = triggerPolicy.decision

    if (triggerPolicy.autoPlanExitHandoff) {
      const { PlanExitTool } = await import("../tool/plan")
      await ToolInvoker.execute(PlanExitTool, {
        sessionID: input.sessionID,
        messageID: input.messageID ?? Identifier.ascending("message"),
        toolID: "plan_exit",
        args: {},
        agent: "build",
        abort: AbortSignal.timeout(30_000),
        messages: [],
      })
      const sessionMessages = await Session.messages({ sessionID: input.sessionID })
      const latestUser = sessionMessages.findLast((message) => message.info.role === "user")
      if (!latestUser) throw new Error("plan_exit handoff did not produce a synthetic user message")
      return {
        info: latestUser.info as MessageV2.User,
        parts: latestUser.parts,
      }
    }

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

  export async function getCommittedPlannerIntent(sessionID: string): Promise<PlannerIntent | undefined> {
    const session = await Session.get(sessionID)
    const metadataIntent = session.planner?.committedIntent
    if (metadataIntent) return metadataIntent

    for await (const message of MessageV2.stream(sessionID)) {
      if (message.info.role !== "assistant") continue
      if (!isNarrationAssistantMessage(message.info, message.parts)) continue
      const text = message.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .map((part) => part.text.toLowerCase())
        .join("\n")
      if (/\bplan_exit\b|switch to build mode|build mode/.test(text)) return "plan_exit"
      if (/\bplan_enter\b|enter plan mode|plan mode/.test(text)) return "plan_enter"
      return undefined
    }
    return undefined
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
