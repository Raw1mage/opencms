import { createEffect, createMemo, For, Show } from "solid-js"
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
import {
  buildMonitorEntries,
  buildProcessCards,
  type EnrichedMonitorEntry,
  type ProcessCard,
} from "./monitor-helper"
import { SessionStatusSections } from "./session-status-sections"
import { StatusTodoList } from "./status-todo-list"
import { useStatusMonitor } from "./use-status-monitor"
import { useStatusTodoSync } from "./use-status-todo-sync"
import { useAutonomousHealthSync } from "./use-autonomous-health-sync"
import { useSessionResumeSync } from "./use-session-resume-sync"
import { decode64 } from "@/utils/base64"

export default function SessionToolPageRoute() {
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const params = useParams<{ dir?: string; id?: string; tool?: string }>()
  const [searchParams, setSearchParams] = useSearchParams<{ file?: string }>()
  const sync = useSync()
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

  useSessionResumeSync({ enabled: () => true, sessionID: () => params.id, sync })

  useStatusTodoSync({
    enabled: () => tool() === "status",
    sessionID: () => params.id,
    sdk,
    sync,
  })

  const monitor = useStatusMonitor({
    enabled: () => tool() === "status",
    sessionID: () => params.id,
    sdk,
    sync,
  })
  const autonomousHealth = useAutonomousHealthSync({
    enabled: () => tool() === "status",
    sessionID: () => params.id,
    sdk,
    status: () => (params.id ? sync.data.session_status[params.id] : undefined),
  })

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
  // Runner card removed

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

  const closeFileViewer = () => {
    navigate(`${backPath()}/tool/files`)
  }
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
                      {(() => {
                        const processCards = () =>
                          buildProcessCards(
                            (monitorEntries() ?? []) as EnrichedMonitorEntry[],
                            params.id,
                          )
                        return (
                          <Show
                            when={processCards().length > 0}
                            fallback={<div class="text-12-regular text-text-weak">No active tasks.</div>}
                          >
                            <For each={processCards()}>
                              {(card) => {
                                const borderColor = () => {
                                  if (card.status === "active") return "var(--color-success)"
                                  if (card.status === "error") return "var(--color-warning)"
                                  if (card.status === "waiting") return "var(--color-info)"
                                  return "var(--border-weak-base)"
                                }
                                const statusLabel = () => {
                                  if (card.status === "active") return "Running"
                                  if (card.status === "error") return "Error"
                                  if (card.status === "waiting") return "Waiting"
                                  if (card.status === "pending") return "Pending"
                                  return ""
                                }
                                const elapsed = () => {
                                  if (card.elapsed == null) return ""
                                  if (card.elapsed < 60) return `${card.elapsed}s`
                                  const mins = Math.floor(card.elapsed / 60)
                                  if (mins < 60) return `${mins}m`
                                  return `${Math.floor(mins / 60)}h${mins % 60}m`
                                }
                                return (
                                  <div
                                    class="rounded-md border bg-background-base px-3 py-2 flex flex-col gap-1"
                                    style={{
                                      "border-left": `3px solid ${borderColor()}`,
                                      "border-color": "var(--border-weak-base)",
                                      "border-left-color": borderColor(),
                                    }}
                                  >
                                    <div class="text-12-medium text-text-strong break-words">
                                      {card.title}
                                      <Show when={card.agent && card.kind === "subagent"}>
                                        <span class="text-text-weak"> @{card.agent}</span>
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
          />
        </Show>

        <Show when={tool() === "context"}>
          <SessionContextTab messages={messages} visibleUserMessages={visibleUserMessages} view={view} info={info} />
        </Show>
      </div>
    </div>
  )
}
