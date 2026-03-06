import { createEffect, createMemo, createResource, For, Show } from "solid-js"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import FileTree from "@/components/file-tree"
import { SessionHeader } from "@/components/session"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { SessionMonitorInfo, Todo } from "@opencode-ai/sdk/v2/client"
import { buildMonitorEntries, MONITOR_LEVEL_LABELS, MONITOR_STATUS_LABELS } from "./monitor-helper"
import { SessionStatusSections } from "./session-status-sections"
import { decode64 } from "@/utils/base64"

const TODO_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

export default function SessionToolPageRoute() {
  const language = useLanguage()
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
    return "status" as const
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const todos = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    const list = sync.data.todo[id]
    if (!list) return undefined
    return [...list].sort((a, b) => (TODO_ORDER[a.status] ?? 99) - (TODO_ORDER[b.status] ?? 99))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return
    void sync.session.sync(id)
    if (tool() === "status" && sync.data.todo[id] === undefined) void sync.session.todo(id)
  })

  const [monitorRaw] = createResource(
    () => (tool() === "status" ? params.id : undefined),
    async (id) => {
      if (!id) return [] as SessionMonitorInfo[]
      const result = await sdk.client.session.top({ sessionID: id, includeDescendants: true, maxMessages: 400 })
      return result.data ?? []
    },
  )

  const monitorEntries = createMemo(() =>
    buildMonitorEntries({
      raw: monitorRaw() ?? [],
      session: info(),
      messages: messages(),
      status: params.id ? sync.data.session_status[params.id] : undefined,
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

  return (
    <div class="size-full flex flex-col bg-background-base">
      <SessionHeader />

      <div class="flex-1 min-h-0 overflow-auto bg-background-base">
        <Show when={tool() === "files"}>
          <Show
            when={selectedFile()}
            fallback={
              <div class="px-3 py-2 h-full overflow-auto" ref={fileTreeScrollEl}>
                <FileTree path="" modified={[]} kinds={new Map()} onFileClick={(node) => openFileViewer(node.path)} />
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
            todoSection={
              <section class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-surface-panel px-3 py-3">
                <div class="text-12-medium text-text-weak uppercase tracking-wide">
                  {language.t("session.tools.todo")}
                </div>
                <Show when={params.id} fallback={<div class="text-12-regular text-text-weak">No active session.</div>}>
                  <Show
                    when={todos() !== undefined}
                    fallback={<div class="text-12-regular text-text-weak">Loading to-dos…</div>}
                  >
                    <Show
                      when={(todos()?.length ?? 0) > 0}
                      fallback={<div class="text-12-regular text-text-weak">No to-dos yet.</div>}
                    >
                      <For each={todos() as Todo[]}>
                        {(todo) => (
                          <div class="flex items-start gap-2 rounded-md border border-border-weak-base bg-background-base px-3 py-2">
                            <div
                              class="mt-1 size-2 rounded-full shrink-0"
                              classList={{
                                "bg-text-warning": todo.status === "in_progress",
                                "bg-text-interactive-base": todo.status === "pending",
                                "bg-text-success": todo.status === "completed",
                                "bg-text-weak": todo.status === "cancelled",
                              }}
                            />
                            <div class="min-w-0 flex-1">
                              <div class="text-12-medium text-text-strong break-words">{todo.content}</div>
                              <div class="text-11-regular text-text-weak uppercase mt-1">
                                {todo.status.replaceAll("_", " ")}
                              </div>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                </Show>
              </section>
            }
            monitorSection={
              <section class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-surface-panel px-3 py-3">
                <div class="text-12-medium text-text-weak uppercase tracking-wide">
                  {language.t("session.tools.monitor")}
                </div>
                <Show when={params.id} fallback={<div class="text-12-regular text-text-weak">No active session.</div>}>
                  <Show
                    when={monitorRaw.state !== "pending"}
                    fallback={<div class="text-12-regular text-text-weak">Loading monitor…</div>}
                  >
                    <Show
                      when={monitorRaw.error === undefined}
                      fallback={<div class="text-12-regular text-text-danger">{String(monitorRaw.error)}</div>}
                    >
                      <Show
                        when={monitorEntries().length > 0}
                        fallback={<div class="text-12-regular text-text-weak">No active tasks.</div>}
                      >
                        <For each={monitorEntries()}>
                          {(item) => (
                            <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                              <div class="flex items-center gap-2 min-w-0">
                                <span class="text-11-medium text-text-weak shrink-0">
                                  [{MONITOR_LEVEL_LABELS[item.level] ?? item.level}]
                                </span>
                                <span class="text-12-medium text-text-strong truncate">
                                  {item.title || "Untitled session"}
                                </span>
                              </div>
                              <div class="text-11-regular text-text-weak break-words">
                                {MONITOR_STATUS_LABELS[item.status.type] ?? item.status.type}
                                {item.model ? ` · ${item.model.providerId}/${item.model.modelID}` : ""}
                                {` · ${item.requests} reqs · ${item.totalTokens.toLocaleString()} tok`}
                              </div>
                              <Show when={item.activeTool}>
                                <div class="text-11-regular text-text-weak break-words">
                                  Tool: {item.activeTool}
                                  <Show when={item.activeToolStatus}> · {item.activeToolStatus}</Show>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </Show>
                </Show>
              </section>
            }
          />
        </Show>
      </div>
    </div>
  )
}
