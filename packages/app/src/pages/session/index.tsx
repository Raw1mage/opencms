import { onCleanup, Show, Match, Switch, createMemo, createEffect, createSignal, on, batch, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { SessionContextUsage } from "@/components/session-context-usage"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useCodeComponent } from "@opencode-ai/ui/context/code"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { Mark } from "@opencode-ai/ui/logo"

import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { checksum, base64Encode } from "@opencode-ai/util/encode"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/components/dialog-select-file"
import FileTree from "@/components/file-tree"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNavigate, useParams } from "@solidjs/router"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useComments, type LineComment } from "@/context/comments"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { usePermission } from "@/context/permission"
import { showToast } from "@opencode-ai/ui/toast"
import { SessionHeader, SessionContextTab, SortableTab, FileVisual, NewSessionView } from "@/components/session"
import { navMark, navParams } from "@/utils/perf"
import { same } from "@/utils/same"
import { handoff } from "./utils/handoff"

import { StickyAddButton, SessionReviewTab } from "./review-tab"
import { useSessionCommands } from "./use-session-commands"
import { MessageTimeline } from "./message-timeline"
import { FileTabContent } from "./file-tabs"
import { TerminalPanel } from "./terminal-panel"
import { SessionPromptDock } from "./session-prompt-dock"
import { closestMessage, createScrollSpy } from "./scroll-spy"
import { markScrollGesture, isScrollGestureActive } from "./message-gesture"
import { useSessionHashScroll, anchor, scrollToElement } from "./use-session-hash-scroll"
import { useSessionBackfill } from "./use-session-backfill"
import { useSessionHandoff } from "./use-session-handoff"
import { SessionMobileTabs } from "./session-mobile-tabs"
import { SessionSidePanel } from "./session-side-panel"

export default function Page() {
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const terminal = useTerminal()
  const dialog = useDialog()
  const codeComponent = useCodeComponent()
  const command = useCommand()
  const language = useLanguage()
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const prompt = usePrompt()
  const comments = useComments()
  const permission = usePermission()

  const request = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return
    const next = sync.data.permission[sessionID]?.[0]
    if (!next) return
    if (next.tool) return
    return next
  })

  const questionRequest = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return
    return sync.data.question[sessionID]?.[0]
  })

  const blocked = createMemo(() => !!request() || !!questionRequest())

  const [ui, setUi] = createStore({
    responding: false,
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    autoCreated: false,
  })

  createEffect(
    on(
      () => request()?.id,
      () => setUi("responding", false),
      { defer: true },
    ),
  )

  const decide = (response: "once" | "always" | "reject") => {
    const perm = request()
    if (!perm) return
    if (ui.responding) return

    setUi("responding", true)
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setUi("responding", false))
  }
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  if (import.meta.env.DEV) {
    createEffect(
      on(
        () => [params.dir, params.id] as const,
        ([dir, id], prev) => {
          if (!id) return
          navParams({ dir, from: prev?.[1], to: id })
        },
      ),
    )

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!prompt.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:prompt-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!terminal.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:terminal-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!file.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:file-view-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (sync.data.message[id] === undefined) return
      navMark({ dir: params.dir, to: id, name: "session:data-ready" })
    })
  }

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const centered = createMemo(() => isDesktop() && !layout.fileTree.opened())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().open(next)

    const path = file.pathFromTab(next)
    if (path) file.load(path)
  }

  createEffect(() => {
    const active = tabs().active()
    if (!active) return

    const path = file.pathFromTab(active)
    if (path) file.load(path)
  })

  createEffect(() => {
    const current = tabs().all()
    if (current.length === 0) return

    const next = normalizeTabs(current)
    if (same(current, next)) return

    tabs().setAll(next)

    const active = tabs().active()
    if (!active) return
    if (!active.startsWith("file://")) return

    const normalized = normalizeTab(active)
    if (active === normalized) return
    tabs().setActive(normalized)
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const reviewCount = createMemo(() => diffs().length)
  const hasReview = createMemo(() => reviewCount() > 0)
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const emptyUserMessages: UserMessage[] = []
  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        if (msg.agent) local.agent.set(msg.agent)
        if (msg.model) local.model.set({ providerID: msg.model.providerId, modelID: msg.model.modelID })
      },
    ),
  )

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    activeTerminalDraggable: undefined as string | undefined,
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
    turnStart: 0,
    mobileTab: "session" as "session" | "changes",
    newSessionWorktree: "main",
    promptHeight: 0,
  })

  const renderedUserMessages = createMemo(
    () => {
      const msgs = visibleUserMessages()
      const start = store.turnStart
      if (start <= 0) return msgs
      if (start >= msgs.length) return emptyUserMessages
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sync.data.path.directory !== project.worktree) return sync.data.path.directory
    return "main"
  })

  const activeMessage = createMemo(() => {
    if (!store.messageId) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === store.messageId)
    return found ?? lastUserMessage()
  })
  const setActiveMessage = (message: UserMessage | undefined) => {
    setStore("messageId", message?.id)
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = activeMessage()
    const currentIndex = current ? msgs.findIndex((m) => m.id === current.id) : -1
    const targetIndex = currentIndex === -1 ? (offset > 0 ? 0 : msgs.length - 1) : currentIndex + offset
    if (targetIndex < 0 || targetIndex >= msgs.length) return

    if (targetIndex === msgs.length - 1) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const add = diff.additions > 0
      const del = diff.deletions > 0
      const kind = add && del ? "mix" : add ? "add" : del ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })
  const emptyDiffFiles: string[] = []
  const diffFiles = createMemo(() => diffs().map((d) => d.file), emptyDiffFiles, { equals: same })
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const idle = { type: "idle" as const }
  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined

  const scrollGestureWindowMs = 250

  const markScrollGestureHandler = (target?: EventTarget | null) => {
    if (markScrollGesture(scroller, target)) {
      setUi("scrollGesture", Date.now())
    }
  }

  const hasScrollGesture = () => isScrollGestureActive(ui.scrollGesture, scrollGestureWindowMs)

  createEffect(() => {
    if (!params.id) return
    sync.session.sync(params.id)
  })

  createEffect(() => {
    if (!view().terminal.opened()) {
      setUi("autoCreated", false)
      return
    }
    if (!terminal.ready() || terminal.all().length !== 0 || ui.autoCreated) return
    terminal.new()
    setUi("autoCreated", true)
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount !== undefined && prevCount > 0 && count === 0) {
          if (view().terminal.opened()) {
            view().terminal.toggle()
          }
        }
      },
    ),
  )

  const focusTerminal = (id: string) => {
    // Immediately remove focus
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    const wrapper = document.getElementById(`terminal-wrapper-${id}`)
    const element = wrapper?.querySelector('[data-component="terminal"]') as HTMLElement
    if (!element) return

    // Find and focus the ghostty textarea (the actual input element)
    const textarea = element.querySelector("textarea") as HTMLTextAreaElement
    if (textarea) {
      textarea.focus()
      return
    }
    // Fallback: focus container and dispatch pointer event
    element.focus()
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))
  }

  createEffect(
    on(
      () => terminal.active(),
      (activeId) => {
        if (!activeId || !view().terminal.opened()) return
        focusTerminal(activeId)
      },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  const status = createMemo(() => sync.data.session_status[params.id ?? ""] ?? idle)

  createEffect(
    on(
      () => params.id,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const id = lastUserMessage()?.id
    if (!id) return
    setStore("expanded", id, status().type !== "idle")
  })

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    const start = Math.max(1, Math.min(selection.startLine, selection.endLine))
    const end = Math.max(selection.startLine, selection.endLine)
    const lines = content.split("\n").slice(start - 1, end)
    if (lines.length === 0) return undefined
    return lines.slice(0, 2).join("\n")
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const activeElement = document.activeElement as HTMLElement | undefined
    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(activeElement.tagName) || activeElement.isContentEditable
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Don't autofocus chat if terminal panel is open
    if (view().terminal.opened()) return

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGestureHandler()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      inputRef?.focus()
    }
  }

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const currentTabs = tabs().all()
      const fromIndex = currentTabs?.indexOf(draggable.id.toString())
      const toIndex = currentTabs?.indexOf(droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== undefined) {
        tabs().move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeTerminalDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const terminals = terminal.all()
      const fromIndex = terminals.findIndex((t: LocalPTY) => t.id === draggable.id.toString())
      const toIndex = terminals.findIndex((t: LocalPTY) => t.id === droppable.id.toString())
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        terminal.move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeTerminalDraggable", undefined)
    const activeId = terminal.active()
    if (!activeId) return
    setTimeout(() => {
      focusTerminal(activeId)
    }, 0)
  }

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context"),
  )

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  const reviewScroll = () => tree.reviewScroll
  const setReviewScroll = (value: HTMLDivElement | undefined) => setTree("reviewScroll", value)
  const pendingDiff = () => tree.pendingDiff
  const setPendingDiff = (value: string | undefined) => setTree("pendingDiff", value)
  const activeDiff = () => tree.activeDiff
  const setActiveDiff = (value: string | undefined) => setTree("activeDiff", value)

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const [touchGesture, setTouchGesture] = createSignal<number | undefined>()

  useSessionCommands({
    command,
    dialog,
    file,
    language,
    local,
    permission,
    prompt,
    sdk,
    sync,
    terminal,
    layout,
    params,
    navigate,
    tabs,
    view,
    activeMessage,
    visibleUserMessages,
    userMessages,
    info,
    status,
    setExpanded: (id, fn) => setStore("expanded", id, fn),
    setActiveMessage,
    showAllFiles,
    addSelectionToContext,
    navigateMessageByOffset,
    focusInput: () => inputRef?.focus(),
  })

  const { scheduleTurnBackfill, cancelTurnBackfill } = useSessionBackfill({
    scroller: () => scroller,
    messagesReady,
    messageCount: () => visibleUserMessages().length,
    onBackfill: (index) => setStore("turnStart", index),
    turnStart: () => store.turnStart,
  })

  useSessionHandoff({ tabs })

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Match when={hasReview()}>
            <Show
              when={diffsReady()}
              fallback={<div class="px-6 py-4 text-text-weak">{language.t("session.review.loadingChanges")}</div>}
            >
              <SessionReviewTab
                diffs={diffs}
                view={view}
                diffStyle={layout.review.diffStyle()}
                onDiffStyleChange={layout.review.setDiffStyle}
                onScrollRef={setReviewScroll}
                focusedFile={activeDiff()}
                onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
                comments={comments.all()}
                focusedComment={comments.focus()}
                onFocusedCommentChange={comments.setFocus}
                onViewFile={(path) => {
                  showAllFiles()
                  const value = file.tab(path)
                  tabs().open(value)
                  file.load(path)
                }}
              />
            </Show>
          </Match>
          <Match when={true}>
            <div class="h-full px-6 pb-30 flex flex-col items-center justify-center text-center gap-6">
              <Mark class="w-14 opacity-10" />
              <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.empty")}</div>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )

  createEffect(
    on(
      () => tabs().active(),
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        if (!file.pathFromTab(active)) return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    setFileTreeTab(value)
  }

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = reviewScroll()
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = reviewScroll()
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    const current = view().review.open() ?? []
    if (!current.includes(path)) view().review.setOpen([...current, path])
    setActiveDiff(path)
    setPendingDiff(path)
  }

  createEffect(() => {
    const pending = pendingDiff()
    if (!pending) return
    if (!reviewScroll()) return
    if (!diffsReady()) return

    const attempt = (count: number) => {
      if (pendingDiff() !== pending) return
      if (count > 60) {
        setPendingDiff(undefined)
        return
      }

      const root = reviewScroll()
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setPendingDiff(undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    return "empty"
  })

  createEffect(() => {
    if (!layout.ready()) return
    if (tabs().active()) return
    if (openedTabs().length === 0 && !contextOpen()) return

    const next = activeTab()
    if (next === "empty") return
    tabs().setActive(next)
  })

  createEffect(() => {
    const id = params.id
    if (!id) return
    const statusType = sync.data.session_status[id]?.type ?? "idle"

    const wants = isDesktop() ? layout.fileTree.opened() && fileTreeTab() === "changes" : store.mobileTab === "changes"
    if (!wants) return
    if (sync.status === "loading") return

    void sync.session.diff(id, { force: statusType === "idle" })
  })

  createEffect(() => {
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    void file.tree.list("")
  })

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  const { scrollToMessage, applyHash, clearMessageHash } = useSessionHashScroll({
    scroller: () => scroller,
    messages: visibleUserMessages,
    messagesReady,
    activeMessageId: () => store.messageId,
    onActiveChange: (id) => setStore("messageId", id),
    onPauseAutoScroll: () => autoScroll.pause(),
    onForceScrollToBottom: () => autoScroll.forceScrollToBottom(),
    turnStart: () => store.turnStart,
    onBackfill: (index) => {
      setStore("turnStart", index)
      scheduleTurnBackfill()
    },
  })

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
  }

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === store.promptHeight) return

      const el = scroller
      const stick = el ? el.scrollHeight - el.clientHeight - el.scrollTop < 10 : false

      setStore("promptHeight", next)

      if (stick && el) {
        requestAnimationFrame(() => {
          el.scrollTo({ top: el.scrollHeight, behavior: "auto" })
        })
      }
    },
  )

  const updateHash = (id: string) => {
    window.history.replaceState(null, "", `#${anchor(id)}`)
  }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    const raw = sessionStorage.getItem("opencode.pendingMessage")
    if (!raw) return
    const parts = raw.split("|")
    const pendingSessionID = parts[0]
    const messageID = parts[1]
    if (!pendingSessionID || !messageID) return
    if (pendingSessionID !== sessionID) return

    sessionStorage.removeItem("opencode.pendingMessage")
    setUi("pendingMessage", messageID)
  })

  createEffect(() => {
    const sessionID = params.id
    const ready = messagesReady()
    if (!sessionID || !ready) return

    // dependencies
    visibleUserMessages().length
    store.turnStart

    const hash = window.location.hash.slice(1)
    const match = hash.match(/^message-(.+)$/)
    if (!match) return
    const targetId = match[1]

    if (store.messageId === targetId) return

    const msg = visibleUserMessages().find((m) => m.id === targetId)
    if (!msg) return

    autoScroll.pause()
    requestAnimationFrame(() => scrollToMessage(msg, "auto"))
  })

  createEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    cancelTurnBackfill()
    document.removeEventListener("keydown", handleKeyDown)
    spy.destroy()
  })

  const [titleState, setTitleState] = createStore({
    draft: "",
    editing: false,
    saving: false,
    menuOpen: false,
    pendingRename: false,
  })

  const [scroll, setScroll] = createStore({ overflow: false, bottom: true })

  const spy = createScrollSpy({
    onActive: (id) => setStore("messageId", id),
  })

  createEffect(() => {
    const title = info()?.title
    if (title && !titleState.editing) {
      setTitleState("draft", title)
    }
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <SessionMobileTabs
          open={!!params.id}
          mobileTab={store.mobileTab}
          hasReview={hasReview()}
          reviewCount={reviewCount()}
          t={(k, v) => language.t(k as any, v)}
          onSession={() => setStore("mobileTab", "session")}
          onChanges={() => setStore("mobileTab", "changes")}
        />

        {/* Session panel */}
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger": true,
            "flex-1 pt-6 md:pt-3": true,
            "md:flex-none": layout.fileTree.opened(),
          }}
          style={{
            width: isDesktop() && layout.fileTree.opened() ? `${layout.session.width()}px` : "100%",
            "--prompt-height": store.promptHeight ? `${store.promptHeight}px` : undefined,
          }}
        >
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={params.id}>
                <Show when={activeMessage()}>
                  <Show
                    when={!mobileChanges()}
                    fallback={
                      <div class="relative h-full overflow-hidden">
                        <Switch>
                          <Match when={hasReview()}>
                            <Show
                              when={diffsReady()}
                              fallback={
                                <div class="px-4 py-4 text-text-weak">
                                  {language.t("session.review.loadingChanges")}
                                </div>
                              }
                            >
                              <SessionReviewTab
                                diffs={diffs}
                                view={view}
                                diffStyle="unified"
                                focusedFile={activeDiff()}
                                onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
                                comments={comments.all()}
                                focusedComment={comments.focus()}
                                onFocusedCommentChange={comments.setFocus}
                                onViewFile={(path) => {
                                  showAllFiles()
                                  const value = file.tab(path)
                                  tabs().open(value)
                                  file.load(path)
                                }}
                                classes={{
                                  root: "pb-[calc(var(--prompt-height,8rem)+32px)]",
                                  header: "px-4",
                                  container: "px-4",
                                }}
                              />
                            </Show>
                          </Match>
                          <Match when={true}>
                            <div class="h-full px-4 pb-30 flex flex-col items-center justify-center text-center gap-6">
                              <Mark class="w-14 opacity-10" />
                              <div class="text-14-regular text-text-weak max-w-56">
                                {language.t("session.review.empty")}
                              </div>
                            </div>
                          </Match>
                        </Switch>
                      </div>
                    }
                  >
                    <MessageTimeline
                      mobileChanges={mobileChanges()}
                      mobileFallback={
                        <NewSessionView
                          worktree={newSessionWorktree()}
                          onWorktreeChange={(value) => {
                            if (value === "create") {
                              setStore("newSessionWorktree", value)
                              return
                            }
                            setStore("newSessionWorktree", "main")
                            const target = value === "main" ? sync.project?.worktree : value
                            if (!target) return
                            if (target === sync.data.path.directory) return
                            layout.projects.open(target)
                            navigate(`/${base64Encode(target)}/session`)
                          }}
                        />
                      }
                      scroll={scroll}
                      onResumeScroll={resumeScroll}
                      setScrollRef={setScrollRef}
                      onScheduleScrollState={(el) => {
                        spy.setContainer(el)
                        setScroll({
                          overflow: el.scrollHeight > el.clientHeight,
                          bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 10,
                        })
                      }}
                      onAutoScrollHandleScroll={autoScroll.handleScroll}
                      onAutoScrollUserIntent={() => autoScroll.pause()}
                      onMarkScrollGesture={markScrollGestureHandler}
                      hasScrollGesture={hasScrollGesture}
                      isDesktop={isDesktop()}
                      onScrollSpyScroll={spy.onScroll}
                      onAutoScrollInteraction={() => autoScroll.pause()}
                      showHeader={!isDesktop()}
                      centered={centered()}
                      title={(info() as any)?.title}
                      parentID={(info() as any)?.parentID}
                      openTitleEditor={() => {
                        batch(() => {
                          setTitleState({
                            editing: true,
                            draft: (info() as any)?.title || language.t("app.name.desktop" as any),
                            menuOpen: false,
                          })
                        })
                      }}
                      closeTitleEditor={() => setTitleState("editing", false)}
                      saveTitleEditor={async () => {
                        const id = params.id
                        if (!id) return
                        setTitleState("saving", true)
                        await sdk.client.session.update({ sessionID: id, title: titleState.draft }).catch(() => {})
                        batch(() => {
                          setTitleState("saving", false)
                          setTitleState("editing", false)
                        })
                      }}
                      titleRef={(el) => setTimeout(() => el.focus(), 0)}
                      titleState={titleState}
                      onTitleDraft={(v) => setTitleState("draft", v)}
                      onTitleMenuOpen={(v) => setTitleState("menuOpen", v)}
                      onTitlePendingRename={(v) => setTitleState("pendingRename", v)}
                      onNavigateParent={() => {
                        const parent = info()?.parentID
                        if (parent) navigate(`/${params.dir}/${parent}`)
                      }}
                      sessionID={params.id!}
                      onDeleteSession={async (id) => {
                        await sdk.client.session.delete({ sessionID: id })
                        navigate(`/${params.dir}`)
                      }}
                      t={(k, v) => language.t(k as any, v as any)}
                      setContentRef={() => {}}
                      turnStart={store.turnStart}
                      onRenderEarlier={() => setStore("turnStart", 0)}
                      historyMore={historyMore()}
                      historyLoading={historyLoading()}
                      onLoadEarlier={() => params.id && sync.session.history.loadMore(params.id)}
                      renderedUserMessages={renderedUserMessages()}
                      anchor={anchor}
                      onRegisterMessage={spy.register}
                      onUnregisterMessage={spy.unregister}
                      expanded={store.expanded}
                      onToggleExpanded={(id) => setStore("expanded", id, (v) => !v)}
                    />
                  </Show>
                </Show>
              </Match>
              <Match when={true}>
                <NewSessionView
                  worktree={newSessionWorktree()}
                  onWorktreeChange={(value) => {
                    if (value === "create") {
                      setStore("newSessionWorktree", value)
                      return
                    }

                    setStore("newSessionWorktree", "main")

                    const target = value === "main" ? sync.project?.worktree : value
                    if (!target) return
                    if (target === sync.data.path.directory) return
                    layout.projects.open(target)
                    navigate(`/${base64Encode(target)}/session`)
                  }}
                />
              </Match>
            </Switch>
          </div>

          {/* Prompt input */}
          <SessionPromptDock
            centered={centered()}
            blocked={blocked()}
            permissionRequest={request}
            promptReady={prompt.ready()}
            handoffPrompt={handoff.prompt}
            t={(k, v) => language.t(k as any, v as any)}
            responding={ui.responding}
            onDecide={decide}
            questionRequest={questionRequest}
            inputRef={(el: HTMLDivElement) => (inputRef = el)}
            newSessionWorktree={newSessionWorktree()}
            onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
            onSubmit={resumeScroll}
            setPromptDockRef={(el: HTMLDivElement) => (promptDock = el)}
          />

          <Show when={isDesktop() && layout.fileTree.opened()}>
            <ResizeHandle
              direction="horizontal"
              size={layout.session.width()}
              min={450}
              max={window.innerWidth * 0.45}
              onResize={layout.session.resize}
            />
          </Show>
        </div>

        <SessionSidePanel
          open={!isDesktop() || layout.fileTree.opened()}
          reviewOpen={hasReview()}
          language={language}
          layout={layout}
          command={command}
          dialog={dialog}
          file={file}
          comments={comments}
          hasReview={hasReview()}
          reviewCount={reviewCount()}
          reviewTab={true}
          contextOpen={contextOpen}
          openedTabs={openedTabs}
          activeTab={activeTab}
          activeFileTab={() => {
            const active = tabs().active()
            if (!active) return undefined
            if (active === "context" || active === "review" || active === "empty") return undefined
            return active
          }}
          tabs={tabs}
          openTab={openTab}
          showAllFiles={showAllFiles}
          reviewPanel={reviewPanel}
          vm={{
            messages,
            visibleUserMessages,
            view,
            info,
          }}
          handoffFiles={() => handoff.files}
          codeComponent={codeComponent}
          addCommentToContext={addCommentToContext}
          activeDraggable={() => store.activeDraggable}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          diffFiles={diffFiles()}
          kinds={kinds()}
        />
      </div>

      <TerminalPanel
        open={view().terminal.opened()}
        height={layout.terminal.height()}
        resize={layout.terminal.resize}
        close={view().terminal.close}
        terminal={terminal}
        language={language}
        command={command}
        handoff={() => handoff.terminals}
        handleTerminalDragStart={handleTerminalDragStart}
        handleTerminalDragOver={handleTerminalDragOver}
        handleTerminalDragEnd={handleTerminalDragEnd}
        onCloseTab={() => {
          view().terminal.close()
          setUi("autoCreated", false)
        }}
        activeTerminalDraggable={() => store.activeTerminalDraggable}
      />
    </div>
  )
}
