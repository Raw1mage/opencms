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
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`
  return `${s}s`
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

const textStep = (part: Part) => (part.type === "text" ? compact(part.text) : undefined)

const reasoningStep = (part: Part) => (part.type === "reasoning" ? compact(part.text) : undefined)

export const deriveActiveChildStatus = (input: {
  activeChild: ActiveChildState
  messages: Message[]
  partsByMessage: Record<string, Part[] | undefined>
}): DerivedActiveChildStatus => {
  const title = compact(input.activeChild.title, 120) ?? "Subagent"
  const seeded = compact(input.activeChild.todo?.content)

  let latestText: string | undefined
  let latestTool: string | undefined
  let latestReasoning: string | undefined

  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i]
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage[message.id] ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      latestText ??= textStep(part)
      latestTool ??= toolStep(part)
      latestReasoning ??= reasoningStep(part)
    }
  }

  const liveStep = latestText ?? latestTool ?? latestReasoning
  if (liveStep) return { title, step: liveStep }

  if (seeded) return { title, step: seeded }

  return { title, step: FALLBACK_STEP[input.activeChild.status] }
}

export const childSessionHref = (directory: string, sessionID: string) =>
  `/${base64Encode(directory)}/session/${sessionID}`
