import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Session } from "."
import { MessageV2 } from "./message-v2"

export type SessionNarrationKind = "continue" | "pause" | "complete" | "interrupt" | "task"

export async function emitSessionNarration(input: {
  sessionID: string
  parentID: string
  agent: string
  variant?: string
  model: {
    providerId: string
    modelID: string
    accountId?: string
  }
  text: string
  kind: SessionNarrationKind
  metadata?: Record<string, unknown>
}) {
  const created = Date.now()
  const assistantMessage: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID: input.parentID,
    sessionID: input.sessionID,
    mode: input.agent,
    agent: input.agent,
    variant: input.variant,
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
    modelID: input.model.modelID,
    providerId: input.model.providerId,
    accountId: input.model.accountId,
    finish: "stop",
    time: {
      created,
      completed: created,
    },
  }
  await Session.updateMessage(assistantMessage)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistantMessage.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
    synthetic: true,
    metadata: {
      autonomousNarration: true,
      narrationKind: input.kind,
      excludeFromModel: true,
      ...(input.metadata ?? {}),
    },
    time: {
      start: created,
      end: created,
    },
  } satisfies MessageV2.TextPart)
}

export function isNarrationAssistantMessage(message: MessageV2.WithParts["info"], parts: MessageV2.Part[]) {
  if (message.role !== "assistant") return false
  if (parts.length === 0) return false
  return parts.every(
    (part) =>
      part.type === "text" &&
      part.synthetic === true &&
      part.metadata?.autonomousNarration === true &&
      part.metadata?.excludeFromModel === true,
  )
}

export function describeTaskNarration(
  input:
    | { phase: "start"; description?: string; subagentType?: string }
    | { phase: "complete"; title?: string; output?: string }
    | { phase: "error"; error: string },
) {
  if (input.phase === "start") {
    const target = input.description?.trim() || "delegated step"
    return `Delegating${input.subagentType ? ` to ${input.subagentType}` : ""}: ${target}`
  }
  if (input.phase === "complete") {
    const label = input.title?.trim() || input.output?.trim().split("\n")[0] || "Subagent work finished"
    return `Subagent completed: ${label}`
  }
  return `Subagent blocked: ${input.error.slice(0, 160)}`
}
