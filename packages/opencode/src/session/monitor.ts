import z from "zod"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { ProcessSupervisor } from "@/process/supervisor"

export namespace SessionMonitor {
  // FIX: /session/top scanned all sessions/messages on every poll, causing 8-12s responses
  // and making TUI appear frozen. Add short cache + in-flight dedupe.
  // @event_20260210_session_top_snapshot_cache
  const SNAPSHOT_CACHE_MS = 1500
  const WORKING_STALE_MS = 3 * 60 * 1000
  const TOOL_ACTIVE_WINDOW_MS = 3 * 60 * 1000
  let snapshotCache: { at: number; data: Info[] } | undefined
  let snapshotInFlight: Promise<Info[]> | undefined

  export const Level = z.enum(["session", "sub-session", "agent", "sub-agent", "tool"]).meta({
    ref: "SessionMonitorLevel",
  })
  export type Level = z.infer<typeof Level>

  export const Status = z
    .union([
      SessionStatus.Info,
      z.object({
        type: z.literal("working"),
      }),
      z.object({
        type: z.literal("compacting"),
      }),
      z.object({
        type: z.literal("pending"),
      }),
      z.object({
        type: z.literal("error"),
        message: z.string().optional(),
      }),
    ])
    .meta({
      ref: "SessionMonitorStatus",
    })
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
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
      }),
      totalTokens: z.number(),
      activeTool: z.string().optional(),
      activeToolStatus: z.string().optional(),
      updated: z.number(),
    })
    .meta({
      ref: "SessionMonitorInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function snapshot() {
    const now = Date.now()
    if (snapshotCache && now - snapshotCache.at < SNAPSHOT_CACHE_MS) {
      return snapshotCache.data
    }
    if (snapshotInFlight) return snapshotInFlight

    snapshotInFlight = (async () => {
      const result: Info[] = []
      const activeStatuses = new Set(["busy", "working", "retry", "compacting", "pending"])
      const sessions: Session.Info[] = []
      for await (const session of Session.list()) {
        sessions.push(session)
      }
      const map = new Map(sessions.map((session) => [session.id, session]))
      const sessionTitle = (session: Session.Info) => {
        let current: Session.Info | undefined = session
        while (current && Session.isDefaultTitle(current.title) && current.parentID) {
          current = map.get(current.parentID)
        }
        return current?.title ?? session.title
      }
      const isTextPart = (part: MessageV2.Part): part is MessageV2.TextPart => {
        return part.type === "text" && !part.synthetic
      }
      const extractTitle = (message: MessageV2.WithParts) => {
        if (message.info.role !== "user") return undefined
        const text = message.parts
          .filter(isTextPart)
          .map((part) => part.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
        const source =
          text.length > 0
            ? text
            : message.parts
                .filter((part) => part.type === "subtask")
                .map((part) => part.prompt)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
        if (source.length === 0) return undefined
        const sentence =
          source.match(/^[^。！？.!?]+[。！？.!?]/)?.[0] ??
          source
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0) ??
          source
        const cleaned = sentence.trim()
        if (cleaned.length === 0) return undefined
        return cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      }
      const emptyTokens = () => ({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      })
      const statusFrom = (current: SessionStatus.Info, sessionID: string, last?: MessageV2.Info) => {
        if (current.type !== "idle") return current
        if (!last) return { type: "pending" } as Status
        const processState = ProcessSupervisor.sessionState(sessionID)
        if (last.role === "assistant" && last.error) {
          const err = last.error as { message?: string; data?: { message?: string } } | undefined
          return { type: "error", message: err?.message || err?.data?.message || "Unknown error" } as Status
        }
        if (last.role === "assistant" && !last.time.completed) {
          const lastTime = last.time.created ?? 0
          const stale = Date.now() - lastTime > WORKING_STALE_MS
          if (!stale || processState === "running" || processState === "stalled") return { type: "working" } as Status
          return { type: "idle" } as Status
        }
        if (last.role === "user") {
          if (processState === "running" || processState === "stalled") return { type: "working" } as Status
          return { type: "idle" } as Status
        }
        return current
      }
      const toolStatus = (state: z.infer<typeof MessageV2.ToolState>) => {
        if (state.status === "running") return { type: "working" } as Status
        if (state.status === "pending") return { type: "pending" } as Status
        if (state.status === "error") return { type: "error", message: state.error } as Status
        return { type: "idle" } as Status
      }
      for (const session of sessions) {
        let fallbackTitle: string | undefined = undefined
        const sums = {
          requests: 0,
          total: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
        }
        const model = {
          value: undefined as { providerId: string; modelID: string } | undefined,
        }
        const agent = {
          value: undefined as string | undefined,
        }
        const tool = {
          name: undefined as string | undefined,
          status: undefined as string | undefined,
        }
        const latest = {
          value: undefined as MessageV2.Info | undefined,
        }
        const agents = new Map<
          string,
          {
            requests: number
            total: number
            tokens: {
              input: number
              output: number
              reasoning: number
              cache: {
                read: number
                write: number
              }
            }
            model?: { providerId: string; modelID: string }
            latest?: MessageV2.Assistant
            updated: number
            tool?: { name?: string; status?: string }
          }
        >()
        const tools: Info[] = []

        for await (const message of MessageV2.stream(session.id)) {
          const derived = extractTitle(message)
          if (derived) fallbackTitle = derived
          if (!latest.value) latest.value = message.info
          if (message.info.role === "assistant") {
            const info = message.info
            const total =
              info.tokens.input +
              info.tokens.output +
              info.tokens.reasoning +
              info.tokens.cache.read +
              info.tokens.cache.write
            if (!model.value && total > 0) {
              model.value = {
                providerId: info.providerId,
                modelID: info.modelID,
              }
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
              const current = agents.get(info.agent)
              const entry = current ?? {
                requests: 0,
                total: 0,
                tokens: emptyTokens(),
                model: undefined as { providerId: string; modelID: string } | undefined,
                latest: undefined as MessageV2.Assistant | undefined,
                updated: 0,
                tool: undefined as { name?: string; status?: string } | undefined,
              }
              if (!current) agents.set(info.agent, entry)
              if (!entry.latest) entry.latest = info
              if (!entry.updated) entry.updated = info.time.completed ?? info.time.created
              if (total > 0) entry.requests += 1
              entry.tokens.input += info.tokens.input
              entry.tokens.output += info.tokens.output
              entry.tokens.reasoning += info.tokens.reasoning
              entry.tokens.cache.read += info.tokens.cache.read
              entry.tokens.cache.write += info.tokens.cache.write
              entry.total += total
              if (!entry.model && total > 0) {
                entry.model = {
                  providerId: info.providerId,
                  modelID: info.modelID,
                }
              }
            }
          }

          for (const part of message.parts) {
            if (part.type !== "tool") continue
            if (part.state.status !== "pending" && part.state.status !== "running") continue
            const processState = ProcessSupervisor.sessionState(session.id)
            const isProcessActive = processState === "running" || processState === "stalled"
            const startedAt = part.state.status === "running" ? part.state.time.start : message.info.time.created
            if (!isProcessActive && Date.now() - startedAt > TOOL_ACTIVE_WINDOW_MS) continue
            if (!tool.name) {
              tool.name = part.tool
              tool.status = part.state.status
            }
            if (message.info.role === "assistant") {
              const info = message.info
              const current = info.agent ? agents.get(info.agent) : undefined
              if (current && !current.tool?.name) {
                current.tool = {
                  name: part.tool,
                  status: part.state.status,
                }
              }
            }
            const info = message.info
            const baseModel =
              info.role === "assistant"
                ? {
                    providerId: info.providerId,
                    modelID: info.modelID,
                  }
                : undefined
            tools.push({
              id: `tool:${session.id}:${part.id}`,
              level: "tool",
              sessionID: session.id,
              title: session.title,
              parentID: session.parentID,
              agent: info.role === "assistant" ? info.agent : undefined,
              status: toolStatus(part.state),
              model: baseModel,
              requests: 0,
              tokens: emptyTokens(),
              totalTokens: 0,
              activeTool: part.tool,
              activeToolStatus: part.state.status,
              updated:
                part.state.status === "running" ? part.state.time.start : (info.time.created ?? session.time.updated),
            })
          }
        }

        const baseTitle = sessionTitle(session)
        const title = Session.isDefaultTitle(baseTitle) ? (fallbackTitle ?? baseTitle) : baseTitle
        for (const entry of tools) {
          entry.title = title
        }
        const status = session.time.compacting
          ? ({ type: "compacting" } as Status)
          : statusFrom(SessionStatus.get(session.id), session.id, latest.value)
        const level = session.parentID ? "sub-session" : "session"

        if (model.value && activeStatuses.has(status.type)) {
          result.push({
            id: `${level}:${session.id}`,
            level,
            sessionID: session.id,
            title,
            parentID: session.parentID,
            agent: agent.value,
            status,
            model: model.value,
            requests: sums.requests,
            tokens: sums.tokens,
            totalTokens: sums.total,
            activeTool: tool.name,
            activeToolStatus: tool.status,
            updated: session.time.updated,
          })
        }

        for (const [name, info] of agents) {
          const status = statusFrom({ type: "idle" }, session.id, info.latest)
          const level = session.parentID ? "sub-agent" : "agent"
          if (info.model && activeStatuses.has(status.type)) {
            result.push({
              id: `${level}:${session.id}:${name}`,
              level,
              sessionID: session.id,
              title,
              parentID: session.parentID,
              agent: name,
              status,
              model: info.model,
              requests: info.requests,
              tokens: info.tokens,
              totalTokens: info.total,
              activeTool: info.tool?.name,
              activeToolStatus: info.tool?.status,
              updated: info.updated || session.time.updated,
            })
          }
        }

        for (const entry of tools) {
          if (entry.model && activeStatuses.has(entry.status.type)) result.push(entry)
        }
      }
      result.sort((a, b) => b.updated - a.updated)
      snapshotCache = { at: Date.now(), data: result }
      return result
    })()

    try {
      return await snapshotInFlight
    } finally {
      snapshotInFlight = undefined
    }
  }
}
