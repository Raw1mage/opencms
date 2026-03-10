import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Bus } from "../bus"
import { Session } from "."
import { NamedError } from "@opencode-ai/util/error"
import { lastModel } from "./last-model"
import { MessageV2 } from "./message-v2"
import { Command } from "../command"

export interface CommandPromptPrepInput {
  commandInfo: Command.Info
  commandName: string
  sessionID: string
  inputAgent?: string
  inputModel?: string | { providerId: string; modelID: string; accountId?: string }
  inputParts?: Array<{
    type: "file"
    url: string
    mime: string
    id?: string
    filename?: string
    source?: MessageV2.FilePart["source"]
  }>
  template: string
  resolvePromptParts: (template: string) => Promise<any[]>
}

export async function prepareCommandPrompt(input: CommandPromptPrepInput) {
  const parseInputModel = (value: CommandPromptPrepInput["inputModel"]) => {
    if (!value) return undefined
    return typeof value === "string" ? Provider.parseModel(value) : value
  }

  const command = input.commandInfo
  const agentName = command.agent ?? input.inputAgent ?? (await Agent.defaultAgent())

  const taskModel = await (async () => {
    if (command.model) {
      return Provider.parseModel(command.model)
    }
    if (command.agent) {
      const cmdAgent = await Agent.get(command.agent)
      if (cmdAgent?.model) {
        return cmdAgent.model
      }
    }
    const parsedInputModel = parseInputModel(input.inputModel)
    if (parsedInputModel) return parsedInputModel
    return await lastModel(input.sessionID)
  })()

  try {
    await Provider.getModel(taskModel.providerId, taskModel.modelID)
  } catch (e) {
    if (Provider.ModelNotFoundError.isInstance(e)) {
      const { providerId, modelID, suggestions } = e.data
      const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: new NamedError.Unknown({ message: `Model not found: ${providerId}/${modelID}.${hint}` }).toObject(),
      })
    }
    throw e
  }

  const agent = await Agent.get(agentName)
  if (!agent) {
    const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
    const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
    const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
    Bus.publish(Session.Event.Error, {
      sessionID: input.sessionID,
      error: error.toObject(),
    })
    throw error
  }

  const templateParts = await input.resolvePromptParts(input.template)
  const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
  const parts = isSubtask
    ? [
        {
          type: "subtask" as const,
          agent: agent.name,
          description: command.description ?? "",
          command: input.commandName,
          model: {
            providerId: taskModel.providerId,
            modelID: taskModel.modelID,
          },
          prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          prompt_input: {
            type: "implementation" as const,
            content: templateParts.find((y) => y.type === "text")?.text ?? "",
            metadata: {
              source: "command",
              command: input.commandName,
              partTypes: templateParts.map((part) => part.type),
            },
          },
        },
      ]
    : [...templateParts, ...(input.inputParts ?? [])]

  const userAgent = isSubtask ? (input.inputAgent ?? (await Agent.defaultAgent())) : agentName
  const userModel = isSubtask ? (parseInputModel(input.inputModel) ?? (await lastModel(input.sessionID))) : taskModel

  return {
    parts,
    userAgent,
    userModel,
    taskModel,
  }
}
