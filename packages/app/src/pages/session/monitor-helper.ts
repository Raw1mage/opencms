import type { Message, Session, SessionMonitorInfo, SessionStatus, Part } from "@opencode-ai/sdk/v2/client"

type MonitorTodoLink = {
  id?: string
  content?: string
  status?: string
  action?: {
    kind?: string
    waitingOn?: string
    needsApproval?: boolean
  }
}

export type EnrichedMonitorEntry = SessionMonitorInfo & {
  todo?: MonitorTodoLink
  latestResult?: string
}

export const MONITOR_STATUS_LABELS: Record<string, string> = {
  busy: "Running",
  working: "Working",
  idle: "",
  error: "Error",
  retry: "Retrying",
  compacting: "Compacting",
  pending: "Pending",
}

export function monitorTitle(value: { title?: string; agent?: string }) {
  const title = value.title || "Untitled session"
  return value.agent ? `${title} (${value.agent})` : title
}

export function monitorToolStatus(value: { statusType: string; activeToolStatus?: string }) {
  const status = value.activeToolStatus
  if (!status) return undefined
  if ((value.statusType === "busy" || value.statusType === "working") && status === "running") return undefined
  if (value.statusType === "pending" && status === "pending") return undefined
  return status
}

export const MONITOR_LEVEL_LABELS: Record<string, string> = {
  session: "S",
  "sub-session": "SS",
  agent: "A",
  "sub-agent": "SA",
  tool: "T",
}

const activeStatuses = new Set(["busy", "working", "retry", "compacting", "pending"])

const formatIsoTitle = (title: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(title)) return title
  const date = new Date(title)
  if (Number.isNaN(date.getTime())) return title
  const pad = (value: number) => value.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function monitorFallbackStats(session: Session | undefined, messages: Message[]) {
  const persisted = session?.stats
  if (persisted) {
    return {
      requests: persisted.requestsTotal,
      totalTokens: persisted.totalTokens,
      tokens: persisted.tokens,
      model: undefined as { providerId: string; modelID: string } | undefined,
    }
  }

  const stats = {
    requests: 0,
    totalTokens: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    model: undefined as { providerId: string; modelID: string } | undefined,
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const total =
      msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
    if (total > 0) {
      stats.requests += 1
      if (!stats.model) {
        stats.model = {
          providerId: msg.providerId,
          modelID: msg.modelID,
        }
      }
    }
    stats.tokens.input += msg.tokens.input
    stats.tokens.output += msg.tokens.output
    stats.tokens.reasoning += msg.tokens.reasoning
    stats.tokens.cache.read += msg.tokens.cache.read
    stats.tokens.cache.write += msg.tokens.cache.write
    stats.totalTokens += total
  }

  return stats
}

export function buildMonitorEntries(input: {
  raw: SessionMonitorInfo[]
  session?: Session
  messages: Message[]
  status?: SessionStatus
  partsByMessage?: Record<string, readonly Part[] | undefined>
}) {
  const toolMeta = new Map<
    string,
    { todo?: MonitorTodoLink; result?: string; sessionID: string; agent?: string; tool: string }
  >()
  for (const message of input.messages) {
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage?.[message.id] ?? []
    for (const part of parts) {
      if (part.type !== "tool") continue
      const todo = part.metadata?.todo as MonitorTodoLink | undefined
      const result =
        part.state.status === "completed"
          ? part.state.title || "completed"
          : part.state.status === "error"
            ? part.state.error.slice(0, 120)
            : undefined
      toolMeta.set(part.id, {
        todo,
        result,
        sessionID: part.sessionID,
        agent: message.agent,
        tool: part.tool,
      })
    }
  }

  const raw = input.raw
    .filter((x) => activeStatuses.has(x.status.type))
    .slice()
    .sort((a, b) => b.updated - a.updated)

  const agentSessionIDs = new Set(raw.filter((x) => x.level === "agent").map((x) => x.sessionID))
  const deduped = raw.filter((x) => !(x.level === "session" && agentSessionIDs.has(x.sessionID)))

  if (deduped.length === 0 && input.session) {
    const fallbackStats = monitorFallbackStats(input.session, input.messages)
    const status = input.status ?? ({ type: "idle" } as const)
    return [
      {
        id: `session:${input.session.id}:fallback`,
        level: input.session.parentID ? "sub-session" : "session",
        sessionID: input.session.id,
        title: formatIsoTitle(input.session.title || "Untitled session"),
        parentID: input.session.parentID,
        agent: undefined,
        status,
        model: fallbackStats.model,
        requests: fallbackStats.requests,
        tokens: fallbackStats.tokens,
        totalTokens: fallbackStats.totalTokens,
        activeTool: undefined,
        activeToolStatus: undefined,
        updated: input.session.time.updated,
      },
    ] satisfies EnrichedMonitorEntry[]
  }

  return deduped.map((entry) => {
    const partID = entry.level === "tool" ? entry.id.split(":").at(-1) : undefined
    const direct = partID ? toolMeta.get(partID) : undefined
    const inferred =
      direct ??
      [...toolMeta.values()].find(
        (item) => item.sessionID === entry.sessionID && item.agent === entry.agent && item.tool === entry.activeTool,
      )
    return {
      ...entry,
      todo: inferred?.todo,
      latestResult: inferred?.result,
    } satisfies EnrichedMonitorEntry
  })
}
