import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import FileTree from "@/components/file-tree"
import { SessionHeader } from "@/components/session"
import { SessionContextTab } from "@/components/session"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { Todo, UserMessage } from "@opencode-ai/sdk/v2/client"
import { getSessionStatusSummary } from "./helpers"
import { buildMonitorEntries, buildProcessCards, type EnrichedMonitorEntry } from "./monitor-helper"
// session-ui-freshness Phase 3.3: classify card fidelity from receivedAt.
import { classifyFidelity, createRateLimitedWarn, type Fidelity } from "@/utils/freshness"
import { useFreshnessClock } from "@/hooks/use-freshness-clock"
import {
  uiFreshnessEnabled,
  uiFreshnessHardTimeoutSec,
  uiFreshnessThresholdSec,
} from "@/context/frontend-tweaks"
import { SessionStatusSections } from "./session-status-sections"
import { StatusTodoList } from "./status-todo-list"
import { useStatusMonitor } from "./use-status-monitor"
import { useStatusTodoSync } from "./use-status-todo-sync"
import { useAutonomousHealthSync } from "./use-autonomous-health-sync"
import { decode64 } from "@/utils/base64"
import { SessionTelemetryCards } from "./session-telemetry-cards"
import { useGlobalSync } from "@/context/global-sync"
import { resolveTelemetryAccountLabel, useSessionTelemetryHydration } from "./session-telemetry-ui"

type SkillLayerState = {
  name: string
  loadedAt: number
  lastUsedAt: number
  runtimeState: "active" | "idle" | "sticky" | "summarized" | "unloaded"
  desiredState: "full" | "summary" | "absent"
  pinned: boolean
  lastReason: string
}

type SkillLayerActionResponse = {
  ok: boolean
  entries: SkillLayerState[]
}

export default function SessionToolPageRoute() {
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const params = useParams<{ dir?: string; id?: string; tool?: string }>()
  const [searchParams, setSearchParams] = useSearchParams<{ file?: string }>()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const sdk = useSDK()
  const file = useFile()
  let fileTreeScrollEl: HTMLDivElement | undefined
  let fileTreeScrollTop = 0

  const backPath = createMemo(() => (params.id ? `/${params.dir}/session/${params.id}` : `/${params.dir}/session`))
  const tool = createMemo(() => {
    if (params.tool === "files") return "files" as const
    if (params.tool === "status" || params.tool === "monitor" || params.tool === "todo") return "status" as const
    if (params.tool === "context") return "context" as const
    return "status" as const
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const view = createMemo(() => layout.view(sessionKey))
  const visibleUserMessages = createMemo(() => messages().filter((msg) => msg.role === "user") as UserMessage[])
  const todos = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    return sync.data.todo[id]
  })

  useStatusTodoSync({ enabled: () => tool() === "status", sessionID: () => params.id, sdk, sync })

  const monitor = useStatusMonitor({ enabled: () => tool() === "status", sessionID: () => params.id, sdk, sync })
  const autonomousHealth = useAutonomousHealthSync({
    enabled: () => tool() === "status",
    sessionID: () => params.id,
    sdk,
    status: () => (params.id ? sync.data.session_status[params.id] : undefined),
  })

  const [queueControlLoading, setQueueControlLoading] = createSignal<"resume_once" | "drop_pending" | null>(null)
  const [queueControlError, setQueueControlError] = createSignal<string | undefined>()

  const runQueueControl = async (action: "resume_once" | "drop_pending") => {
    const sessionID = params.id
    if (!sessionID || queueControlLoading()) return
    setQueueControlLoading(action)
    setQueueControlError(undefined)
    try {
      const response = await sdk.fetch(`${sdk.url}/api/v2/session/${sessionID}/autonomous/queue`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": sdk.directory },
        body: JSON.stringify({ action }),
      })
      if (!response.ok) throw new Error(`Queue control failed (${response.status})`)
      await autonomousHealth.forceRefresh()
    } catch (error) {
      setQueueControlError(error instanceof Error ? error.message : String(error))
    } finally {
      setQueueControlLoading(null)
    }
  }

  const monitorEntries = createMemo(() =>
    buildMonitorEntries({
      raw: monitor.items,
      session: info(),
      messages: messages(),
      status: params.id ? sync.data.session_status[params.id] : undefined,
      partsByMessage: sync.data.part,
    }),
  )
  const statusSummary = createMemo(() =>
    getSessionStatusSummary({
      session: info() as any,
      todos: todos() as Todo[] | undefined,
      status: params.id ? sync.data.session_status[params.id] : undefined,
      messages: messages(),
      partsByMessage: sync.data.part,
      autonomousHealth: autonomousHealth.data,
    }),
  )
  const telemetry = createMemo(() => (params.id ? sync.data.session_telemetry[params.id] : undefined))
  const telemetryDeps = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return ""
    const status = sync.data.session_status[sessionID]
    const messageSignature = messages()
      .map((message) => `${message.id}:${sync.data.part[message.id]?.length ?? 0}`)
      .join("|")
    const monitorSignature =
      tool() === "status"
        ? monitorEntries()
            .map(
              (entry) =>
                `${entry.sessionID}:${entry.status.type}:${entry.requests}:${entry.totalTokens}:${entry.updated}`,
            )
            .join("|")
        : ""
    return [
      tool(),
      info()?.time.updated ?? 0,
      status?.type ?? "",
      messageSignature,
      sync.data.llm_errors.length,
      sync.data.llm_history.length,
      monitorSignature,
      tool() === "status" && monitor.loading && !monitor.initialized ? "loading" : "idle",
      tool() === "status" ? (monitor.error ?? "") : "",
    ].join("::")
  })
  useSessionTelemetryHydration({
    sessionID: () => params.id,
    sync,
    deps: telemetryDeps,
    monitorEntries: () => (tool() === "status" ? (monitorEntries() as EnrichedMonitorEntry[]) : undefined),
    loading: () => tool() === "status" && monitor.loading && !monitor.initialized,
    error: () => (tool() === "status" ? monitor.error : undefined),
  })

  const resolveAccountLabel = (accountId?: string, providerId?: string) =>
    resolveTelemetryAccountLabel(globalSync, accountId, providerId)
  const selectedFile = createMemo(() => {
    if (tool() !== "files") return undefined
    const value = searchParams.file
    if (!value) return undefined
    return file.normalize(value)
  })
  const selectedFileState = createMemo(() => {
    const path = selectedFile()
    if (!path) return undefined
    return file.get(path)
  })
  const selectedFileContent = createMemo(() => {
    const content = selectedFileState()?.content
    if (!content || content.type === "binary") return undefined
    if (content.encoding === "base64") return decode64(content.content) ?? ""
    return content.content
  })

  createEffect(() => {
    const path = selectedFile()
    if (!path) return
    void file.load(path)
  })
  createEffect(() => {
    if (tool() !== "files") return
    if (selectedFile()) return
    requestAnimationFrame(() => {
      if (!fileTreeScrollEl) return
      fileTreeScrollEl.scrollTop = fileTreeScrollTop
    })
  })

  const openFileViewer = (path: string) => {
    if (fileTreeScrollEl) fileTreeScrollTop = fileTreeScrollEl.scrollTop
    void file.load(path)
    setSearchParams({ file: path })
  }

  const closeFileViewer = () => navigate(`${backPath()}/tool/files`)
  const fileListDirectory = createMemo(() => info()?.directory ?? sdk.directory ?? sync.data.path.directory)

  return (
    <div class="size-full flex flex-col bg-background-base">
      <SessionHeader />
      <div class="flex-1 min-h-0 overflow-auto bg-background-base">
        <Show when={tool() === "files"}>
          <Show
            when={selectedFile()}
            fallback={
              <div class="h-full flex flex-col min-h-0">
                <div class="shrink-0 px-3 py-2 border-b border-border-weak-base">
                  <div class="text-11-regular text-text-weak truncate">{fileListDirectory()}</div>
                </div>
                <div class="px-3 py-2 h-full overflow-auto" ref={fileTreeScrollEl}>
                  <FileTree path="" modified={[]} kinds={new Map()} onFileClick={(node) => openFileViewer(node.path)} />
                </div>
              </div>
            }
          >
            {(path) => (
              <div class="h-full overflow-auto px-3 py-3 flex flex-col gap-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="text-12-medium text-text-base truncate">{path()}</div>
                  </div>
                  <Button type="button" variant="secondary" class="h-8 px-3 shrink-0" onClick={closeFileViewer}>
                    {language.t("common.close")}
                  </Button>
                </div>
                <Show
                  when={!selectedFileState()?.loading}
                  fallback={<div class="text-12-regular text-text-weak">Loading file…</div>}
                >
                  <Show
                    when={!selectedFileState()?.error}
                    fallback={
                      <div class="text-12-regular text-text-danger break-words">{selectedFileState()?.error}</div>
                    }
                  >
                    <Show
                      when={selectedFileState()?.content?.type !== "binary"}
                      fallback={
                        <div class="text-12-regular text-text-weak">{language.t("session.files.binaryContent")}</div>
                      }
                    >
                      <pre class="whitespace-pre-wrap break-words rounded-md border border-border-weak-base bg-surface-panel px-3 py-3 text-12-regular text-text-base overflow-x-auto">
                        {selectedFileContent() ?? ""}
                      </pre>
                    </Show>
                  </Show>
                </Show>
              </div>
            )}
          </Show>
        </Show>
        <Show when={tool() === "status"}>
          <SessionStatusSections
            todoContent={
              <Show when={params.id} fallback={<div class="text-12-regular text-text-weak">No active session.</div>}>
                <Show
                  when={todos() !== undefined}
                  fallback={<div class="text-12-regular text-text-weak">Loading to-dos…</div>}
                >
                  <Show
                    when={(todos()?.length ?? 0) > 0}
                    fallback={<div class="text-12-regular text-text-weak">No to-dos yet.</div>}
                  >
                    <StatusTodoList todos={todos() as Todo[]} currentTodoID={statusSummary().currentStep?.id} />
                  </Show>
                </Show>
              </Show>
            }
            monitorContent={
              <Show when={params.id} fallback={<div class="text-12-regular text-text-weak">No active session.</div>}>
                <Show
                  when={monitor.initialized || !monitor.loading}
                  fallback={<div class="text-12-regular text-text-weak">Loading monitor…</div>}
                >
                  <Show
                    when={!monitor.error}
                    fallback={<div class="text-12-regular text-text-danger">{monitor.error}</div>}
                  >
                    <div class="flex flex-col gap-3">
                      <Show when={autonomousHealth.data?.queue.hasPendingContinuation}>
                        <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-2">
                          <div class="text-11-medium uppercase tracking-wide text-text-weak">Queue control</div>
                          <div class="flex flex-wrap gap-2">
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={queueControlLoading() !== null}
                              onClick={() => void runQueueControl("resume_once")}
                            >
                              {queueControlLoading() === "resume_once" ? "Resuming…" : "Resume once"}
                            </Button>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={queueControlLoading() !== null}
                              onClick={() => void runQueueControl("drop_pending")}
                            >
                              {queueControlLoading() === "drop_pending" ? "Dropping…" : "Drop pending"}
                            </Button>
                          </div>
                          <Show when={queueControlError()}>
                            {(message) => <div class="text-11-regular text-warning">{message()}</div>}
                          </Show>
                        </div>
                      </Show>
                      {(() => {
                        const processCards = () =>
                          buildProcessCards((monitorEntries() ?? []) as EnrichedMonitorEntry[], params.id)
                        const { freshnessNow: toolPageFreshnessNow } = useFreshnessClock()
                        const warnInvalidReceivedAt = createRateLimitedWarn((msg, detail) => {
                          // eslint-disable-next-line no-console
                          console.warn(msg, detail)
                        })
                        return (
                          <Show
                            when={processCards().length > 0}
                            fallback={<div class="text-12-regular text-text-weak">No active tasks.</div>}
                          >
                            <For each={processCards()}>
                              {(card) => {
                                const [aborting, setAborting] = createSignal(false)
                                const handleAbort = async () => {
                                  if (!card.canAbort || aborting()) return
                                  setAborting(true)
                                  try {
                                    await sdk.client.session.abort({ sessionID: card.sessionID })
                                  } catch {
                                  } finally {
                                    setAborting(false)
                                  }
                                }
                                const borderColor = () =>
                                  card.status === "active"
                                    ? "var(--color-success)"
                                    : card.status === "error"
                                      ? "var(--color-warning)"
                                      : card.status === "waiting"
                                        ? "var(--color-info)"
                                        : "var(--border-weak-base)"
                                const statusLabel = () =>
                                  card.status === "active"
                                    ? "Running"
                                    : card.status === "error"
                                      ? "Error"
                                      : card.status === "waiting"
                                        ? "Waiting"
                                        : card.status === "pending"
                                          ? "Pending"
                                          : ""
                                const fidelity = createMemo<Fidelity>(() =>
                                  classifyFidelity(
                                    card.receivedAt,
                                    toolPageFreshnessNow(),
                                    {
                                      softSec: uiFreshnessThresholdSec(),
                                      hardSec: uiFreshnessHardTimeoutSec(),
                                    },
                                    uiFreshnessEnabled(),
                                    { onInvalid: (raw) => warnInvalidReceivedAt(card.key, raw) },
                                  ),
                                )
                                const secondsSinceReceived = createMemo(() => {
                                  const rxAt = card.receivedAt
                                  if (typeof rxAt !== "number" || !Number.isFinite(rxAt) || rxAt <= 0)
                                    return undefined
                                  return Math.max(0, Math.floor((toolPageFreshnessNow() - rxAt) / 1000))
                                })
                                const elapsed = () => {
                                  if (fidelity() === "hard-stale") return ""
                                  return card.elapsed == null
                                    ? ""
                                    : card.elapsed < 60
                                      ? `${card.elapsed}s`
                                      : Math.floor(card.elapsed / 60) < 60
                                        ? `${Math.floor(card.elapsed / 60)}m`
                                        : `${Math.floor(Math.floor(card.elapsed / 60) / 60)}h${Math.floor(card.elapsed / 60) % 60}m`
                                }
                                const cardOpacity = () =>
                                  fidelity() === "hard-stale" ? 0.4 : fidelity() === "stale" ? 0.75 : 1
                                const staleHint = () => {
                                  if (fidelity() === "fresh") return undefined
                                  const s = secondsSinceReceived()
                                  if (s === undefined) return "stale"
                                  return `updated ${s}s ago`
                                }
                                return (
                                  <div
                                    class="rounded-md border bg-background-base px-3 py-2 flex flex-col gap-1"
                                    style={{
                                      "border-left": `3px solid ${borderColor()}`,
                                      "border-color": "var(--border-weak-base)",
                                      "border-left-color": borderColor(),
                                      opacity: cardOpacity(),
                                    }}
                                  >
                                    <div class="flex items-start gap-2 min-w-0">
                                      <div class="min-w-0 flex-1">
                                        <div class="text-12-medium text-text-strong break-words">
                                          {card.title}
                                          <Show when={card.agent && card.kind === "subagent"}>
                                            <a
                                              class="text-info hover:underline cursor-pointer"
                                              onClick={(e) => {
                                                e.preventDefault()
                                                e.stopPropagation()
                                                navigate(`/${params.dir}/session/${card.sessionID}`)
                                              }}
                                            >
                                              {" "}@{card.agent}
                                            </a>
                                          </Show>
                                        </div>
                                      </div>
                                      <Show when={card.canAbort}>
                                        <button
                                          class="shrink-0 text-11-medium text-text-weak hover:text-warning cursor-pointer bg-transparent border-none p-0 leading-none"
                                          title="Stop this process"
                                          onClick={handleAbort}
                                        >
                                          {aborting() ? "…" : "✕"}
                                        </button>
                                      </Show>
                                    </div>
                                    <Show when={card.activity}>
                                      <div class="text-11-regular text-info break-words">{card.activity}</div>
                                    </Show>
                                    <div class="text-11-regular text-text-weak break-words">
                                      {statusLabel()}
                                      {elapsed() ? ` · ${elapsed()}` : ""}
                                      {card.model ? ` · ${card.model.modelID}` : ""}
                                      {` · ${card.requests} reqs · ${card.totalTokens.toLocaleString()} tok`}
                                    </div>
                                    <Show when={staleHint()}>
                                      {(hint) => (
                                        <div class="text-11-regular text-text-weak break-words italic">
                                          {hint()}
                                        </div>
                                      )}
                                    </Show>
                                  </div>
                                )
                              }}
                            </For>
                          </Show>
                        )
                      })()}
                    </div>
                  </Show>
                </Show>
              </Show>
            }
            skillsContent={
              <Show when={params.id} fallback={<div class="text-12-regular text-text-weak">No active session.</div>}>
                {(() => {
                  const [layers, setLayers] = createSignal<SkillLayerState[]>([])
                  const [error, setError] = createSignal<string | null>(null)
                  const formatTimestamp = (value?: number) => {
                    if (!value) return "—"
                    return new Date(value).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  }
                  const fetchLayers = async () => {
                    const sid = params.id
                    if (!sid) return
                    try {
                      const res = await sdk.fetch(`${sdk.url}/api/v2/session/${sid}/skill-layer`)
                      if (!res.ok) {
                        const body = await res.json().catch(() => ({ message: "Failed to load skill layers." }))
                        throw new Error(body.message || "Failed to load skill layers.")
                      }
                      setError(null)
                      const payload = (await res.json()) as SkillLayerState[]
                      setLayers(payload)
                    } catch (e) {
                      console.error(e)
                      setError(e instanceof Error ? e.message : "Failed to load skill layers.")
                    }
                  }
                  const runAction = async (name: string, action: string) => {
                    const sid = params.id
                    if (!sid) return
                    setError(null)
                    try {
                      const res = await sdk.fetch(`${sdk.url}/api/v2/session/${sid}/skill-layer/${name}/action`, {
                        method: "POST",
                        headers: { "content-type": "application/json", "x-opencode-directory": sdk.directory },
                        body: JSON.stringify({ action }),
                      })
                      if (!res.ok) throw new Error((await res.json()).message || "Action failed")
                      const payload = (await res.json()) as SkillLayerActionResponse
                      setLayers(payload.entries)
                    } catch (e: any) {
                      setError(e.message)
                    }
                  }
                  createEffect(() => void fetchLayers())

                  return (
                    <>
                      <Show when={error()}>
                        <div class="text-11-regular text-warning">{error()}</div>
                      </Show>
                      <Show
                        when={layers().length > 0}
                        fallback={<div class="text-12-regular text-text-weak">No managed skills.</div>}
                      >
                        <For each={layers()}>
                          {(layer) => (
                            <div class="flex flex-col gap-1 p-1.5 rounded hover:bg-surface-tertiary">
                              <div class="flex items-center justify-between min-w-0 gap-2">
                                <span class="text-12-medium text-text-strong truncate" title={layer.name}>
                                  {layer.name}
                                  <Show when={layer.pinned}>
                                    <span class="ml-1 text-warning">★</span>
                                  </Show>
                                </span>
                                <div class="flex gap-1 shrink-0">
                                  <button
                                    class="text-11-medium text-text-weak hover:text-text-strong"
                                    onClick={() => void runAction(layer.name, layer.pinned ? "unpin" : "pin")}
                                  >
                                    {layer.pinned ? "Unpin" : "Pin"}
                                  </button>
                                  <button
                                    class="text-11-medium text-text-weak hover:text-text-strong"
                                    onClick={() => void runAction(layer.name, "promote")}
                                  >
                                    Full
                                  </button>
                                  <button
                                    class="text-11-medium text-text-weak hover:text-text-strong"
                                    onClick={() => void runAction(layer.name, "demote")}
                                  >
                                    Sum
                                  </button>
                                  <button
                                    class="text-11-medium text-text-weak hover:text-warning"
                                    onClick={() => void runAction(layer.name, "unload")}
                                  >
                                    Drop
                                  </button>
                                </div>
                              </div>
                              <div class="flex items-center gap-2 text-11-regular text-text-weak">
                                <span
                                  classList={{
                                    "text-success": layer.runtimeState === "active",
                                    "text-info": layer.runtimeState === "sticky",
                                    "text-warning": layer.runtimeState === "summarized",
                                  }}
                                >
                                  [{layer.runtimeState}]
                                </span>
                                <span>{layer.desiredState}</span>
                                <span class="truncate max-w-[100px]">{layer.lastReason}</span>
                              </div>
                              <div class="text-11-regular text-text-weak">last used {formatTimestamp(layer.lastUsedAt)}</div>
                            </div>
                          )}
                        </For>
                      </Show>
                    </>
                  )
                })()}
              </Show>
            }
          />
        </Show>
        <Show when={tool() === "context"}>
          <SessionContextTab
            messages={messages}
            visibleUserMessages={visibleUserMessages}
            view={view}
            info={info}
            telemetry={telemetry}
          />
        </Show>
      </div>
    </div>
  )
}
