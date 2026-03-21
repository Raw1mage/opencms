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
  latestNarration?: string
}

export type MonitorDisplayCard = {
  badge: string
  title: string
  headline?: string
}

/** Process-oriented card: one card per OS-visible process */
export type ProcessCard = {
  /** Unique key for dedup */
  key: string
  /** "main" = parent session, "subagent" = delegated child process */
  kind: "main" | "subagent"
  /** Display title (task description or session title) */
  title: string
  /** What the process is doing right now */
  activity?: string
  /** Aggregate status across all levels for this process */
  status: "active" | "waiting" | "pending" | "error" | "idle"
  /** Agent type (coding, explore, docs, etc.) */
  agent?: string
  /** Model in use */
  model?: { providerId: string; modelID: string }
  /** Elapsed seconds */
  elapsed?: number
  /** Request count */
  requests: number
  /** Total tokens */
  totalTokens: number
  /** Currently executing tool */
  activeTool?: string
  /** Task narration */
  narration?: string
  /** Session ID for abort */
  sessionID: string
  /** Can be aborted */
  canAbort: boolean
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

export function monitorDisplayCard(value: EnrichedMonitorEntry): MonitorDisplayCard {
  const badge = MONITOR_LEVEL_LABELS[value.level] ?? value.level
  const headline = value.todo?.content || value.latestNarration || value.activeTool || undefined

  if (value.level === "session") {
    return { badge, title: value.title || "Untitled session", headline }
  }

  if (value.level === "sub-session") {
    return { badge, title: value.title || "Untitled session", headline }
  }

  if (value.level === "agent" || value.level === "sub-agent") {
    return { badge, title: value.agent || value.title || "Untitled agent", headline }
  }

  return { badge, title: value.activeTool || value.title || "Untitled tool", headline }
}

// Runner card removed — no independent autonomous runner process

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
  const taskNarration = new Map<string, string>()
  for (const message of input.messages ?? []) {
    if (message.role !== "assistant") continue
    const parts = input.partsByMessage?.[message.id] ?? []
    for (const part of parts) {
      if (part.type !== "text") continue
      if (part.metadata?.taskNarration !== true) continue
      const toolCallId = typeof part.metadata?.toolCallId === "string" ? part.metadata.toolCallId : undefined
      if (!toolCallId) continue
      taskNarration.set(toolCallId, part.text)
    }
  }

  const toolMeta = new Map<
    string,
    { todo?: MonitorTodoLink; result?: string; narration?: string; sessionID: string; agent?: string; tool: string }
  >()
  for (const message of input.messages ?? []) {
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
        narration: part.callID ? taskNarration.get(part.callID) : undefined,
        sessionID: part.sessionID,
        agent: message.agent,
        tool: part.tool,
      })
    }
  }

  const raw = (input.raw ?? [])
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
      latestNarration: inferred?.narration,
    } satisfies EnrichedMonitorEntry
  })
}

function statusRank(type: string): "active" | "waiting" | "pending" | "error" | "idle" {
  if (type === "busy" || type === "working") return "active"
  if (type === "retry" || type === "compacting") return "waiting"
  if (type === "pending") return "pending"
  if (type === "error") return "error"
  return "idle"
}

/**
 * Collapse multi-level monitor entries into process-oriented cards.
 * One card per OS-visible process: main session + one per delegated subagent.
 */
export function buildProcessCards(entries: EnrichedMonitorEntry[], mainSessionID?: string): ProcessCard[] {
  const now = Date.now()

  // Group entries by sessionID — all levels for the same session collapse into one process
  const bySession = new Map<string, EnrichedMonitorEntry[]>()
  for (const entry of entries) {
    const sid = entry.sessionID
    if (!bySession.has(sid)) bySession.set(sid, [])
    bySession.get(sid)!.push(entry)
  }

  const cards: ProcessCard[] = []

  for (const [sessionID, group] of bySession) {
    const isMain = sessionID === mainSessionID

    // Pick the most informative entry for display:
    // prefer sub-agent > agent > sub-session > session > tool
    const levelPriority: Record<string, number> = {
      "sub-agent": 5,
      agent: 4,
      "sub-session": 3,
      session: 2,
      tool: 1,
    }
    const sorted = group.slice().sort((a, b) => (levelPriority[b.level] ?? 0) - (levelPriority[a.level] ?? 0))
    const primary = sorted[0]

    // Aggregate stats across all levels for this process
    let requests = 0
    let totalTokens = 0
    let model: { providerId: string; modelID: string } | undefined
    let activeTool: string | undefined
    let narration: string | undefined
    let bestStatus: "active" | "waiting" | "pending" | "error" | "idle" = "idle"
    let latestUpdate = 0

    for (const entry of group) {
      requests = Math.max(requests, entry.requests)
      totalTokens = Math.max(totalTokens, entry.totalTokens)
      if (!model && entry.model) model = entry.model
      if (!activeTool && entry.activeTool) activeTool = entry.activeTool
      if (!narration && entry.latestNarration) narration = entry.latestNarration
      latestUpdate = Math.max(latestUpdate, entry.updated)

      const rank = statusRank(entry.status.type)
      // Pick highest-priority status
      const order = { active: 4, waiting: 3, pending: 2, error: 5, idle: 0 }
      if (order[rank] > order[bestStatus]) bestStatus = rank
    }

    const title = isMain
      ? primary.title || "Main session"
      : primary.latestNarration || primary.todo?.content || primary.title || primary.agent || "Subagent"

    const activity = isMain
      ? narration || activeTool || primary.todo?.content || undefined
      : activeTool || undefined

    cards.push({
      key: sessionID,
      kind: isMain ? "main" : "subagent",
      title,
      activity,
      status: bestStatus,
      agent: primary.agent,
      model,
      elapsed: latestUpdate ? Math.floor((now - latestUpdate) / 1000) : undefined,
      requests,
      totalTokens,
      activeTool,
      narration,
      sessionID,
      canAbort: !isMain && bestStatus !== "idle",
    })
  }

  // Sort: main first, then active before waiting/pending, then by update recency
  const statusOrder = { active: 0, error: 1, waiting: 2, pending: 3, idle: 4 }
  cards.sort((a, b) => {
    if (a.kind === "main" && b.kind !== "main") return -1
    if (b.kind === "main" && a.kind !== "main") return 1
    const sa = statusOrder[a.status] ?? 9
    const sb = statusOrder[b.status] ?? 9
    if (sa !== sb) return sa - sb
    return (a.elapsed ?? 0) - (b.elapsed ?? 0)
  })

  return cards
}
