import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { lastModel } from "./last-model"
import { maybeInjectWorkflowSubtasks } from "./subagent-workflow"

type InputModel = { providerId: string; modelID: string; accountId?: string }

type InputPart = {
  type: string
  id?: string
  mime?: string
  text?: string
}

export async function prepareUserMessageContext(input: {
  sessionID: string
  messageID?: string
  agent?: string
  model?: InputModel
  format?: MessageV2.OutputFormat
  variant?: string
  noReply?: boolean
  tools?: Record<string, boolean>
  system?: string
  parts: InputPart[]
}) {
  const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))
  const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))

  const variant =
    input.variant ??
    (agent.variant &&
    agent.model &&
    model.providerId === agent.model.providerId &&
    model.modelID === agent.model.modelID
      ? agent.variant
      : undefined)

  const partsInput = (await maybeInjectWorkflowSubtasks({
    parts: input.parts,
    agent,
    noReply: input.noReply,
  })) as InputPart[]

  const info: MessageV2.Info = {
    id: input.messageID ?? Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    time: {
      created: Date.now(),
    },
    tools: input.tools,
    agent: agent.name,
    model,
    format: input.format,
    system: input.system,
    variant,
  }

  return {
    agent,
    model,
    variant,
    partsInput,
    info,
  }
}
