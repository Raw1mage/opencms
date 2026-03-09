import { type ValidComponent, createEffect, createMemo, For, onCleanup, Show } from "solid-js"
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
import {
  buildMonitorEntries,
  type EnrichedMonitorEntry,
  MONITOR_LEVEL_LABELS,
  MONITOR_STATUS_LABELS,
  monitorTitle,
  monitorToolStatus,
} from "./monitor-helper"
import { SessionStatusSections } from "./session-status-sections"
import { StatusTodoList } from "./status-todo-list"
import { useStatusMonitor } from "./use-status-monitor"
import { useStatusTodoSync } from "./use-status-todo-sync"
import { createFileTabListSync, scrollTabIntoView } from "./file-tab-scroll"
import "./file-pane-scroll.css"

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
  const sdk = useSDK()
  const sideMode = createMemo(() => props.layout.fileTree.mode())
  const activeSessionID = createMemo(() => props.vm.info()?.id)
  const todos = createMemo(() => {
    const sessionID = activeSessionID()
    if (!sessionID) return undefined
    return sync.data.todo[sessionID]
  })

  useStatusTodoSync({
    enabled: () => sideMode() === "status",
    sessionID: activeSessionID,
    sdk,
    sync,
  })

  const monitor = useStatusMonitor({
    enabled: () => sideMode() === "status",
    sessionID: activeSessionID,
    sdk,
    sync,
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
    }),
  )

  const closeFilePane = () => {
    props.vm.view().filePane.close()
  }

  return (
    <>
      <Show when={props.fileOpen}>
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
                      const stop = createFileTabListSync({
                        el,
                        contextOpen: () => false,
                      })

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
                summaryContent={
                  <Show
                    when={activeSessionID()}
                    fallback={<div class="text-12-regular text-text-weak">No active session.</div>}
                  >
                    <div class="flex flex-col gap-3">
                      <Show
                        when={statusSummary().currentStep}
                        fallback={<div class="text-12-regular text-text-weak">No current step.</div>}
                      >
                        {(step) => (
                          <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                            <div class="text-11-medium uppercase tracking-wide text-text-weak">Current objective</div>
                            <div class="text-12-medium text-text-strong break-words">{step().content}</div>
                            <Show when={statusSummary().methodChips.length > 0}>
                              <div class="flex flex-wrap gap-1 pt-1">
                                <For each={statusSummary().methodChips}>
                                  {(chip) => (
                                    <span
                                      class="inline-flex h-5 px-1.5 items-center rounded-full border text-[11px] font-medium"
                                      classList={{
                                        "bg-info/12 text-info border-info/20": chip.tone === "info",
                                        "bg-success/12 text-success border-success/20": chip.tone === "success",
                                        "bg-warning/12 text-warning border-warning/20": chip.tone === "warning",
                                        "bg-surface-base text-text-muted border-border-weak-base":
                                          chip.tone === "neutral",
                                      }}
                                    >
                                      {chip.label}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        )}
                      </Show>

                      <Show when={statusSummary().processLines.length > 0}>
                        <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                          <div class="text-11-medium uppercase tracking-wide text-text-weak">Process</div>
                          <For each={statusSummary().processLines}>
                            {(line) => <div class="text-12-regular text-text-weak break-words">{line}</div>}
                          </For>
                        </div>
                      </Show>

                      <Show when={statusSummary().latestNarration}>
                        {(result) => (
                          <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                            <div class="text-11-medium uppercase tracking-wide text-text-weak">Latest narration</div>
                            <div
                              class="text-12-medium break-words"
                              classList={{
                                "text-success": result().tone === "success",
                                "text-warning": result().tone === "warning",
                                "text-info": result().tone === "info",
                                "text-text-strong": result().tone === "neutral",
                              }}
                            >
                              {result().label}
                            </div>
                          </div>
                        )}
                      </Show>

                      <Show when={statusSummary().debugLines.length > 0}>
                        <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                          <div class="text-11-medium uppercase tracking-wide text-text-weak">Debug</div>
                          <For each={statusSummary().debugLines}>
                            {(line) => <div class="text-12-regular text-text-weak break-words">{line}</div>}
                          </For>
                        </div>
                      </Show>

                      <Show when={statusSummary().smartRunnerHistory.length > 0}>
                        <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-2">
                          <div class="text-11-medium uppercase tracking-wide text-text-weak">Smart Runner history</div>
                          <For each={statusSummary().smartRunnerHistory}>
                            {(entry) => (
                              <div class="rounded-md border border-border-weak-base bg-surface-panel px-2 py-2 flex flex-col gap-1">
                                <div class="flex flex-wrap items-center gap-2">
                                  <span class="text-[11px] font-medium text-text-strong">
                                    {entry.time ?? "--:--:--"}
                                  </span>
                                  <span class="text-[11px] text-text-weak">{entry.status}</span>
                                  <Show when={entry.decision}>
                                    <span class="text-[11px] text-info">{entry.decision}</span>
                                  </Show>
                                  <Show when={entry.confidence}>
                                    <span class="text-[11px] text-text-weak">{entry.confidence}</span>
                                  </Show>
                                </div>
                                <Show when={entry.next}>
                                  <div class="text-12-regular text-text-weak break-words">Next: {entry.next}</div>
                                </Show>
                                <Show when={entry.assessment}>
                                  <div class="text-12-regular text-text-muted break-words">{entry.assessment}</div>
                                </Show>
                                <Show when={entry.assist}>
                                  <div class="text-12-regular text-info break-words">Assist: {entry.assist}</div>
                                </Show>
                                <Show when={entry.suggestion}>
                                  <div class="text-12-regular text-warning break-words">
                                    Suggestion: {entry.suggestion}
                                  </div>
                                </Show>
                                <Show when={entry.error}>
                                  <div class="text-12-regular text-warning break-words">Error: {entry.error}</div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>

                      <Show when={statusSummary().latestResult}>
                        {(result) => (
                          <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                            <div class="text-11-medium uppercase tracking-wide text-text-weak">Latest result</div>
                            <div
                              class="text-12-medium break-words"
                              classList={{
                                "text-success": result().tone === "success",
                                "text-warning": result().tone === "warning",
                                "text-info": result().tone === "info",
                                "text-text-strong": result().tone === "neutral",
                              }}
                            >
                              {result().label}
                            </div>
                          </div>
                        )}
                      </Show>
                    </div>
                  </Show>
                }
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
                        <Show
                          when={monitorEntries().length > 0}
                          fallback={<div class="text-12-regular text-text-weak">No active tasks.</div>}
                        >
                          <For each={monitorEntries() as EnrichedMonitorEntry[]}>
                            {(item) => (
                              <div class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 flex flex-col gap-1">
                                <div class="flex items-center gap-2 min-w-0">
                                  <span class="text-11-medium text-text-weak shrink-0">
                                    [{MONITOR_LEVEL_LABELS[item.level] ?? item.level}]
                                  </span>
                                  <span class="text-12-medium text-text-strong truncate">{monitorTitle(item)}</span>
                                </div>
                                <Show when={item.todo?.content}>
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
