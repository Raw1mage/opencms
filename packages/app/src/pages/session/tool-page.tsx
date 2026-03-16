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
  buildRunnerDisplayCard,
  buildMonitorEntries,
  monitorDisplayCard,
  type EnrichedMonitorEntry,
  MONITOR_STATUS_LABELS,
  monitorToolStatus,
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
  const runnerCard = createMemo(() =>
    buildRunnerDisplayCard({
      currentStep: statusSummary().currentStep,
      methodChips: statusSummary().methodChips,
      processLines: statusSummary().processLines,
      status: params.id ? sync.data.session_status[params.id] : undefined,
      autonomousHealth: autonomousHealth.data,
      monitorEntries: monitorEntries() as EnrichedMonitorEntry[],
      messages: messages(),
      partsByMessage: sync.data.part,
    }),
  )

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
                      <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-2">
                        <div class="flex items-start gap-2 min-w-0">
                          <span class="text-11-medium text-text-weak shrink-0">[{runnerCard().badge}]</span>
                          <div class="min-w-0 flex-1">
                            <div class="text-12-medium text-text-strong break-words">{runnerCard().title}</div>
                          </div>
                        </div>
                        <Show when={(runnerCard().chips ?? []).length > 0}>
                          <div class="flex flex-wrap gap-1">
                            <For each={runnerCard().chips ?? []}>
                              {(chip) => (
                                <span
                                  class="inline-flex h-5 px-1.5 items-center rounded-full border text-[11px] font-medium"
                                  classList={{
                                    "bg-info/12 text-info border-info/20": chip.tone === "info",
                                    "bg-success/12 text-success border-success/20": chip.tone === "success",
                                    "bg-warning/12 text-warning border-warning/20": chip.tone === "warning",
                                    "bg-surface-base text-text-muted border-border-weak-base": chip.tone === "neutral",
                                  }}
                                >
                                  {chip.label}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                        <For each={runnerCard().lines ?? []}>
                          {(line) => <div class="text-12-regular text-text-weak break-words">{line}</div>}
                        </For>
                      </div>

                      <Show
                        when={(monitorEntries() ?? []).length > 0}
                        fallback={<div class="text-12-regular text-text-weak">No active tasks.</div>}
                      >
                        <For each={(monitorEntries() ?? []) as EnrichedMonitorEntry[]}>
                          {(item) => (
                            <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                              <div class="flex items-start gap-2 min-w-0">
                                <span class="text-11-medium text-text-weak shrink-0">
                                  [{monitorDisplayCard(item).badge}]
                                </span>
                                <div class="min-w-0 flex-1">
                                  <div class="text-12-medium text-text-strong break-words">
                                    {monitorDisplayCard(item).title}
                                    <Show when={monitorDisplayCard(item).headline}>
                                      {(headline) => <span class="text-text-weak"> · {headline()}</span>}
                                    </Show>
                                  </div>
                                </div>
                              </div>
                              <Show
                                when={item.todo?.content && item.todo?.content !== monitorDisplayCard(item).headline}
                              >
                                <div class="text-11-regular text-info break-words">Todo: {item.todo?.content}</div>
                              </Show>
                              <Show when={item.todo?.status}>
                                <div class="text-11-regular text-text-weak break-words">
                                  Todo status: {item.todo?.status}
                                </div>
                              </Show>
                              <div class="text-11-regular text-text-weak break-words">
                                {MONITOR_STATUS_LABELS[item.status.type] ?? item.status.type}
                                {item.model ? ` · ${item.model.providerId}/${item.model.modelID}` : ""}
                                {` · ${item.requests} reqs · ${item.totalTokens.toLocaleString()} tok`}
                              </div>
                              <Show
                                when={
                                  item.todo?.action?.kind ||
                                  item.todo?.action?.waitingOn ||
                                  item.todo?.action?.needsApproval
                                }
                              >
                                <div class="text-11-regular text-text-weak break-words">
                                  Method: {item.todo?.action?.kind ?? "implement"}
                                  {item.todo?.action?.waitingOn ? ` · waiting: ${item.todo.action.waitingOn}` : ""}
                                  {item.todo?.action?.needsApproval ? " · needs approval" : ""}
                                </div>
                              </Show>
                              <Show when={item.activeTool}>
                                <div class="text-11-regular text-text-weak break-words">
                                  Tool: {item.activeTool}
                                  <Show
                                    when={monitorToolStatus({
                                      statusType: item.status.type,
                                      activeToolStatus: item.activeToolStatus,
                                    })}
                                  >
                                    {(toolStatus) => <> · {toolStatus()}</>}
                                  </Show>
                                </div>
                              </Show>
                              <Show when={item.latestResult}>
                                <div class="text-11-regular text-text-weak break-words">
                                  Result: {item.latestResult}
                                </div>
                              </Show>
                              <Show when={item.latestNarration}>
                                <div class="text-11-regular text-info break-words">
                                  Narration: {item.latestNarration}
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
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
