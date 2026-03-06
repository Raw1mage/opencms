import { For, Show, createEffect, createMemo, onCleanup, type JSX, type ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { StickyAddButton } from "@/pages/session/review-tab"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { Message, SessionMonitorInfo, Todo, UserMessage } from "@opencode-ai/sdk/v2/client"
import { buildMonitorEntries, MONITOR_LEVEL_LABELS, MONITOR_STATUS_LABELS } from "./monitor-helper"
import { SessionStatusSections } from "./session-status-sections"

const TODO_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

type SessionSidePanelViewModel = {
  messages: () => Message[]
  visibleUserMessages: () => UserMessage[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
}

export function SessionSidePanel(props: {
  open: boolean
  reviewOpen: boolean
  language: ReturnType<typeof useLanguage>
  layout: ReturnType<typeof useLayout>
  command: ReturnType<typeof useCommand>
  dialog: ReturnType<typeof useDialog>
  file: ReturnType<typeof useFile>
  comments: ReturnType<typeof useComments>
  hasReview: boolean
  reviewCount: number
  reviewTab: boolean
  contextOpen: () => boolean
  openedTabs: () => string[]
  activeTab: () => string
  activeFileTab: () => string | undefined
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  openTab: (value: string) => void
  showAllFiles: () => void
  reviewPanel: () => JSX.Element
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
  const sdk = useSDK()
  const openedTabs = createMemo(() => props.openedTabs())
  const sideMode = createMemo(() => props.layout.fileTree.mode())
  const activeSessionID = createMemo(() => props.vm.info()?.id)
  const panelTitle = createMemo(() => {
    if (sideMode() === "status") return props.language.t("status.popover.trigger")
    return props.language.t("session.tools.files")
  })

  const todos = createMemo(() => {
    const sessionID = activeSessionID()
    if (!sessionID) return undefined
    const list = sync.data.todo[sessionID]
    if (!list) return undefined
    return [...list].sort((a, b) => (TODO_ORDER[a.status] ?? 99) - (TODO_ORDER[b.status] ?? 99))
  })

  createEffect(() => {
    if (sideMode() !== "status") return
    const sessionID = activeSessionID()
    if (!sessionID) return
    if (sync.data.todo[sessionID] !== undefined) return
    void sync.session.todo(sessionID)
  })

  const [monitor, setMonitor] = createStore({
    items: [] as SessionMonitorInfo[],
    loading: false,
    error: undefined as string | undefined,
  })

  createEffect(() => {
    if (sideMode() !== "status") return
    const sessionID = activeSessionID()
    if (!sessionID) {
      setMonitor({ items: [], loading: false, error: undefined })
      return
    }

    let cancelled = false
    const load = async () => {
      setMonitor("loading", true)
      try {
        const result = await sdk.client.session.top({ sessionID, includeDescendants: true, maxMessages: 400 })
        if (cancelled) return
        setMonitor({ items: result.data ?? [], loading: false, error: undefined })
      } catch (error) {
        if (cancelled) return
        setMonitor({
          items: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void load()
    const timer = setInterval(() => {
      void load()
    }, 2000)

    onCleanup(() => {
      cancelled = true
      clearInterval(timer)
    })
  })

  const monitorEntries = createMemo(() =>
    buildMonitorEntries({
      raw: monitor.items,
      session: props.vm.info(),
      messages: props.vm.messages(),
      status: activeSessionID() ? sync.data.session_status[activeSessionID()!] : undefined,
    }),
  )

  const secondaryPanel = () => (
    <div
      id="session-side-panel-secondary"
      class="relative shrink-0 h-full"
      style={{ width: `${props.layout.fileTree.width()}px` }}
    >
      <div
        class="h-full flex flex-col overflow-hidden group/filetree"
        classList={{ "border-l border-border-weak-base": props.reviewOpen }}
      >
        <div class="h-10 px-3 flex items-center justify-between text-12-medium text-text-weak border-b border-border-weak-base">
          <span>{panelTitle()}</span>
        </div>

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
            todoSection={
              <section class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-surface-panel px-3 py-3">
                <div class="text-12-medium text-text-weak uppercase tracking-wide">
                  {props.language.t("session.tools.todo")}
                </div>
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
                  {props.language.t("session.tools.monitor")}
                </div>
                <Show
                  when={activeSessionID()}
                  fallback={<div class="text-12-regular text-text-weak">No active session.</div>}
                >
                  <Show
                    when={!monitor.loading}
                    fallback={<div class="text-12-regular text-text-weak">Loading monitor…</div>}
                  >
                    <Show
                      when={!monitor.error}
                      fallback={<div class="text-12-regular text-text-danger">{monitor.error}</div>}
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
    </div>
  )

  return (
    <Show when={props.open}>
      <aside
        id="review-panel"
        aria-label={props.language.t("session.panel.reviewAndFiles")}
        class="relative min-w-0 h-full border-l border-border-weak-base flex"
        classList={{
          "flex-1": props.reviewOpen,
          "shrink-0": !props.reviewOpen,
        }}
        style={{ width: props.reviewOpen ? undefined : `${props.layout.fileTree.width()}px` }}
      >
        <Show when={props.reviewOpen}>
          <div class="flex-1 min-w-0 h-full">
            <DragDropProvider
              onDragStart={props.onDragStart}
              onDragEnd={props.onDragEnd}
              onDragOver={props.onDragOver}
              collisionDetector={closestCenter}
            >
              <DragDropSensors />
              <ConstrainDragYAxis />
              <Tabs value={props.activeTab()} onChange={props.openTab}>
                <div class="sticky top-0 shrink-0 flex">
                  <Tabs.List
                    ref={(el: HTMLDivElement) => {
                      const stop = createFileTabListSync({ el, contextOpen: props.contextOpen })
                      onCleanup(stop)
                    }}
                  >
                    <Show when={props.reviewTab}>
                      <Tabs.Trigger value="review" classes={{ button: "!pl-6" }}>
                        <div class="flex items-center gap-1.5">
                          <div>{props.language.t("session.tab.review")}</div>
                          <Show when={props.hasReview}>
                            <div class="text-12-medium text-text-strong h-4 px-2 flex flex-col items-center justify-center rounded-full bg-surface-base">
                              {props.reviewCount}
                            </div>
                          </Show>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                    <Show when={props.contextOpen()}>
                      <Tabs.Trigger
                        value="context"
                        closeButton={
                          <TooltipKeybind
                            title={props.language.t("common.closeTab")}
                            keybind={props.command.keybind("tab.close")}
                            placement="bottom"
                            gutter={10}
                          >
                            <IconButton
                              icon="close-small"
                              variant="ghost"
                              class="h-5 w-5"
                              onClick={() => props.tabs().close("context")}
                              aria-label={props.language.t("common.closeTab")}
                            />
                          </TooltipKeybind>
                        }
                        hideCloseButton
                        onMiddleClick={() => props.tabs().close("context")}
                      >
                        <div class="flex items-center gap-2">
                          <SessionContextUsage variant="indicator" />
                          <div>{props.language.t("session.tab.context")}</div>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                    <SortableProvider ids={openedTabs()}>
                      <For each={openedTabs()}>
                        {(tab) => <SortableTab tab={tab} onTabClose={props.tabs().close} />}
                      </For>
                    </SortableProvider>
                    <StickyAddButton>
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
                    </StickyAddButton>
                  </Tabs.List>
                </div>

                <Show when={props.reviewTab}>
                  <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={props.activeTab() === "review"}>{props.reviewPanel()}</Show>
                  </Tabs.Content>
                </Show>

                <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
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

                <Show when={props.contextOpen()}>
                  <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={props.activeTab() === "context"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <SessionContextTab
                          messages={props.vm.messages}
                          visibleUserMessages={props.vm.visibleUserMessages}
                          view={props.vm.view}
                          info={props.vm.info}
                        />
                      </div>
                    </Show>
                  </Tabs.Content>
                </Show>

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
        </Show>

        <Show when={props.layout.fileTree.opened()}>{secondaryPanel()}</Show>
      </aside>
    </Show>
  )
}
