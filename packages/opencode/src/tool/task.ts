import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { Provider } from "../provider/provider"
import { debugCheckpoint } from "@/util/debug"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  model: z.string().describe("Optional model ID to use for this task (e.g. 'openai/gpt-5.1-codex-mini')").optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      debugCheckpoint("task", "Task tool execute started", {
        description: params.description,
        subagent_type: params.subagent_type,
        model_param: params.model,
        session_id: params.session_id,
      })

      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      debugCheckpoint("task", "Agent loaded", { agentName: agent.name, agentModel: agent.model })

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const modelArg = params.model ? Provider.parseModel(params.model) : undefined
      const model = modelArg ??
        agent.model ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }

      debugCheckpoint("task", "Model resolved for subagent", {
        modelArg,
        agentModel: agent.model,
        parentModel: { modelID: msg.info.modelID, providerID: msg.info.providerID },
        finalModel: model,
      })

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
          },
        })
      })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      // const modelInfo = await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
      // const auto = params.description.toLowerCase().startsWith("auto ")
      // const allowImages = !auto && (modelInfo?.capabilities?.input?.image ?? false)

      // Extract image attachments from parent session's messages and pass to subagent
      // This allows images pasted by the user (displayed as [Image N]) to be visible to subagents
      /*
      const parentUserMessage = ctx.messages.findLast((m) => m.info.role === "user")
      if (parentUserMessage) {
        const imageAttachments = parentUserMessage.parts.filter(
          (part): part is MessageV2.FilePart => part.type === "file" && part.mime?.startsWith("image/"),
        )
        for (const img of imageAttachments) {
          if (!allowImages) {
            debugCheckpoint("task", "Skipping image for subagent", {
              filename: img.filename,
              mime: img.mime,
              reason: auto ? "auto_task" : "model_no_image_support",
            })
            continue
          }
          if (img.url.startsWith("data:")) {
            const match = img.url.match(/^data:([^;]+);base64,(.*)$/)
            if (!match || !match[2]) {
              debugCheckpoint("task", "Skipping invalid image data URL", {
                filename: img.filename,
                mime: img.mime,
              })
              continue
            }
          }
          debugCheckpoint("task", "Passing image to subagent", {
            filename: img.filename,
            mime: img.mime,
          })
          promptParts.push({
            type: "file",
            url: img.url,
            mime: img.mime,
            filename: img.filename,
          })
        }
      }
      */

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          ...(hasTaskPermission ? {} : { task: false }),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      }).finally(() => {
        unsub()
      })

      const messages = await Session.messages({ sessionID: session.id })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
      const info = result.info as any

      if (info.error) {
        throw new Error(`Subagent task failed: ${info.error.message || JSON.stringify(info.error)}`)
      }

      const output = text + "\n\n" + ["<task_metadata>", `session_id: ${session.id}`, "</task_metadata>"].join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})
