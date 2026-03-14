import path from "path"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Agent } from "../agent/agent"
import PROMPT_PLAN from "../session/prompt/plan.txt"

export async function insertReminders(input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (input.agent.name === "plan") {
    userMessage.parts.push({
      id: Identifier.ascending("part"),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: PROMPT_PLAN,
      synthetic: true,
    })
    return input.messages
  }

  return input.messages
}
