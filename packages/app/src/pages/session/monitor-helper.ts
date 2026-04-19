import type { Message, Session, SessionMonitorInfo, SessionStatus, Part } from "@opencode-ai/sdk/v2/client"
import type {
  SessionTelemetry,
  SessionTelemetryPromptBlock,
  SessionTelemetryRoundSummary,
  SessionTelemetrySessionSummary,
} from "@/context/global-sync/types"

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

type ProjectorTelemetryPayload = {
  source?: "projector"
  promptSummary?: Record<string, unknown>
  roundSummary?: Record<string, unknown>
  compactionSummary?: Record<string, unknown>
  sessionSummary?: Record<string, unknown>
  freshness?: Record<string, unknown>
  roundIndex?: number
  requestId?: string
  compactionResult?: string
  compactionDraftTokens?: number
  compactionCount?: number
}

export type EnrichedMonitorEntry = SessionMonitorInfo & {
  todo?: MonitorTodoLink
  latestResult?: string
  latestNarration?: string
  telemetry?: ProjectorTelemetryPayload
}

export type MonitorDisplayCard = {
  badge: string
  title: string
  headline?: string
}

/** Process-oriented card: one card per OS-visible process */
export type ProcessCard = {
  key: string
  kind: "main" | "subagent"
  title: string
  activity?: string
  status: "active" | "waiting" | "pending" | "error" | "idle"
  agent?: string
  model?: { providerId: string; modelID: string }
  updatedAgo?: number
  requests: number
  totalTokens: number
  activeTool?: string
  narration?: string
  sessionID: string
  canAbort: boolean
}

type RawTelemetryBlock = Record<string, unknown>

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(asString).filter((item): item is string => !!item)
  const single = asString(value)
  return single ? [single] : []
}

function readPromptBlock(raw: RawTelemetryBlock, index: number): SessionTelemetryPromptBlock | undefined {
  const outcomeValue = raw.outcome ?? raw.status ?? raw.result ?? raw.injected
  const outcome =
    outcomeValue === true || outcomeValue === "injected"
      ? "injected"
      : outcomeValue === false || outcomeValue === "skipped"
        ? "skipped"
        : undefined
  const id = asString(raw.id) ?? asString(raw.blockId) ?? asString(raw.name) ?? `block-${index}`
  const name = asString(raw.name) ?? asString(raw.blockName) ?? asString(raw.title) ?? id
  const sourceFile = asString(raw.sourceFile) ?? asString(raw.file) ?? asString(raw.path)
  const kind = asString(raw.kind) ?? asString(raw.blockKind) ?? asString(raw.type)
  const injectionPolicy = asString(raw.injectionPolicy) ?? asString(raw.policy)
  const skipReason = asString(raw.skipReason) ?? asString(raw.reason)
  const estimatedTokens =
    asNumber(raw.estimatedTokens) ?? asNumber(raw.tokenEstimate) ?? asNumber(raw.tokens) ?? asNumber(raw.totalTokens)
  const correlationIDs =
    asStringArray(raw.correlationIDs) ||
    asStringArray(raw.correlationIds) ||
    asStringArray(raw.traceIDs) ||
    asStringArray(raw.traceIds)
  const builderTag = asString(raw.builderTag) ?? asString(raw.tag)

  if (!outcome || (!name && !sourceFile && !kind && !skipReason && estimatedTokens === undefined)) return undefined

  return {
    id,
    name,
    sourceFile,
    kind,
    injectionPolicy,
    outcome,
    skipReason,
    estimatedTokens,
    correlationIDs,
    builderTag,
  }
}

function authoritativeTelemetry(entries: EnrichedMonitorEntry[] | undefined, sessionID: string | undefined) {
  if (!sessionID) return undefined
  return entries?.find((entry) => entry.sessionID === sessionID && entry.telemetry)?.telemetry
}

function asProjectorRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function buildSessionTelemetryFromProjector(input: {
  session?: Session
  status?: SessionStatus
  monitorEntries?: EnrichedMonitorEntry[]
  loading?: boolean
  error?: string
}): SessionTelemetry {
  const telemetry = authoritativeTelemetry(input.monitorEntries, input.session?.id)
  const telemetryRecord = asProjectorRecord(telemetry)
  const promptSummary = asProjectorRecord(telemetry?.promptSummary)
  const roundSummaryRecord = asProjectorRecord(telemetry?.roundSummary) ?? telemetryRecord
  const compactionSummary = asProjectorRecord(telemetry?.compactionSummary)
  const sessionSummaryRecord = asProjectorRecord(telemetry?.sessionSummary)
  const blocks = Array.isArray(promptSummary?.blocks)
    ? promptSummary.blocks.map((item, index) => readPromptBlock(asRecord(item) ?? {}, index)).filter(Boolean)
    : []
  const deduped = Array.from(
    new Map(blocks.map((block) => [`${block!.id}:${block!.outcome}:${block!.skipReason ?? ""}`, block!])).values(),
  )
  const injectedCount = deduped.filter((block) => block.outcome === "injected").length
  const skippedCount = deduped.length - injectedCount
  const estimatedPromptTokens = deduped.reduce((total, block) => total + (block.estimatedTokens ?? 0), 0)
  const round: SessionTelemetryRoundSummary = {
    sessionId: input.session?.id ?? asString(roundSummaryRecord?.sessionID) ?? "",
    roundIndex: asNumber(roundSummaryRecord?.roundIndex),
    requestId: asString(roundSummaryRecord?.requestId),
    providerId: asString(roundSummaryRecord?.providerId),
    accountId: asString(roundSummaryRecord?.accountId),
    modelId: asString(roundSummaryRecord?.modelId),
    promptTokens: asNumber(roundSummaryRecord?.inputTokens),
    inputTokens: asNumber(roundSummaryRecord?.inputTokens),
    responseTokens: asNumber(roundSummaryRecord?.outputTokens),
    reasoningTokens: undefined,
    cacheReadTokens: asNumber(roundSummaryRecord?.cacheReadTokens),
    cacheWriteTokens: asNumber(roundSummaryRecord?.cacheWriteTokens),
    totalTokens: asNumber(roundSummaryRecord?.totalTokens),
    compacting: asString(compactionSummary?.compactionResult) === "pending",
    compactionResult: asString(compactionSummary?.compactionResult) ?? asString(roundSummaryRecord?.compactionResult),
    compactionDraftTokens:
      asNumber(compactionSummary?.compactionDraftTokens) ?? asNumber(roundSummaryRecord?.compactionDraftTokens),
  }
  const sessionSummary: SessionTelemetrySessionSummary = {
    sessionId: input.session?.id ?? asString(sessionSummaryRecord?.sessionID) ?? "",
    durationMs: input.session ? Math.max(0, input.session.time.updated - input.session.time.created) : undefined,
    cumulativeTokens: asNumber(sessionSummaryRecord?.cumulativeTokens) ?? 0,
    totalRequests: asNumber(sessionSummaryRecord?.totalRequests) ?? 0,
    providerId: round.providerId ?? input.session?.execution?.providerId,
    accountId: round.accountId ?? input.session?.execution?.accountId,
    modelId: round.modelId ?? input.session?.execution?.modelID,
    compacting: round.compacting,
    compactionCount: asNumber(compactionSummary?.compactionCount) ?? 0,
    latestUpdatedAt: asNumber(sessionSummaryRecord?.latestUpdatedAt),
  }
  const promptPhase = input.loading ? "loading" : deduped.length > 0 ? "ready" : input.error ? "error" : "empty"
  const roundPhase = input.loading
    ? "loading"
    : round.totalTokens !== undefined || sessionSummary.totalRequests > 0
      ? "ready"
      : input.error
        ? "error"
        : "empty"
  const phase =
    promptPhase === "loading" || roundPhase === "loading"
      ? "loading"
      : promptPhase === "ready" || roundPhase === "ready"
        ? "ready"
        : input.error
          ? "error"
          : "empty"

  return {
    phase,
    promptPhase,
    roundPhase,
    error: phase === "error" ? input.error : undefined,
    summary: {
      statusLabel: input.status?.type ?? "idle",
      activeTasks: 0,
      requests: sessionSummary.totalRequests,
      totalTokens: sessionSummary.cumulativeTokens,
      promptBlockCount: deduped.length,
      injectedCount,
      skippedCount,
      estimatedPromptTokens,
      lastPromptOutcome: deduped.at(-1)?.outcome,
    },
    prompt: {
      blocks: deduped,
      lastUpdated: asNumber(promptSummary?.timestamp) ?? sessionSummary.latestUpdatedAt,
    },
    round,
    sessionSummary,
    quota: {
      phase: "empty",
      providerId: round.providerId ?? sessionSummary.providerId,
      accountId: round.accountId ?? sessionSummary.accountId,
      modelId: round.modelId ?? sessionSummary.modelId,
      pressure: "low",
      activeIssues: [],
      recentEvents: [],
    },
  }
}

export function buildSessionTelemetryProjection(input: {
  session?: Session
  status?: SessionStatus
  monitorEntries?: EnrichedMonitorEntry[]
  messages: Message[]
  partsByMessage?: Record<string, readonly Part[] | undefined>
  llmErrors?: SessionTelemetry["quota"]["activeIssues"]
  llmHistory?: SessionTelemetry["quota"]["recentEvents"]
  loading?: boolean
  error?: string
}): SessionTelemetry {
  const telemetry = buildSessionTelemetryFromProjector({
    session: input.session,
    status: input.status,
    monitorEntries: input.monitorEntries,
    loading: input.loading,
    error: input.error,
  })
  const latestAssistant = [...(input.messages ?? [])]
    .filter((message): message is Message & { role: "assistant" } => message.role === "assistant")
    .sort((a, b) => (b.time.completed ?? b.time.created ?? 0) - (a.time.completed ?? a.time.created ?? 0))[0]
  const round = {
    ...telemetry.round,
    providerId: telemetry.round.providerId ?? latestAssistant?.providerId,
    accountId: telemetry.round.accountId ?? latestAssistant?.accountId ?? input.session?.execution?.accountId,
    modelId: telemetry.round.modelId ?? latestAssistant?.modelID ?? input.session?.execution?.modelID,
    promptTokens: telemetry.round.promptTokens ?? latestAssistant?.tokens.input,
    inputTokens: telemetry.round.inputTokens ?? latestAssistant?.tokens.input,
    responseTokens: telemetry.round.responseTokens ?? latestAssistant?.tokens.output,
    reasoningTokens: telemetry.round.reasoningTokens ?? latestAssistant?.tokens.reasoning,
    cacheReadTokens: telemetry.round.cacheReadTokens ?? latestAssistant?.tokens.cache.read,
    cacheWriteTokens: telemetry.round.cacheWriteTokens ?? latestAssistant?.tokens.cache.write,
    totalTokens: telemetry.round.totalTokens ?? latestAssistant?.tokens.total,
    requestId: telemetry.round.requestId ?? latestAssistant?.parentID,
  }
  const roundPhase =
    telemetry.roundPhase === "empty" && (round.totalTokens !== undefined || telemetry.sessionSummary.totalRequests > 0)
      ? "ready"
      : telemetry.roundPhase
  const activeIssues = (input.llmErrors ?? []).filter(
    (entry) =>
      !entry.type ||
      !input.session?.id ||
      entry.type === "ratelimit" ||
      entry.type === "auth_failed" ||
      entry.type === "error",
  )
  const recentEvents = input.llmHistory ?? []
  const pressure = activeIssues.some((entry) => entry.type === "auth_failed")
    ? "critical"
    : activeIssues.some((entry) => entry.type === "ratelimit")
      ? "high"
      : recentEvents.some((entry) => entry.state === "ratelimit" || entry.state === "error")
        ? "medium"
        : "low"
  return {
    ...telemetry,
    round,
    roundPhase,
    phase:
      telemetry.phase === "empty" && (telemetry.promptPhase === "ready" || roundPhase === "ready")
        ? "ready"
        : telemetry.phase,
    quota: {
      phase: activeIssues.length > 0 || recentEvents.length > 0 ? "ready" : "empty",
      providerId: telemetry.round.providerId ?? telemetry.sessionSummary.providerId,
      accountId: telemetry.round.accountId ?? telemetry.sessionSummary.accountId,
      modelId: telemetry.round.modelId ?? telemetry.sessionSummary.modelId,
      pressure,
      activeIssues,
      recentEvents,
    },
  }
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

export function buildProcessCards(entries: EnrichedMonitorEntry[], mainSessionID?: string): ProcessCard[] {
  const now = Date.now()
  const bySession = new Map<string, EnrichedMonitorEntry[]>()
  for (const entry of entries) {
    const sid = entry.sessionID
    if (!bySession.has(sid)) bySession.set(sid, [])
    bySession.get(sid)!.push(entry)
  }

  const cards: ProcessCard[] = []
  for (const [sessionID, group] of bySession) {
    const isMain = sessionID === mainSessionID
    const levelPriority: Record<string, number> = {
      "sub-agent": 5,
      agent: 4,
      "sub-session": 3,
      session: 2,
      tool: 1,
    }
    const sorted = group.slice().sort((a, b) => (levelPriority[b.level] ?? 0) - (levelPriority[a.level] ?? 0))
    const primary = sorted[0]

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
      const order = { active: 4, waiting: 3, pending: 2, error: 5, idle: 0 }
      if (order[rank] > order[bestStatus]) bestStatus = rank
    }

    const title = isMain
      ? primary.title || "Main session"
      : primary.latestNarration || primary.todo?.content || primary.title || primary.agent || "Subagent"
    const activity = isMain ? narration || activeTool || primary.todo?.content || undefined : activeTool || undefined

    cards.push({
      key: sessionID,
      kind: isMain ? "main" : "subagent",
      title,
      activity,
      status: bestStatus,
      agent: primary.agent,
      model,
      updatedAgo: latestUpdate ? Math.floor((now - latestUpdate) / 1000) : undefined,
      requests,
      totalTokens,
      activeTool,
      narration,
      sessionID,
      canAbort: !isMain && bestStatus !== "idle",
    })
  }

  const statusOrder = { active: 0, error: 1, waiting: 2, pending: 3, idle: 4 }
  cards.sort((a, b) => {
    if (a.kind === "main" && b.kind !== "main") return -1
    if (b.kind === "main" && a.kind !== "main") return 1
    const sa = statusOrder[a.status] ?? 9
    const sb = statusOrder[b.status] ?? 9
    if (sa !== sb) return sa - sb
    return (a.updatedAgo ?? 0) - (b.updatedAgo ?? 0)
  })

  return cards
}
