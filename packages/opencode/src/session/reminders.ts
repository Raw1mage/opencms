import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Agent } from "../agent/agent"

export async function insertReminders(input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  return input.messages
}
