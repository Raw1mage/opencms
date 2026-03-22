import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/util/encode"

export const questionSubtitle = (count: number, t: (key: string) => string) => {
  if (count === 0) return ""
  return `${count} ${t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
}

type ActiveChildTodo = {
  content?: string
}

type ActiveChildState = {
  sessionID: string
  title: string
  agent: string
  status: "running" | "handoff"
  todo?: ActiveChildTodo
}

type DerivedActiveChildStatus = {
  title: string
  step: string
}

export const formatElapsedSeconds = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

export const formatActiveChildAgentLabel = (agent: string) => {
  const normalized = agent.trim().replace(/^@+/, "")
  return normalized ? `@${normalized}` : "@agent"
}

const FALLBACK_STEP = {
  running: "Working...",
  handoff: "Handing off...",
} as const

const compact = (value: string | undefined, max = 160) => {
  const trimmed = value?.replace(/\s+/g, " ").trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

const toolStep = (part: Part) => {
  if (part.type !== "tool") return undefined
  const state = part.state as
    | {
        status?: string
        title?: string
        input?: { description?: string; command?: string }
      }
    | undefined
  if (state?.status !== "running" && state?.status !== "pending") return undefined
  return compact(state.input?.description) ?? compact(state.title) ?? compact(state.input?.command)
}

const partStep = (part: Part) => {
  if (part.type === "tool") return toolStep(part)
  if (part.type === "reasoning") return compact(part.text)
  if (part.type === "text") return compact(part.text)
  return undefined
}

export const deriveActiveChildStatus = (input: {
  activeChild: ActiveChildState
  messages: Message[]
  partsByMessage: Record<string, Part[] | undefined>
}): DerivedActiveChildStatus => {
  const title = compact(input.activeChild.title, 120) ?? "Subagent"
  const seeded = compact(input.activeChild.todo?.content)
  if (seeded) return { title, step: seeded }

  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i]
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage[message.id] ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const step = partStep(parts[j])
      if (step) return { title, step }
    }
  }

  return { title, step: FALLBACK_STEP[input.activeChild.status] }
}

export const childSessionHref = (directory: string, sessionID: string) =>
  `/${base64Encode(directory)}/session/${sessionID}`
