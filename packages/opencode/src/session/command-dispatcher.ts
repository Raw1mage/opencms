import { Plugin } from "../plugin"
import { Bus } from "../bus"
import { Command } from "../command"
import { MessageV2 } from "./message-v2"

type CommandPromptPart = unknown

export async function dispatchCommandPrompt(input: {
  commandName: string
  sessionID: string
  argumentsText: string
  parts: CommandPromptPart[]
  invoke: () => Promise<MessageV2.WithParts>
}): Promise<MessageV2.WithParts> {
  await Plugin.trigger(
    "command.execute.before",
    {
      command: input.commandName,
      sessionID: input.sessionID,
      arguments: input.argumentsText,
    },
    { parts: input.parts },
  )

  const result = await input.invoke()

  Bus.publish(Command.Event.Executed, {
    name: input.commandName,
    sessionID: input.sessionID,
    arguments: input.argumentsText,
    messageID: result.info.id,
  })

  return result
}
