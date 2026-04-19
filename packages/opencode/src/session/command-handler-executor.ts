import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { SessionRevert } from "./revert"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { Command } from "../command"
import { lastModel } from "./last-model"

export async function executeHandledCommand(input: {
  commandInfo: Command.Info & {
    handler: (ctx?: Command.HandlerContext) => Promise<{ output: string; title?: string }>
  }
  command: string
  sessionID: string
  arguments: string
  agent?: string
  model?: string | { providerId: string; modelID: string; accountId?: string }
  messageID?: string
  variant?: string
}): Promise<MessageV2.WithParts> {
  const session = await Session.get(input.sessionID)
  if (session.revert) {
    await SessionRevert.cleanup(session)
  }

  const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))
  const model =
    typeof input.model === "string"
      ? Provider.parseModel(input.model)
      : (input.model ?? agent.model ?? (await lastModel(input.sessionID)))
  const modelAccountId = "accountId" in model && typeof model.accountId === "string" ? model.accountId : undefined

  const variant =
    input.variant ??
    (agent.variant &&
    agent.model &&
    model.providerId === agent.model.providerId &&
    model.modelID === agent.model.modelID
      ? agent.variant
      : undefined)

  const userMsg: MessageV2.User = {
    id: input.messageID ?? Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    time: { created: Date.now() },
    agent: agent.name,
    model,
    variant,
  }
  await Session.updateMessage(userMsg)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: userMsg.id,
    sessionID: input.sessionID,
    type: "text",
    text: `/${input.command}${input.arguments && input.arguments.trim() ? " " + input.arguments : ""}`,
  })

  const assistantMsg: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    parentID: userMsg.id,
    mode: agent.name,
    agent: agent.name,
    variant: userMsg.variant,
    cost: 0,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    time: { created: Date.now() },
    role: "assistant",
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: model.modelID,
    providerId: model.providerId,
    accountId: modelAccountId,
    finish: "stop",
  }
  await Session.updateMessage(assistantMsg)

  const result = await input.commandInfo.handler({ sessionID: input.sessionID })

  const part = await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistantMsg.id,
    sessionID: input.sessionID,
    type: "text",
    text: result.output,
    metadata: result.title ? { title: result.title } : undefined,
  })

  assistantMsg.time.completed = Date.now()
  await Session.updateMessage(assistantMsg)

  Bus.publish(Command.Event.Executed, {
    name: input.command,
    sessionID: input.sessionID,
    arguments: input.arguments,
    messageID: assistantMsg.id,
  })

  return {
    info: assistantMsg,
    parts: [part],
  }
}
