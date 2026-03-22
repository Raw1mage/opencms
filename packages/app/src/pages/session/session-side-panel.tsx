import { type ValidComponent, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import FileTree from "@/components/file-tree"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { FileTabContent } from "@/pages/session/file-tabs"
import { StickyAddButton } from "@/pages/session/review-tab"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useNavigate, useParams } from "@solidjs/router"
import { useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { Message, Todo, UserMessage } from "@opencode-ai/sdk/v2/client"
import { getSessionStatusSummary } from "./helpers"
import { buildMonitorEntries, buildProcessCards, type EnrichedMonitorEntry } from "./monitor-helper"
import { SessionStatusSections } from "./session-status-sections"
import { StatusTodoList } from "./status-todo-list"
import { useStatusMonitor } from "./use-status-monitor"
import { useStatusTodoSync } from "./use-status-todo-sync"
import { useAutonomousHealthSync } from "./use-autonomous-health-sync"
import { createFileTabListSync, scrollTabIntoView } from "./file-tab-scroll"
import { Button } from "@opencode-ai/ui/button"
import { SessionTelemetryCards } from "./session-telemetry-cards"
import "./file-pane-scroll.css"
import { useGlobalSync } from "@/context/global-sync"
import { resolveTelemetryAccountLabel, useSessionTelemetryHydration } from "./session-telemetry-ui"

type SessionSidePanelViewModel = {
  messages: () => Message[]
  visibleUserMessages: () => UserMessage[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
}

export function SessionSidePanel(props: {
  fileOpen: boolean
  toolOpen: boolean
  language: ReturnType<typeof useLanguage>
  layout: ReturnType<typeof useLayout>
  command: ReturnType<typeof useCommand>
  dialog: ReturnType<typeof useDialog>
  file: ReturnType<typeof useFile>
  comments: ReturnType<typeof useComments>
  activeTab: () => string
  activeFileTab: () => string | undefined
  openedTabs: () => string[]
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  openTab: (value: string) => void
  showAllFiles: () => void
  changesPanel: () => any
  vm: SessionSidePanelViewModel
  handoffFiles: () => Record<string, SelectedLineRange | null> | undefined
  codeComponent: NonNullable<ValidComponent>
  addCommentToContext: (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => void
  activeDraggable: () => string | undefined
  onDragStart: (event: unknown) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent) => void
  diffFiles: string[]
  kinds: Map<string, "add" | "del" | "mix">
}) {
  const sync = useSync()
  const globalSync = useGlobalSync()
  const sdk = useSDK()
  const navigate = useNavigate()
  const params = useParams()
  const sideMode = createMemo(() => props.layout.fileTree.mode())
  const activeSessionID = createMemo(() => props.vm.info()?.id)
  const todos = createMemo(() => {
    const sessionID = activeSessionID()
    if (!sessionID) return undefined
    return sync.data.todo[sessionID]
  })

  useStatusTodoSync({ enabled: () => sideMode() === "status", sessionID: activeSessionID, sdk, sync })
  const monitor = useStatusMonitor({ enabled: () => sideMode() === "status", sessionID: activeSessionID, sdk, sync })
  const autonomousHealth = useAutonomousHealthSync({
    enabled: () => sideMode() === "status",
    sessionID: activeSessionID,
    sdk,
    status: () => (activeSessionID() ? sync.data.session_status[activeSessionID()!] : undefined),
  })

  const monitorEntries = createMemo(() =>
    buildMonitorEntries({
      raw: monitor.items,
      session: props.vm.info(),
      messages: props.vm.messages(),
      status: activeSessionID() ? sync.data.session_status[activeSessionID()!] : undefined,
      partsByMessage: sync.data.part,
    }),
  )
  const statusSummary = createMemo(() =>
    getSessionStatusSummary({
      session: props.vm.info() as any,
      todos: todos() as Todo[] | undefined,
      status: activeSessionID() ? sync.data.session_status[activeSessionID()!] : undefined,
      messages: props.vm.messages(),
      partsByMessage: sync.data.part,
      autonomousHealth: autonomousHealth.data,
    }),
  )
  const telemetry = createMemo(() => {
    const sessionID = activeSessionID()
    if (!sessionID) return undefined
    return sync.data.session_telemetry[sessionID]
  })
  const telemetryDeps = createMemo(() => {
    const sessionID = activeSessionID()
    if (!sessionID) return ""
    const status = sync.data.session_status[sessionID]
    const messageSignature = props.vm
      .messages()
      .map((message) => `${message.id}:${sync.data.part[message.id]?.length ?? 0}`)
      .join("|")
    const monitorSignature =
      sideMode() === "status"
        ? monitorEntries()
            .map(
              (entry) =>
                `${entry.sessionID}:${entry.status.type}:${entry.requests}:${entry.totalTokens}:${entry.updated}`,
            )
            .join("|")
        : ""
    return [
      sideMode(),
      props.vm.info()?.time.updated ?? 0,
      status?.type ?? "",
      messageSignature,
      sync.data.llm_errors.length,
      sync.data.llm_history.length,
      monitorSignature,
      sideMode() === "status" && monitor.loading && !monitor.initialized ? "loading" : "idle",
      sideMode() === "status" ? (monitor.error ?? "") : "",
    ].join("::")
  })
  useSessionTelemetryHydration({
    sessionID: activeSessionID,
    sync,
    deps: telemetryDeps,
    monitorEntries: () => (sideMode() === "status" ? (monitorEntries() as EnrichedMonitorEntry[]) : undefined),
    loading: () => sideMode() === "status" && monitor.loading && !monitor.initialized,
    error: () => (sideMode() === "status" ? monitor.error : undefined),
  })
  const [queueControlLoading, setQueueControlLoading] = createSignal<"resume_once" | "drop_pending" | null>(null)
  const [queueControlError, setQueueControlError] = createSignal<string | undefined>()
  const resolveAccountLabel = (accountId?: string, providerId?: string) =>
    resolveTelemetryAccountLabel(globalSync, accountId, providerId)

  const runQueueControl = async (action: "resume_once" | "drop_pending") => {
    const sessionID = activeSessionID()
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

  const closeFilePane = () => {
    props.vm.view().filePane.close()
  }

  return (
    <>
      <Show when={props.fileOpen}>
        {/* unchanged pane UI */}
        <aside
          id="session-file-pane"
          aria-label={props.language.t("session.tools.files")}
          class="relative flex-1 min-w-0 h-full border-l border-border-weak-base flex"
        >
          <div class="flex-1 min-w-0 h-full">
            <DragDropProvider
              onDragStart={props.onDragStart}
              onDragEnd={props.onDragEnd}
              onDragOver={props.onDragOver}
              collisionDetector={closestCenter}
            >
              <DragDropSensors />
              <ConstrainDragYAxis />
              <Tabs value={props.activeTab()} onChange={props.openTab} class="flex h-full min-h-0 flex-col">
                <div class="sticky top-0 shrink-0 flex min-w-0">
                  <div
                    class="file-tab-strip-scroll min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
                    ref={(el: HTMLDivElement) => {
                      const stop = createFileTabListSync({ el, contextOpen: () => false })
                      createEffect(() => {
                        const active = props.activeFileTab()
                        requestAnimationFrame(() => {
                          scrollTabIntoView({ el, activeTab: active })
                        })
                      })
                      onCleanup(stop)
                    }}
                  >
                    <Tabs.List class="min-w-max">
                      <SortableProvider ids={props.openedTabs()}>
                        <For each={props.openedTabs()}>
                          {(tab) => <SortableTab tab={tab} onTabClose={props.tabs().close} />}
                        </For>
                      </SortableProvider>
                    </Tabs.List>
                  </div>
                  <StickyAddButton>
                    <div class="flex items-center gap-1 shrink-0">
                      <TooltipKeybind
                        title={props.language.t("command.file.open")}
                        keybind={props.command.keybind("file.open")}
                        class="flex items-center"
                      >
                        <IconButton
                          icon="plus-small"
                          variant="ghost"
                          iconSize="large"
                          class="!rounded-md"
                          onClick={() =>
                            props.dialog.show(() => <DialogSelectFile mode="files" onOpenFile={props.showAllFiles} />)
                          }
                          aria-label={props.language.t("command.file.open")}
                        />
                      </TooltipKeybind>
                      <IconButton
                        icon="close-small"
                        variant="ghost"
                        class="h-6 w-6"
                        onClick={closeFilePane}
                        aria-label={props.language.t("common.close")}
                      />
                    </div>
                  </StickyAddButton>
                </div>
                <Tabs.Content value="empty" class="flex-1 min-h-0 overflow-auto contain-strict">
                  <Show when={props.activeTab() === "empty"}>
                    <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                      <div class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6">
                        <Mark class="w-14 opacity-10" />
                        <div class="text-14-regular text-text-weak max-w-56">
                          {props.language.t("session.files.selectToOpen")}
                        </div>
                      </div>
                    </div>
                  </Show>
                </Tabs.Content>
                <Show when={props.activeFileTab()} keyed>
                  {(tab) => (
                    <FileTabContent
                      tab={tab}
                      activeTab={props.activeTab}
                      tabs={props.tabs}
                      view={props.vm.view}
                      handoffFiles={props.handoffFiles}
                      file={props.file}
                      comments={props.comments}
                      language={props.language}
                      codeComponent={props.codeComponent}
                      addCommentToContext={props.addCommentToContext}
                    />
                  )}
                </Show>
              </Tabs>
              <DragOverlay>
                <Show when={props.activeDraggable()}>
                  {(tab) => {
                    const path = createMemo(() => props.file.pathFromTab(tab()))
                    return (
                      <div data-component="tabs-drag-preview">
                        <Show when={path()} keyed>
                          {(p) => <FileVisual active path={p} />}
                        </Show>
                      </div>
                    )
                  }}
                </Show>
              </DragOverlay>
            </DragDropProvider>
          </div>
        </aside>
      </Show>
      <Show when={props.toolOpen}>
        <aside
          id="session-tool-sidebar"
          aria-label={props.language.t("session.panel.reviewAndFiles")}
          class="relative shrink-0 h-full border-l border-border-weak-base"
          style={{ width: `${props.layout.fileTree.width()}px` }}
        >
          <div class="h-full flex flex-col overflow-hidden group/filetree">
            <Show when={sideMode() === "files"}>
              <div class="bg-background-base px-3 py-0 h-full overflow-auto">
                <FileTree
                  path=""
                  modified={props.diffFiles}
                  kinds={props.kinds}
                  onFileClick={(node) => props.openTab(props.file.tab(node.path))}
                />
              </div>
            </Show>
            <Show when={sideMode() === "status"}>
              <SessionStatusSections
                todoContent={
                  <Show
                    when={activeSessionID()}
                    fallback={<div class="text-12-regular text-text-weak">No active session.</div>}
                  >
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
                  <Show
                    when={activeSessionID()}
                    fallback={<div class="text-12-regular text-text-weak">No active session.</div>}
                  >
                    <Show
                      when={monitor.initialized || !monitor.loading}
                      fallback={<div class="text-12-regular text-text-weak">Loading monitor…</div>}
                    >
                      <Show
                        when={!monitor.error}
                        fallback={<div class="text-12-regular text-text-danger">{monitor.error}</div>}
                      >
                        <div class="flex flex-col gap-3">
                          <SessionTelemetryCards telemetry={telemetry()} accountLabel={resolveAccountLabel} />
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
                              buildProcessCards((monitorEntries() ?? []) as EnrichedMonitorEntry[], activeSessionID())
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
                                    const elapsed = () =>
                                      card.elapsed == null
                                        ? ""
                                        : card.elapsed < 60
                                          ? `${card.elapsed}s`
                                          : Math.floor(card.elapsed / 60) < 60
                                            ? `${Math.floor(card.elapsed / 60)}m`
                                            : `${Math.floor(Math.floor(card.elapsed / 60) / 60)}h${Math.floor(card.elapsed / 60) % 60}m`
                                    return (
                                      <div
                                        class="rounded-md border bg-background-base px-3 py-2 flex flex-col gap-1"
                                        style={{
                                          "border-left": `3px solid ${borderColor()}`,
                                          "border-color": "var(--border-weak-base)",
                                          "border-left-color": borderColor(),
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
            <Show when={sideMode() === "changes"}>
              <div class="relative flex-1 min-h-0 overflow-hidden">{props.changesPanel()}</div>
            </Show>
            <Show when={sideMode() === "context"}>
              <div class="relative flex-1 min-h-0 overflow-hidden">
                <SessionContextTab
                  messages={props.vm.messages}
                  visibleUserMessages={props.vm.visibleUserMessages}
                  view={props.vm.view}
                  info={props.vm.info}
                  telemetry={telemetry}
                />
              </div>
            </Show>
          </div>
          <ResizeHandle
            direction="horizontal"
            edge="start"
            size={props.layout.fileTree.width()}
            min={200}
            max={480}
            collapseThreshold={160}
            onResize={props.layout.fileTree.resize}
            onCollapse={props.layout.fileTree.close}
          />
        </aside>
      </Show>
    </>
  )
}
