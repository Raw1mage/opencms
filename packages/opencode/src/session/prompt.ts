import z from "zod"
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
import { Bus } from "../bus"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { clone } from "remeda"
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
import { SessionStatus } from "./status"
import {
  assertNotBusy as assertNotBusyRuntime,
  start as startRuntime,
  cancel as cancelRuntime,
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

globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

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
    system: z.string().optional(),
    variant: z.string().optional(),
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

    return loop(input.sessionID)
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    return (await resolvePromptPartsInner(template)) as PromptInput["parts"]
  }

  function start(sessionID: string) {
    return startRuntime(sessionID)
  }

  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    return cancelRuntime(sessionID)
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    const abort = start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        enqueueCallback(sessionID, { resolve, reject })
      })
    }

    using _ = defer(() => cancel(sessionID))

    let step = 0
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
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
      ) {
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
          const attachments = result.attachments?.map(
            (attachment: Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID">) => ({
              ...attachment,
              id: Identifier.ascending("part"),
              messageID: assistantMessage.id,
              sessionID: assistantMessage.sessionID,
            }),
          )
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
          auto: true,
        })
        continue
      }

      // normal processing
      const userMsg = msgs.findLast((m) => m.info.role === "user")
      const imageResolution = await resolveImageRequest({ model, message: userMsg, sessionID })
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
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model: activeModel,
        abort,
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

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
        environmentPrompts = await SystemPrompt.environment(activeModel)
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
        system: [
          await getPreloadedContext(sessionID),
          ...environmentPrompts,
          // Include instruction prompts (AGENTS.md/CLAUDE.md) for all sessions (including subagents)
          // to ensure consistent behavioral standards across the system.
          ...instructionPrompts,
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
      })
      if (result === "stop") break
      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
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
  })

  async function createUserMessage(input: PromptInput) {
    const { agent, partsInput, info } = await prepareUserMessageContext({
      sessionID: input.sessionID,
      messageID: input.messageID,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      noReply: input.noReply,
      tools: input.tools,
      system: input.system,
      parts: input.parts,
    })
    using _ = defer(() => InstructionPrompt.clear(info.id))

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
      agent: input.agent,
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
      })
      .optional(),
    variant: z.string().optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }
    using _ = defer(() => cancel(input.sessionID))

    return runShellPrompt(input, abort)
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
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
