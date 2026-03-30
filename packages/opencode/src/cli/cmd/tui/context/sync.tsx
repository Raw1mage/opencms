import type {
  Message,
  Agent,
  Provider,
  File,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  AppSkillsResponse,
  SessionMonitorInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, createEffect, on, onCleanup, onMount } from "solid-js"
import { Log } from "@/util/log"
import type { Path } from "@opencode-ai/sdk"
import { TuiEvent } from "../event"
import { createTimerCoordinator } from "../util/timer-coordinator"
import { useRoute } from "@tui/context/route"

export type LlmHistoryEntry = {
  providerId: string
  modelId: string
  accountId?: string
  timestamp: number
  /** "error" | "ratelimit" | "auth_failed" | "recovered" | "rotated" */
  state: string
  message?: string
  toProviderId?: string
  toModelId?: string
  toAccountId?: string
}

export type ActiveChildState = {
  sessionID: string
  parentMessageID: string
  toolCallID: string
  workerID: string
  title: string
  agent: string
  status: "running" | "handoff"
  todo?: {
    id: string
    content: string
    status: string
    priority?: string
    action?: Record<string, unknown>
  }
}

const LLM_HISTORY_CAP = 10

function pushLlmHistory(history: LlmHistoryEntry[], entry: LlmHistoryEntry): LlmHistoryEntry[] {
  const next = [...history, entry]
  return next.length > LLM_HISTORY_CAP ? next.slice(-LLM_HISTORY_CAP) : next
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete" | "error"
      error?: string
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      skill: AppSkillsResponse
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      workspace_diff: {
        [sessionID: string]: File[]
      }
      monitor: SessionMonitorInfo[]
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      path: Path
      llm_history: LlmHistoryEntry[]
      codex_transport: Record<string, "ws" | "http">
      active_child: {
        [sessionID: string]: ActiveChildState | undefined
      }
      /** Count of active background task workers (across all sessions) */
      active_workers: number
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      skill: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      workspace_diff: {},
      monitor: [],
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      path: { state: "", config: "", worktree: "", directory: "" },
      llm_history: [],
      codex_transport: {},
      active_child: {},
      active_workers: 0,
    })

    const sdk = useSDK()
    const route = useRoute()

    const exit = useExit()
    const args = useArgs()

    const isVscodeTerminal =
      process.env.TERM_PROGRAM === "vscode" || !!process.env.VSCODE_PID || !!process.env.VSCODE_IPC_HOOK_CLI

    const monitorPollingDisabled = process.env.OPENCODE_TUI_DISABLE_MONITOR_POLL === "1"
    const monitorFallbackPollingEnabled = process.env.OPENCODE_TUI_MONITOR_FALLBACK_POLL === "1"

    const parseMs = (value: string | undefined, fallback: number) => {
      if (!value) return fallback
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.max(1000, Math.min(120000, Math.floor(n)))
    }

    const monitorActiveFallbackMs = parseMs(process.env.OPENCODE_TUI_MONITOR_POLL_MS, isVscodeTerminal ? 45000 : 20000)
    const monitorIdleFallbackMs = parseMs(
      process.env.OPENCODE_TUI_MONITOR_IDLE_POLL_MS,
      isVscodeTerminal ? 120000 : 60000,
    )
    const monitorMinRefreshMs = parseMs(
      process.env.OPENCODE_TUI_MONITOR_MIN_REFRESH_MS,
      isVscodeTerminal ? 12000 : 6000,
    )
    const monitorEventDebounceMs = parseMs(process.env.OPENCODE_TUI_MONITOR_EVENT_DEBOUNCE_MS, 500)
    const monitorMaxMessages = (() => {
      const raw = process.env.OPENCODE_TUI_MONITOR_MAX_MESSAGES
      if (!raw) return 80
      const n = Number(raw)
      if (!Number.isFinite(n)) return 80
      return Math.max(20, Math.min(2000, Math.floor(n)))
    })()
    const monitorMessagePartEvents = process.env.OPENCODE_TUI_MONITOR_MESSAGE_PART_EVENTS === "1"
    const monitorToolPartEvents = process.env.OPENCODE_TUI_MONITOR_TOOL_EVENTS !== "0"

    const timers = createTimerCoordinator("sync")
    let monitorLastFetchedAt = 0
    let monitorInFlight = false
    let monitorPrimed = false

    const isSessionRoute = () => route.data.type === "session"
    const currentRouteSessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)

    const isMonitorTrackingActive = () => {
      if (monitorPollingDisabled || !isSessionRoute()) return false
      const sessionID = currentRouteSessionID()
      if (!sessionID) return false
      const routeStatus = store.session_status?.[sessionID]
      const routeBusy = !!routeStatus && routeStatus.type !== "idle"
      // Keep monitor alive when background workers are active, even if main session is idle
      return routeBusy || store.active_workers > 0
    }

    const stopMonitorTracking = () => {
      timers.clear("monitor-refresh")
      timers.clear("monitor-poll")
      monitorPrimed = false
      if (store.monitor.length > 0) setStore("monitor", [])
    }

    const scheduleMonitorFallback = (delay: number) => {
      if (!monitorFallbackPollingEnabled) return
      if (!isMonitorTrackingActive()) return
      timers.schedule(
        "monitor-poll",
        () => {
          void refreshMonitor(false)
        },
        delay,
      )
    }

    const requestMonitorRefresh = (delay: number, force = false) => {
      if (!isMonitorTrackingActive()) return
      timers.schedule(
        "monitor-refresh",
        () => {
          void refreshMonitor(force)
        },
        delay,
      )
    }

    async function refreshMonitor(force: boolean) {
      if (!isMonitorTrackingActive()) return
      if (monitorInFlight) return
      const now = Date.now()
      if (!force && now - monitorLastFetchedAt < monitorMinRefreshMs) {
        if (monitorFallbackPollingEnabled) {
          scheduleMonitorFallback(monitorMinRefreshMs - (now - monitorLastFetchedAt))
        }
        return
      }

      monitorInFlight = true
      try {
        const sessionID = currentRouteSessionID()
        const query = (
          sessionID
            ? {
                sessionID,
                includeDescendants: true,
                maxMessages: monitorMaxMessages,
              }
            : {}
        ) as any
        const x = await sdk.client.session.top(query)
        const next = x.data ?? []
        setStore("monitor", reconcile(next))
        monitorLastFetchedAt = Date.now()
        if (monitorFallbackPollingEnabled) {
          scheduleMonitorFallback(next.length > 0 ? monitorActiveFallbackMs : monitorIdleFallbackMs)
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        Log.Default.error("tui monitor poll failed", {
          error: message,
          name: e instanceof Error ? e.name : undefined,
          stack: e instanceof Error ? e.stack : undefined,
        })
        if (monitorFallbackPollingEnabled) {
          scheduleMonitorFallback(monitorIdleFallbackMs)
        }
      } finally {
        monitorInFlight = false
      }
    }

    function onMonitorRelevantEvent(eventType: string, event: any) {
      if (monitorPollingDisabled || !isSessionRoute()) return
      const routeSessionID = currentRouteSessionID()
      if (!routeSessionID) return

      if (
        eventType === "session.status" &&
        event?.properties?.sessionID === routeSessionID &&
        event.properties?.status?.type === "idle"
      ) {
        // Don't stop monitor if background workers are still active
        if (store.active_workers > 0) {
          // Refresh to update monitor display with latest worker state
          requestMonitorRefresh(monitorEventDebounceMs)
          return
        }
        stopMonitorTracking()
        return
      }

      if (
        eventType === "session.status" &&
        event?.properties?.sessionID === routeSessionID &&
        event.properties?.status?.type !== "idle"
      ) {
        if (!monitorPrimed) {
          monitorPrimed = true
          requestMonitorRefresh(0, true)
        } else {
          requestMonitorRefresh(monitorEventDebounceMs)
        }
        return
      }

      if (!isMonitorTrackingActive()) return
      const part = event?.properties?.part
      const toolPartEvent =
        monitorToolPartEvents &&
        (eventType === "message.part.updated" || eventType === "message.part.removed") &&
        part?.type === "tool"
      const toolPartRemovedEvent = monitorToolPartEvents && eventType === "message.part.removed"
      const monitorRelevantEvent =
        eventType === "session.updated" ||
        eventType === "session.created" ||
        eventType === "session.deleted" ||
        eventType === "session.diff" ||
        toolPartEvent ||
        toolPartRemovedEvent ||
        (monitorMessagePartEvents && eventType.startsWith("message.part."))
      if (monitorRelevantEvent) {
        // Tool lifecycle transitions can be very short-lived; refresh immediately to avoid
        // missing quick [T] activity in sidebar monitor.
        if (toolPartEvent || toolPartRemovedEvent) {
          requestMonitorRefresh(0, true)
          return
        }
        requestMonitorRefresh(monitorEventDebounceMs)
      }
    }

    sdk.event.listen((e) => {
      const event = e.details as { type: string; properties: any }
      onMonitorRelevantEvent(event.type, event)
      switch (event.type) {
        case "server.instance.disposed":
        case "global.disposed":
          bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          // Ignore backend session.diff bus events.
          // They may represent historical/message summary snapshots rather than
          // the authoritative current git-uncommitted session-owned changes used by TUI sidebar.
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const info = event.properties.info
          const dir = sdk.directory
          const result = Binary.search(store.session, info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(info))
            break
          }
          // Only add new sessions that belong to the active directory
          if (dir && info.directory && info.directory !== dir) break
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            if (oldest) {
              batch(() => {
                setStore(
                  "message",
                  event.properties.info.sessionID,
                  produce((draft) => {
                    draft.shift()
                  }),
                )
                setStore(
                  "part",
                  produce((draft) => {
                    delete draft[oldest.id]
                  }),
                )
              })
            }
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const updPart = event.properties.part
          const updDelta = (event.properties as any).delta as string | undefined
          const parts = store.part[updPart.messageID]

          // Delta-aware streaming: append delta to existing text part
          if (updDelta && parts && (updPart.type === "text" || updPart.type === "reasoning")) {
            const updTextLength = (event.properties as any).textLength as number | undefined
            const result = Binary.search(parts, updPart.id, (p) => p.id)
            if (result.found) {
              const existing = parts[result.index]
              if ("text" in existing) {
                // Guard: skip duplicate delta from multiple SSE connections
                if (updTextLength !== undefined && existing.text.length >= updTextLength) {
                  break
                }
                const hasText = "text" in updPart && typeof (updPart as any).text === "string"
                const newText = hasText ? (updPart as any).text : existing.text + updDelta
                setStore("part", updPart.messageID, result.index, "text" as any, newText)
                if ("metadata" in updPart && (updPart as any).metadata) {
                  setStore("part", updPart.messageID, result.index, "metadata" as any, (updPart as any).metadata)
                }
                break
              }
            }
            // Not found yet — ensure text is populated for insertion
            if (!("text" in updPart) || typeof (updPart as any).text !== "string") {
              (updPart as any).text = updDelta
            }
          }

          if (!parts) {
            setStore("part", updPart.messageID, [updPart])
            break
          }
          const result = Binary.search(parts, updPart.id, (p) => p.id)
          if (result.found) {
            setStore("part", updPart.messageID, result.index, reconcile(updPart))
            break
          }
          setStore(
            "part",
            updPart.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, updPart)
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          sdk.client.lsp.status().then((x) => setStore("lsp", x.data!))
          break
        }

        case "mcp.tools.changed": {
          sdk.client.mcp.status().then((x) => {
            if (x.data) setStore("mcp", reconcile(x.data))
          })
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }

        case "llm.error": {
          const props = event.properties as {
            providerId: string
            modelId: string
            accountId: string
            message: string
            timestamp: number
          }
          setStore(
            "llm_history",
            pushLlmHistory(store.llm_history, {
              providerId: props.providerId,
              accountId: props.accountId,
              modelId: props.modelId,
              timestamp: props.timestamp,
              state: "error",
              message: props.message,
            }),
          )
          break
        }

        case "ratelimit.detected": {
          const props = event.properties as {
            providerId: string
            accountId: string
            modelId: string
            reason: string
            backoffMs: number
            timestamp: number
          }
          setStore(
            "llm_history",
            pushLlmHistory(store.llm_history, {
              providerId: props.providerId,
              accountId: props.accountId,
              modelId: props.modelId,
              timestamp: props.timestamp,
              state: "ratelimit",
              message: props.reason,
            }),
          )
          break
        }

        case "ratelimit.cleared": {
          const props = event.properties as {
            providerId: string
            accountId: string
            modelId: string
          }
          setStore(
            "llm_history",
            pushLlmHistory(store.llm_history, {
              providerId: props.providerId,
              accountId: props.accountId,
              modelId: props.modelId,
              timestamp: Date.now(),
              state: "recovered",
            }),
          )
          break
        }

        case "ratelimit.auth_failed": {
          const props = event.properties as {
            providerId: string
            accountId: string
            modelId: string
            message: string
            timestamp: number
          }
          setStore(
            "llm_history",
            pushLlmHistory(store.llm_history, {
              providerId: props.providerId,
              accountId: props.accountId,
              modelId: props.modelId,
              timestamp: props.timestamp,
              state: "auth_failed",
              message: props.message,
            }),
          )
          break
        }

        case "task.worker.assigned": {
          setStore("active_workers", (n) => n + 1)
          // Kick monitor tracking — a background subagent just started
          if (isSessionRoute() && !monitorPollingDisabled) {
            requestMonitorRefresh(0, true)
          }
          break
        }

        case "task.worker.done":
        case "task.worker.failed": {
          setStore("active_workers", (n) => Math.max(0, n - 1))
          // Refresh monitor to reflect completed worker
          if (isSessionRoute() && !monitorPollingDisabled) {
            requestMonitorRefresh(monitorEventDebounceMs)
          }
          break
        }

        case "task.worker.removed": {
          // Worker removed from pool — refresh monitor to sync UI
          if (isSessionRoute() && !monitorPollingDisabled) {
            requestMonitorRefresh(monitorEventDebounceMs)
          }
          break
        }

        case "session.active-child.updated": {
          const props = event.properties as {
            parentSessionID: string
            activeChild: ActiveChildState | null
          }
          if (props.activeChild) setStore("active_child", props.parentSessionID, props.activeChild)
          else setStore("active_child", props.parentSessionID, undefined)
          break
        }

        case "codex.transport": {
          const props = event.properties as {
            sessionId: string
            transport: "ws" | "http"
          }
          setStore("codex_transport", props.sessionId, props.transport)
          break
        }

        case "rotation.executed": {
          const props = event.properties as {
            fromProviderId: string
            fromModelId: string
            fromAccountId: string
            toProviderId: string
            toModelId: string
            toAccountId: string
            reason: string
            timestamp: number
          }
          setStore(
            "llm_history",
            pushLlmHistory(store.llm_history, {
              providerId: props.fromProviderId,
              modelId: props.fromModelId,
              accountId: props.fromAccountId,
              timestamp: props.timestamp,
              state: "rotated",
              message: props.reason,
              toProviderId: props.toProviderId,
              toModelId: props.toModelId,
              toAccountId: props.toAccountId,
            }),
          )
          break
        }
      }
    })

    async function bootstrap() {
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const directory = sdk.directory
      const sessionListPromise = sdk.client.session
        .list({ start, limit: 2000, ...(directory ? { directory } : {}) })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({}, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({}, { throwOnError: true })
      const agentsPromise = sdk.client.app.agents({}, { throwOnError: true })
      const configPromise = sdk.client.config.get({}, { throwOnError: true })
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const agents = responses[2]
            const config = responses[3]
            const sessions = responses[4]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            sdk.client.command.list().then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.app.skills().then((x) => setStore("skill", reconcile(x.data ?? []))),
            sdk.client.lsp.status().then((x) => setStore("lsp", reconcile(x.data!))),
            sdk.client.mcp.status().then((x) => setStore("mcp", reconcile(x.data!))),
            sdk.client.experimental.resource.list().then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status().then((x) => setStore("formatter", reconcile(x.data!))),
            sdk.client.session.status().then((x) => {
              setStore("session_status", reconcile(x.data!))
            }),
            sdk.client.provider.auth().then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get().then((x) => setStore("vcs", reconcile(x.data))),
            sdk.client.path.get().then((x) => setStore("path", reconcile(x.data!))),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          const message = e instanceof Error ? e.message : String(e)
          Log.Default.error("tui bootstrap failed", {
            error: message,
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          setStore("status", "error")
          setStore("error", message)
        })
    }

    async function refreshProviders() {
      const [providersResult, providerListResult] = await Promise.all([
        sdk.client.config.providers({}),
        sdk.client.provider.list({}),
      ])
      const providers = providersResult.data
      const providerList = providerListResult.data
      if (!providers || !providerList) return
      batch(() => {
        setStore("provider", reconcile(providers.providers))
        setStore("provider_default", reconcile(providers.default))
        setStore("provider_next", reconcile(providerList))
      })
    }

    ;(sdk.event.on as (event: string, handler: () => void) => void)(TuiEvent.ProviderRefresh.type, () => {
      refreshProviders().catch((e) => {
        Log.Default.error("provider refresh failed", { error: e })
      })
    })

    onMount(() => {
      bootstrap()
    })

    // Re-bootstrap when SDK directory changes (workspace switch)
    createEffect(
      on(
        () => sdk.directory,
        (_dir, prevDir) => {
          // Skip the initial run (handled by onMount bootstrap)
          if (prevDir === undefined) return
          fullSyncedSessions.clear()
          bootstrap()
        },
      ),
    )

    createEffect(
      on(
        () => route.data.type,
        (type) => {
          if (monitorPollingDisabled) return
          if (type === "session") {
            monitorLastFetchedAt = 0
            if (isMonitorTrackingActive()) requestMonitorRefresh(0, true)
            return
          }
          stopMonitorTracking()
        },
      ),
    )

    createEffect(
      on(currentRouteSessionID, (sessionID, prevSessionID) => {
        if (monitorPollingDisabled || !sessionID || sessionID === prevSessionID) return
        monitorLastFetchedAt = 0
        stopMonitorTracking()
        if (isMonitorTrackingActive()) requestMonitorRefresh(0, true)
      }),
    )

    createEffect(() => {
      if (!isMonitorTrackingActive()) {
        stopMonitorTracking()
        return
      }
      if (monitorFallbackPollingEnabled) {
        const hasActiveMonitor = (store.monitor ?? []).length > 0
        scheduleMonitorFallback(hasActiveMonitor ? monitorActiveFallbackMs : monitorIdleFallbackMs)
      }
    })

    onCleanup(() => {
      timers.dispose()
    })

    const fullSyncedSessions = new Set<string>()
    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return true // Optimistic rendering for TUI
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string, options?: { force?: boolean }) {
          if (!options?.force && fullSyncedSessions.has(sessionID)) return
          const sessionPromise = sdk.client.session.get({ sessionID }, { throwOnError: true })
          const [session, messages, todo, diff, workspaceDiff] = await Promise.all([
            sessionPromise,
            sdk.client.session.messages({ sessionID, limit: 100 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
            sessionPromise.then((session) => sdk.client.file.status({ directory: session.data?.directory })),
          ])
          const nextMessages = messages.data ?? []

          batch(() => {
            const match = Binary.search(store.session, sessionID, (s) => s.id)
            if (match.found) {
              setStore("session", match.index, reconcile(session.data!))
            } else {
              setStore(
                "session",
                produce((draft) => {
                  draft.splice(match.index, 0, session.data!)
                }),
              )
            }

            setStore("todo", sessionID, reconcile(todo.data ?? []))
            setStore(
              "message",
              sessionID,
              reconcile(
                nextMessages.map((x) => x.info),
                { key: "id", merge: true },
              ),
            )
            for (const message of nextMessages) {
              setStore("part", message.info.id, reconcile(message.parts, { key: "id", merge: true }))
            }
            setStore("session_diff", sessionID, reconcile(diff.data ?? []))
            setStore("workspace_diff", sessionID, reconcile(workspaceDiff.data ?? []))
          })
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})
