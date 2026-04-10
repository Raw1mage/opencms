import z from "zod"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { ProcessSupervisor } from "@/process/supervisor"
import { TelemetryProjector } from "@/system/runtime-event-service"
import { SessionActiveChild } from "@/tool/task"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { SessionStatus } from "./status"

export namespace SessionMonitor {
  const WORKING_STALE_MS = 3 * 60 * 1000
  const TOOL_ACTIVE_WINDOW_MS = 3 * 60 * 1000
  const SESSION_RESCAN_MIN_MS = 3000

  export const Level = z.enum(["session", "sub-session", "agent", "sub-agent", "tool"]).meta({
    ref: "SessionMonitorLevel",
  })
  export type Level = z.infer<typeof Level>

  export const Status = z
    .union([
      SessionStatus.Info,
      z.object({ type: z.literal("working") }),
      z.object({ type: z.literal("compacting") }),
      z.object({ type: z.literal("pending") }),
      z.object({ type: z.literal("error"), message: z.string().optional() }),
    ])
    .meta({ ref: "SessionMonitorStatus" })
  export type Status = z.infer<typeof Status>

  export const Info = z
    .object({
      id: z.string(),
      level: Level,
      sessionID: z.string(),
      title: z.string(),
      parentID: z.string().optional(),
      agent: z.string().optional(),
      status: Status,
      model: z
        .object({
          providerId: z.string(),
          modelID: z.string(),
        })
        .optional(),
      requests: z.number(),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cache: z.object({ read: z.number(), write: z.number() }),
      }),
      totalTokens: z.number(),
      activeTool: z.string().optional(),
      activeToolStatus: z.string().optional(),
      telemetry: z
        .object({
          roundIndex: z.number().optional(),
          requestId: z.string().optional(),
          compactionResult: z.string().optional(),
          compactionDraftTokens: z.number().optional(),
          compactionCount: z.number().optional(),
          source: z.literal("projector").optional(),
          promptSummary: z.record(z.string(), z.any()).optional(),
          roundSummary: z.record(z.string(), z.any()).optional(),
          compactionSummary: z.record(z.string(), z.any()).optional(),
          sessionSummary: z.record(z.string(), z.any()).optional(),
          freshness: z.record(z.string(), z.any()).optional(),
        })
        .optional(),
      updated: z.number(),
    })
    .meta({ ref: "SessionMonitorInfo" })
  export type Info = z.infer<typeof Info>

  type State = {
    sessions: Map<string, Session.Info>
    statuses: Map<string, SessionStatus.Info>
    dirty: Set<string>
    rows: Map<string, Info[]>
    lastScanAt: Map<string, number>
    bootstrapped: boolean
    unsubscribers: Array<() => void>
  }

  function createState() {
    const result: State = {
      sessions: new Map(),
      statuses: new Map(),
      dirty: new Set(),
      rows: new Map(),
      lastScanAt: new Map(),
      bootstrapped: false,
      unsubscribers: [],
    }

    const markDirty = (sessionID?: string) => {
      if (!sessionID) return
      result.dirty.add(sessionID)
    }

    result.unsubscribers.push(
      Bus.subscribe(Session.Event.Created, (evt) => {
        result.sessions.set(evt.properties.info.id, evt.properties.info)
        markDirty(evt.properties.info.id)
      }),
    )

    result.unsubscribers.push(
      Bus.subscribe(Session.Event.Updated, (evt) => {
        result.sessions.set(evt.properties.info.id, evt.properties.info)
        markDirty(evt.properties.info.id)
      }),
    )

    result.unsubscribers.push(
      Bus.subscribe(Session.Event.Deleted, (evt) => {
        const id = evt.properties.info.id
        result.sessions.delete(id)
        result.statuses.delete(id)
        result.rows.delete(id)
        result.lastScanAt.delete(id)
        result.dirty.delete(id)
      }),
    )

    result.unsubscribers.push(
      Bus.subscribe(SessionStatus.Event.Status, (evt) => {
        const { sessionID, status } = evt.properties
        if (status.type === "idle") {
          result.statuses.delete(sessionID)
          result.rows.delete(sessionID)
          result.lastScanAt.delete(sessionID)
          result.dirty.delete(sessionID)
          return
        }
        result.statuses.set(sessionID, status)
        markDirty(sessionID)
      }),
    )

    result.unsubscribers.push(
      Bus.subscribe(MessageV2.Event.Updated, (evt) => {
        if (evt.properties.info.role === "assistant") markDirty(evt.properties.info.sessionID)
      }),
    )

    result.unsubscribers.push(
      Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
        if (evt.properties.part.type === "tool") markDirty(evt.properties.part.sessionID)
      }),
    )

    result.unsubscribers.push(
      Bus.subscribe(MessageV2.Event.PartRemoved, (evt) => {
        markDirty(evt.properties.sessionID)
      }),
    )

    result.unsubscribers.push(
      Bus.subscribe(Session.Event.Diff, (evt) => {
        markDirty(evt.properties.sessionID)
      }),
    )

    return result
  }

  async function cleanupState(st: ReturnType<typeof createState>) {
    for (const unsub of st.unsubscribers) unsub()
    st.unsubscribers = []
  }

  let stateGetter: (() => ReturnType<typeof createState>) | undefined
  let fallbackState: ReturnType<typeof createState> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState, cleanupState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  function emptyTokens() {
    return {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
  }

  function statusFrom(current: SessionStatus.Info, sessionID: string, last?: MessageV2.Info): Status {
    if (current.type !== "idle") return current
    if (!last) return { type: "pending" }
    const processState = ProcessSupervisor.sessionState(sessionID)
    if (last.role === "assistant" && last.error) {
      const err = last.error as { message?: string; data?: { message?: string } } | undefined
      return { type: "error", message: err?.message || err?.data?.message || "Unknown error" }
    }
    if (last.role === "assistant" && !last.time.completed) {
      const lastTime = last.time.created ?? 0
      const stale = Date.now() - lastTime > WORKING_STALE_MS
      if (!stale || processState === "running" || processState === "stalled") return { type: "working" }
      return { type: "idle" }
    }
    if (last.role === "user") {
      if (processState === "running" || processState === "stalled") return { type: "working" }
      return { type: "idle" }
    }
    return current
  }

  function toolStatus(state: z.infer<typeof MessageV2.ToolState>): Status {
    if (state.status === "running") return { type: "working" }
    if (state.status === "pending") return { type: "pending" }
    if (state.status === "error") return { type: "error", message: state.error }
    return { type: "idle" }
  }

  function resolveToolTitle(part: MessageV2.ToolPart) {
    if (part.state.status === "running" && part.state.title) {
      const runningTitle = part.state.title.trim()
      if (runningTitle) return runningTitle
    }

    const input = part.state.input
    if (!input || typeof input !== "object") return undefined

    const description = input["description"]
    if (typeof description === "string" && description.trim()) {
      return description.trim()
    }

    const title = input["title"]
    if (typeof title === "string" && title.trim()) return `${part.tool}: ${title.trim()}`

    const command = input["command"]
    if (typeof command === "string" && command.trim()) return `${part.tool}: ${command.trim()}`

    return undefined
  }

  function buildTelemetry(projector: TelemetryProjector.Aggregate | undefined) {
    if (!projector) return undefined
    return {
      roundIndex: projector.roundSummary?.roundIndex,
      requestId: projector.roundSummary?.requestId,
      compactionResult: projector.compactionSummary?.compactionResult ?? projector.roundSummary?.compactionResult,
      compactionDraftTokens:
        projector.compactionSummary?.compactionDraftTokens ?? projector.roundSummary?.compactionDraftTokens,
      compactionCount: projector.compactionSummary?.compactionCount ?? projector.roundSummary?.compactionCount,
      source: projector.source,
      promptSummary: projector.promptSummary ?? undefined,
      roundSummary: projector.roundSummary ?? undefined,
      compactionSummary: projector.compactionSummary ?? undefined,
      sessionSummary: projector.sessionSummary,
      freshness: projector.freshness,
    }
  }

  async function ensureBootstrapped() {
    const st = state()
    if (st.bootstrapped) return

    for await (const session of Session.list()) {
      st.sessions.set(session.id, session)
    }

    const statuses = SessionStatus.list()
    for (const [sessionID, status] of Object.entries(statuses)) {
      if (status.type === "idle") continue
      st.statuses.set(sessionID, status)
      st.dirty.add(sessionID)
    }

    st.bootstrapped = true
  }

  function resolveSessionIDs(input: { sessionID?: string; includeDescendants?: boolean }) {
    const st = state()
    if (!input.sessionID) return [...st.statuses.keys()]
    if (!input.includeDescendants) return [input.sessionID]

    const childMap = new Map<string, string[]>()
    for (const session of st.sessions.values()) {
      if (!session.parentID) continue
      const list = childMap.get(session.parentID) ?? []
      list.push(session.id)
      childMap.set(session.parentID, list)
    }

    const include = new Set<string>([input.sessionID])
    const stack = [input.sessionID]
    while (stack.length) {
      const id = stack.pop()!
      const children = childMap.get(id) ?? []
      for (const child of children) {
        if (include.has(child)) continue
        include.add(child)
        stack.push(child)
      }
    }
    return [...include]
  }

  async function scanSession(session: Session.Info, maxMessages: number): Promise<Info[]> {
    const activeStatuses = new Set(["busy", "working", "retry", "compacting", "pending"])
    const sums = {
      requests: 0,
      total: 0,
      tokens: emptyTokens(),
    }
    const model = { value: undefined as { providerId: string; modelID: string } | undefined }
    const agent = { value: undefined as string | undefined }
    const tool = {
      name: undefined as string | undefined,
      status: undefined as string | undefined,
      title: undefined as string | undefined,
    }
    const latest = { value: undefined as MessageV2.Info | undefined }
    const latestAssistant = { value: undefined as MessageV2.Assistant | undefined }
    const latestCompactionAssistant = { value: undefined as MessageV2.Assistant | undefined }
    let compactionCount = 0
    const projectorTelemetry = await TelemetryProjector.project(session.id).catch(() => undefined)
    const telemetry = () => buildTelemetry(projectorTelemetry)
    const processState = ProcessSupervisor.sessionState(session.id)
    const processActive = processState === "running" || processState === "stalled"
    const parentActiveChild = session.parentID ? SessionActiveChild.get(session.parentID) : undefined
    const authoritativeChildActive = !session.parentID || parentActiveChild?.sessionID === session.id

    const agents = new Map<
      string,
      {
        requests: number
        total: number
        tokens: ReturnType<typeof emptyTokens>
        model?: { providerId: string; modelID: string }
        latest?: MessageV2.Assistant
        updated: number
        tool?: { name?: string; status?: string; title?: string }
      }
    >()
    const tools: Info[] = []

    let scanned = 0
    for await (const message of MessageV2.stream(session.id)) {
      scanned += 1
      if (!latest.value) latest.value = message.info

      if (message.info.role === "assistant" && !latestAssistant.value) {
        latestAssistant.value = message.info
      }

      if (message.info.role === "assistant" && message.info.summary) {
        compactionCount += 1
        if (!latestCompactionAssistant.value) latestCompactionAssistant.value = message.info
      }

      if (scanned > maxMessages) continue

      if (message.info.role === "assistant") {
        const info = message.info
        const total =
          info.tokens.input +
          info.tokens.output +
          info.tokens.reasoning +
          info.tokens.cache.read +
          info.tokens.cache.write
        if (!model.value && total > 0) {
          model.value = { providerId: info.providerId, modelID: info.modelID }
        }
        if (!agent.value) agent.value = info.agent
        if (total > 0) sums.requests += 1
        sums.tokens.input += info.tokens.input
        sums.tokens.output += info.tokens.output
        sums.tokens.reasoning += info.tokens.reasoning
        sums.tokens.cache.read += info.tokens.cache.read
        sums.tokens.cache.write += info.tokens.cache.write
        sums.total += total

        if (info.agent) {
          const entry =
            agents.get(info.agent) ??
            ({
              requests: 0,
              total: 0,
              tokens: emptyTokens(),
              model: undefined,
              latest: undefined,
              updated: 0,
              tool: undefined,
            } as const)
          if (!agents.has(info.agent)) agents.set(info.agent, { ...entry })
          const mutable = agents.get(info.agent)!
          if (!mutable.latest) mutable.latest = info
          if (!mutable.updated) mutable.updated = info.time.completed ?? info.time.created
          if (total > 0) mutable.requests += 1
          mutable.tokens.input += info.tokens.input
          mutable.tokens.output += info.tokens.output
          mutable.tokens.reasoning += info.tokens.reasoning
          mutable.tokens.cache.read += info.tokens.cache.read
          mutable.tokens.cache.write += info.tokens.cache.write
          mutable.total += total
          if (!mutable.model && total > 0) mutable.model = { providerId: info.providerId, modelID: info.modelID }
        }
      }

      for (const part of message.parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "pending" && part.state.status !== "running") continue
        const isProcessActive = processActive
        if (session.parentID && !authoritativeChildActive && !isProcessActive) continue
        const startedAt = part.state.status === "running" ? part.state.time.start : message.info.time.created
        if (!isProcessActive && Date.now() - startedAt > TOOL_ACTIVE_WINDOW_MS) continue

        const partTitle = resolveToolTitle(part)

        if (!tool.name) {
          tool.name = part.tool
          tool.status = part.state.status
          tool.title = partTitle
        } else if (!tool.title && partTitle) {
          tool.title = partTitle
        }
        if (message.info.role === "assistant") {
          const current = agents.get(message.info.agent)
          if (current && !current.tool?.name) {
            current.tool = {
              name: part.tool,
              status: part.state.status,
              title: partTitle,
            }
          } else if (current?.tool && !current.tool.title && partTitle) {
            current.tool.title = partTitle
          }
        }

        const baseModel =
          message.info.role === "assistant"
            ? { providerId: message.info.providerId, modelID: message.info.modelID }
            : undefined
        tools.push({
          id: `tool:${session.id}:${part.id}`,
          level: "tool",
          sessionID: session.id,
          // Prefer tool-specific title (running metadata or inferred input description)
          // so monitor rows reflect concrete activity instead of repeating session title.
          title: partTitle || part.tool,
          parentID: session.parentID,
          agent: message.info.role === "assistant" ? message.info.agent : undefined,
          status: toolStatus(part.state),
          model: baseModel,
          requests: 0,
          tokens: emptyTokens(),
          totalTokens: 0,
          activeTool: part.tool,
          activeToolStatus: part.state.status,
          telemetry: telemetry(),
          updated:
            part.state.status === "running"
              ? part.state.time.start
              : (message.info.time.created ?? session.time.updated),
        })
      }
    }

    const result: Info[] = []
    const snapshotTelemetry = telemetry()
    const status = session.time.compacting
      ? ({ type: "compacting" } as Status)
      : statusFrom(SessionStatus.get(session.id), session.id, latest.value)
    const projectedStatus =
      session.parentID && !authoritativeChildActive && !processActive ? ({ type: "idle" } as Status) : status
    const level: Level = session.parentID ? "sub-session" : "session"

    if (model.value && activeStatuses.has(projectedStatus.type)) {
      result.push({
        id: `${level}:${session.id}`,
        level,
        sessionID: session.id,
        title: tool.title || session.title,
        parentID: session.parentID,
        agent: agent.value,
        status: projectedStatus,
        model: model.value,
        requests: sums.requests,
        tokens: sums.tokens,
        totalTokens: sums.total,
        activeTool: tool.name,
        activeToolStatus: tool.status,
        telemetry: snapshotTelemetry,
        updated: session.time.updated,
      })
    }

    for (const [name, info] of agents) {
      const status =
        session.parentID && !authoritativeChildActive && !processActive
          ? ({ type: "idle" } as Status)
          : statusFrom({ type: "idle" }, session.id, info.latest)
      const level: Level = session.parentID ? "sub-agent" : "agent"
      if (!info.model || !activeStatuses.has(status.type)) continue
      result.push({
        id: `${level}:${session.id}:${name}`,
        level,
        sessionID: session.id,
        title: info.tool?.title || session.title,
        parentID: session.parentID,
        agent: name,
        status,
        model: info.model,
        requests: info.requests,
        tokens: info.tokens,
        totalTokens: info.total,
        activeTool: info.tool?.name,
        activeToolStatus: info.tool?.status,
        telemetry: snapshotTelemetry,
        updated: info.updated || session.time.updated,
      })
    }

    for (const entry of tools) {
      if (entry.model && activeStatuses.has(entry.status.type)) result.push(entry)
    }

    return result
  }

  export async function snapshot(input?: { sessionID?: string; includeDescendants?: boolean; maxMessages?: number }) {
    await ensureBootstrapped()
    const st = state()
    const maxMessages =
      input?.maxMessages && Number.isFinite(input.maxMessages) && input.maxMessages > 0
        ? Math.floor(input.maxMessages)
        : 80

    const targetIDs = resolveSessionIDs({
      sessionID: input?.sessionID,
      includeDescendants: input?.includeDescendants,
    })

    for (const sessionID of targetIDs) {
      const status = st.statuses.get(sessionID)
      if (!status || status.type === "idle") {
        // When explicitly requesting descendants, keep completed (idle) sessions
        // so their telemetry remains visible. Only clean up truly orphaned rows.
        if (input?.includeDescendants && sessionID !== input?.sessionID) {
          // Descendant is idle — do a one-time scan if we have no rows yet,
          // but don't delete existing rows.
          if (!st.rows.has(sessionID)) {
            let session = st.sessions.get(sessionID)
            if (!session) {
              session = await Session.get(sessionID).catch(() => undefined)
              if (session) st.sessions.set(sessionID, session)
            }
            if (session) {
              const rows = await scanSession(session, maxMessages)
              st.rows.set(sessionID, rows)
              st.lastScanAt.set(sessionID, Date.now())
            }
          }
          st.dirty.delete(sessionID)
        } else {
          st.rows.delete(sessionID)
          st.lastScanAt.delete(sessionID)
          st.dirty.delete(sessionID)
        }
        continue
      }

      let session = st.sessions.get(sessionID)
      if (!session) {
        session = await Session.get(sessionID).catch(() => undefined)
        if (!session) continue
        st.sessions.set(sessionID, session)
      }

      const now = Date.now()
      const shouldScan = st.dirty.has(sessionID) && now - (st.lastScanAt.get(sessionID) ?? 0) >= SESSION_RESCAN_MIN_MS

      if (shouldScan || !st.rows.has(sessionID)) {
        const rows = await scanSession(session, maxMessages)
        st.rows.set(sessionID, rows)
        st.lastScanAt.set(sessionID, now)
        st.dirty.delete(sessionID)
      }
    }

    const result: Info[] = []
    for (const sessionID of targetIDs) {
      const rows = st.rows.get(sessionID)
      if (rows) result.push(...rows)
    }
    result.sort((a, b) => b.updated - a.updated)
    return result
  }
}
