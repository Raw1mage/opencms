import { Identifier } from "../id/id"
import { Session } from "."
import { SessionRevert } from "./revert"
import { Agent } from "../agent/agent"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { ulid } from "ulid"
import { executeShellCommand } from "./shell-executor"
import { lastModel } from "./last-model"

export interface ShellRunInput {
  sessionID: string
  agent: string
  model?: {
    providerId: string
    modelID: string
    accountId?: string
  }
  variant?: string
  command: string
}

export async function runShellPrompt(input: ShellRunInput, abort: AbortSignal): Promise<MessageV2.WithParts> {
  const session = await Session.get(input.sessionID)
  if (session.revert) {
    await SessionRevert.cleanup(session)
  }
  const agent = await Agent.get(input.agent)
  const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
  const modelAccountId = "accountId" in model && typeof model.accountId === "string" ? model.accountId : undefined

  const userMsg: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    time: {
      created: Date.now(),
    },
    role: "user",
    agent: input.agent,
    variant: input.variant,
    model: {
      providerId: model.providerId,
      modelID: model.modelID,
      accountId: modelAccountId,
    },
  }
  await Session.updateMessage(userMsg)
  const userPart: MessageV2.Part = {
    type: "text",
    id: Identifier.ascending("part"),
    messageID: userMsg.id,
    sessionID: input.sessionID,
    text: "The following tool was executed by the user",
    synthetic: true,
  }
  await Session.updatePart(userPart)

  const msg: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    parentID: userMsg.id,
    mode: input.agent,
    agent: input.agent,
    variant: userMsg.variant,
    cost: 0,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    time: {
      created: Date.now(),
    },
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
  }
  await Session.updateMessage(msg)
  const part: MessageV2.Part = {
    type: "tool",
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID: input.sessionID,
    tool: "bash",
    callID: ulid(),
    state: {
      status: "running",
      time: {
        start: Date.now(),
      },
      input: {
        command: input.command,
      },
    },
  }
  await Session.updatePart(part)

  const { output } = await executeShellCommand({
    command: input.command,
    abort,
    cwd: Instance.directory,
    onLiveOutput: (liveOutput) => {
      if (part.state.status === "running") {
        part.state.metadata = {
          output: liveOutput,
          description: "",
        }
        void Session.updatePart(part)
      }
    },
  })

  msg.time.completed = Date.now()
  await Session.updateMessage(msg)
  if (part.state.status === "running") {
    part.state = {
      status: "completed",
      time: {
        ...part.state.time,
        end: Date.now(),
      },
      input: part.state.input,
      title: "",
      metadata: {
        output,
        description: "",
      },
      output,
    }
    await Session.updatePart(part)
  }

  return { info: msg, parts: [part] }
}
