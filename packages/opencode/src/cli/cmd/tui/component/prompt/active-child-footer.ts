import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { ActiveChildState } from "@tui/context/sync"

export type DerivedActiveChildFooter = {
  agentLabel: string
  title: string
  step: string
}

const FALLBACK_STEP = {
  running: "Working...",
  handoff: "Handing off...",
} as const

const AGENT_LABELS = ["coding", "explore", "testing", "review", "build", "plan"] as const

const compact = (value: string | undefined, max = 120) => {
  const trimmed = value?.replace(/\s+/g, " ").trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

const agentLabel = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return "@agent"
  const matched = AGENT_LABELS.find((item) => normalized === item || normalized.startsWith(`${item}-`))
  return `@${matched ?? "agent"}`
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

export function deriveActiveChildFooter(input: {
  activeChild: ActiveChildState
  messages: Message[]
  partsByMessage: Record<string, Part[] | undefined>
}): DerivedActiveChildFooter {
  const title = compact(input.activeChild.title, 56) ?? "Subagent"
  const label = agentLabel(input.activeChild.agent)
  const seeded = compact(input.activeChild.todo?.content)
  if (seeded) return { agentLabel: label, title, step: seeded }

  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i]
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage[message.id] ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const step = partStep(parts[j])
      if (step) return { agentLabel: label, title, step }
    }
  }

  return { agentLabel: label, title, step: FALLBACK_STEP[input.activeChild.status] }
}
