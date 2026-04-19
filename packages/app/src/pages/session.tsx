import { For, onCleanup, Show, Match, Switch, createMemo, createEffect, createSignal, on } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Dynamic } from "solid-js/web"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore, produce } from "solid-js/store"
import { SessionContextUsage } from "@/components/session-context-usage"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useCodeComponent } from "@opencode-ai/ui/context/code"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { Mark } from "@opencode-ai/ui/logo"

import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { workspaceKey as normalizeWorkspaceKey } from "./layout/helpers"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { base64Encode } from "@opencode-ai/util/encode"
import { findLast } from "@opencode-ai/util/array"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectFile } from "@/components/dialog-select-file"
import FileTree from "@/components/file-tree"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNavigate, useParams } from "@solidjs/router"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useComments } from "@/context/comments"
import { sendSessionReloadDebugBeacon } from "@/utils/debug-beacon"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { usePermission } from "@/context/permission"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { SessionHeader, SessionContextTab, SortableTab, FileVisual, NewSessionView } from "@/components/session"
import { navMark, navParams } from "@/utils/perf"
import { same } from "@/utils/same"
import {
  createOpenReviewFile,
  focusTerminalById,
  getSessionArbitrationChips,
  getSessionWorkflowChips,
  getTabReorderIndex,
} from "@/pages/session/helpers"
import { useSessionResumeSync } from "@/pages/session/use-session-resume-sync"
import { createScrollSpy } from "@/pages/session/scroll-spy"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  SessionReviewTab,
  StickyAddButton,
  type DiffStyle,
  type SessionReviewTabProps,
} from "@/pages/session/review-tab"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { SessionPromptDock } from "@/pages/session/session-prompt-dock"
import {
  childSessionHref,
  deriveActiveChildStatus,
  formatActiveChildAgentLabel,
} from "@/pages/session/session-prompt-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/session-request-tree"
import { getAssistantSyncedSessionModel } from "@/pages/session/session-model-sync"

type HandoffSession = {
  prompt: string
  files: Record<string, SelectedLineRange | null>
}

const HANDOFF_MAX = 40

const handoff = {
  session: new Map<string, HandoffSession>(),
  terminal: new Map<string, string[]>(),
}

const touch = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > HANDOFF_MAX) {
    const first = map.keys().next().value
    if (first === undefined) return
    map.delete(first)
  }
}

const setSessionHandoff = (key: string, patch: Partial<HandoffSession>) => {
  const prev = handoff.session.get(key) ?? { prompt: "", files: {} }
  touch(handoff.session, key, { ...prev, ...patch })
}

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
  const globalSDK = useGlobalSDK()

  const permRequest = createMemo(() => {
    return sessionPermissionRequest(sync.data.session, sync.data.permission, params.id)
  })

  const questionRequest = createMemo(() => {
    return sessionQuestionRequest(sync.data.session, sync.data.question, params.id)
  })

  const blocked = createMemo(() => !!permRequest() || !!questionRequest())
  const connectionAuthorityReady = createMemo(() => globalSDK.connectionStatus() === "connected")

  const [ui, setUi] = createStore({
    responding: false,
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    autoCreated: false,
    scroll: {
      overflow: false,
      bottom: true,
    },
  })

  createEffect(
    on(
      () => permRequest()?.id,
      () => setUi("responding", false),
      { defer: true },
    ),
  )

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permRequest()
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
  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))
  let initialHydratedSessionID: string | undefined

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

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

  const isDesktop = createMediaQuery("(min-width: 450px)")
  // mobileScrollRepair removed: overflow-anchor fix eliminates the need

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

  const openFilePane = () => {
    if (!view().filePane.opened()) view().filePane.open()
  }

  const openTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().open(next)
    tabs().setActive(next)

    const path = file.pathFromTab(next)
    if (!path) return
    file.load(path)
    openFilePane()
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
  const sessionExecutionModel = createMemo(() => {
    const execution = info()?.execution
    if (!execution?.providerId || !execution?.modelID) return undefined
    return {
      providerID: execution.providerId,
      modelID: execution.modelID,
      accountID: execution.accountId,
    }
  })
  const workflowChips = createMemo(() => getSessionWorkflowChips(info() as any))
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  createEffect(
    on(
      () => [params.id, !!info(), messagesReady()] as const,
      ([id, hasInfo, ready]) => {
        if (!id) return
        const messageList = sync.data.message[id]
        const totalMessages = messageList?.length ?? 0
        if (false /* disabled */)
          console.debug("[session-reload-debug] session-page:state", {
            directory: sdk.directory,
            sessionID: id,
            hasInfo,
            messagesReady: ready,
            infoDirectory: info()?.directory,
            totalMessages,
          })
        sendSessionReloadDebugBeacon({
          sdk,
          event: "session-page:state",
          sessionID: id,
          payload: {
            hasInfo,
            messagesReady: ready,
            infoDirectory: info()?.directory,
            totalMessages,
          },
        })
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => [params.id, !!info(), messagesReady()] as const,
      ([id, hasInfo, ready]) => {
        if (!id) return
        if (initialHydratedSessionID !== id) initialHydratedSessionID = undefined
        if (hasInfo && ready) return
        if (initialHydratedSessionID === id) return
        initialHydratedSessionID = id
        if (false /* disabled */)
          console.debug("[session-reload-debug] session-page:hydrate", {
            directory: sdk.directory,
            sessionID: id,
            hasInfo,
            messagesReady: ready,
          })
        sendSessionReloadDebugBeacon({
          sdk,
          event: "session-page:hydrate",
          sessionID: id,
          payload: {
            hasInfo,
            messagesReady: ready,
          },
        })
        void sync.session.sync(id, { force: true })
      },
    ),
  )
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

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    saving: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  createEffect(
    on(
      sessionKey,
      () => setTitle({ draft: "", editing: false, saving: false, menuOpen: false, pendingRename: false }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!params.id) return
    setTitle({ editing: true, draft: info()?.title ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (title.saving) return
    setTitle({ editing: false, saving: false })
  }

  const saveTitleEditor = async () => {
    const sessionID = params.id
    if (!sessionID) return
    if (title.saving) return

    const next = title.draft.trim()
    if (!next || next === (info()?.title ?? "")) {
      setTitle({ editing: false, saving: false })
      return
    }

    setTitle("saving", true)
    await sdk.client.session
      .update({ sessionID, title: next })
      .then(() => {
        sync.set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session[index].title = next
          }),
        )
        setTitle({ editing: false, saving: false })
      })
      .catch((err) => {
        setTitle("saving", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  async function deleteSession(sessionID: string) {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const title = createMemo(() => sync.session.get(props.sessionID)?.title ?? language.t("command.session.new"))
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: title() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

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
  const lastCompletedAssistantMessage = createMemo(() =>
    messages().findLast((item) => item.role === "assistant" && item.time?.completed),
  )
  const arbitrationChips = createMemo(() => {
    const user = lastUserMessage()
    if (!user) return []
    const userParts = sync.data.part[user.id] ?? []
    const assistant = messages().findLast((item) => item.role === "assistant" && item.parentID === user.id)
    const assistantParts = assistant ? (sync.data.part[assistant.id] ?? []) : []
    return getSessionArbitrationChips({ userParts, toolParts: assistantParts })
  })

  createEffect(
    on(
      () => [params.id, sessionExecutionModel(), lastUserMessage()?.id] as const,
      () => {
        const executionModel = sessionExecutionModel()
        if (params.id && executionModel) {
          local.model.set(executionModel, undefined, params.id)
          return
        }
        const msg = lastUserMessage()
        if (!msg) return
        if (msg.agent) local.agent.set(msg.agent)
        if (msg.model) {
          const sessionModel = msg.model as { providerId: string; modelID: string; accountId?: string }
          local.model.set(
            {
              providerID: sessionModel.providerId,
              modelID: sessionModel.modelID,
              accountID: sessionModel.accountId,
            },
            undefined,
            params.id,
          )
        }
      },
    ),
  )

  createEffect(() => {
    const sessionID = params.id
    if (sessionExecutionModel()) return
    const assistant = lastCompletedAssistantMessage()
    if (!sessionID || !assistant) return
    const synced = getAssistantSyncedSessionModel({
      assistant: assistant as { id: string; role: string; providerId?: string; modelID?: string; accountId?: string },
      parts: (sync.data.part[assistant.id] ?? []) as Array<{
        type?: string
        synthetic?: boolean
        metadata?: { autonomousNarration?: boolean; excludeFromModel?: boolean }
      }>,
      lastUserModel: lastUserMessage()?.model as
        | { providerId?: string; modelID?: string; accountId?: string }
        | undefined,
      currentSelection: local.model.selection(sessionID),
    })
    if (!synced) return
    local.model.set(synced, undefined, sessionID)
  })

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    activeTerminalDraggable: undefined as string | undefined,
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
    turnStart: 0,
    newSessionWorktree: "main",
    promptHeight: 0,
    mobilePromptHeightLock: undefined as number | undefined, // deprecated: kept for store shape
  })

  const reviewDiffKey = createMemo(() => params.id)

  const reviewDiffs = createMemo(() => {
    const key = reviewDiffKey()
    if (!key) return []
    return sync.data.session_diff[key] ?? []
  })
  const workspaceDiffs = createMemo(() => {
    const key = reviewDiffKey()
    if (!key) return []
    return sync.data.workspace_diff[key] ?? []
  })
  const reviewCount = createMemo(() => reviewDiffs().length)
  const reviewBubbleCount = createMemo(() => workspaceDiffs().length)
  const hasReview = createMemo(() => reviewCount() > 0)

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
    if (project && normalizeWorkspaceKey(sdk.directory) !== normalizeWorkspaceKey(project.worktree))
      return sdk.directory
    return "main"
  })

  const activeMessage = createMemo(() => {
    if (!store.messageId) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === store.messageId)
    return found ?? lastUserMessage()
  })
  createEffect(
    on(
      () => [params.id, messagesReady(), messages().length, visibleUserMessages().length, activeMessage()?.id] as const,
      ([id, ready, total, visible, active]) => {
        if (!id) return
        if (false /* disabled */)
          console.debug("[session-reload-debug] session-page:render-gate", {
            directory: sdk.directory,
            sessionID: id,
            messagesReady: ready,
            totalMessages: total,
            visibleUserMessages: visible,
            activeMessageID: active,
          })
        sendSessionReloadDebugBeacon({
          sdk,
          event: "session-page:render-gate",
          sessionID: id,
          messageID: active,
          payload: {
            messagesReady: ready,
            totalMessages: total,
            visibleUserMessages: visible,
          },
        })
      },
      { defer: true },
    ),
  )
  const setActiveMessage = (message: UserMessage | undefined) => {
    setStore("messageId", message?.id)
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          visibleUserMessages().length,
          renderedUserMessages().length,
          store.turnStart,
          mobileChanges(),
        ] as const,
      ([id, ready, visible, rendered, turnStart, mobile]) => {
        if (!id) return
        sendSessionReloadDebugBeacon({
          sdk,
          event: "session-page:timeline-input",
          sessionID: id,
          payload: {
            messagesReady: ready,
            visibleUserMessages: visible,
            renderedUserMessages: rendered,
            turnStart,
            mobileChanges: mobile,
          },
        })
      },
      { defer: true },
    ),
  )

  const SessionLoadingFallback = () => {
    const id = params.id
    createEffect(() => {
      if (!id) return
      sendSessionReloadDebugBeacon({
        sdk,
        event: "session-page:loading-fallback-render",
        sessionID: id,
        payload: {
          messagesReady: messagesReady(),
          hasInfo: !!info(),
          totalMessages: messages().length,
          visibleUserMessages: visibleUserMessages().length,
          activeMessageID: activeMessage()?.id,
        },
      })
    })
    return (
      <div
        data-debug="session-page-loading-fallback"
        class="h-full flex items-center justify-center px-6 text-center text-text-weak"
      >
        {language.t("session.messages.loading")}
      </div>
    )
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
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
    for (const diff of workspaceDiffs()) {
      const file = normalize(diff.path)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

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
  const diffFiles = createMemo(() => workspaceDiffs().map((d) => d.path), emptyDiffFiles, { equals: same })
  const diffsReady = createMemo(() => {
    const key = reviewDiffKey()
    if (!key) return true
    if (!hasReview()) return true
    return sync.data.session_diff[key] !== undefined
  })
  const idle = { type: "idle" as const }
  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  useSessionResumeSync({ enabled: () => true, sessionID: () => params.id, sync })

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

  createEffect(
    on(
      () => terminal.active(),
      (activeId) => {
        if (!activeId || !view().terminal.opened()) return
        // Immediately remove focus
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        setTimeout(() => focusTerminalById(activeId), 0)
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
  const authoritativeParentSessionID = createMemo(() => info()?.parentID ?? params.id)
  const activeChild = createMemo(() => {
    const sessionID = authoritativeParentSessionID()
    if (!sessionID) return undefined
    return sync.data.active_child[sessionID]
  })
  const hasActiveChild = createMemo(() => !!activeChild())
  const sessionBusy = createMemo(() => status().type !== "idle" || hasActiveChild())
  createEffect(() => {
    const sessionID = authoritativeParentSessionID()
    if (!sessionID) return
    if (connectionAuthorityReady()) return
    sync.set(
      produce((draft) => {
        delete draft.active_child[sessionID]
      }),
    )
  })

  const activeChildDock = createMemo(() => {
    if (!connectionAuthorityReady()) return undefined
    const child = activeChild()
    if (!child) return undefined
    const childMessages = sync.data.message[child.sessionID] ?? []
    const childSession = sync.session.get(child.sessionID)
    const derived = deriveActiveChildStatus({
      activeChild: child,
      messages: childMessages,
      partsByMessage: sync.data.part,
    })
    return {
      agent: formatActiveChildAgentLabel(child.agent),
      title: derived.title,
      step: derived.step,
      href: childSessionHref(sdk.directory, child.sessionID),
      sessionID: child.sessionID,
      startedAt: child.dispatchedAt ?? childSession?.time.created,
    }
  })
  const visibleChildDock = createMemo(() => {
    const dock = activeChildDock()
    if (!dock) return undefined
    // Show dock when viewing the parent session (no parentID) or the active child session
    const isParentView = !info()?.parentID
    return isParentView || dock.sessionID === params.id ? dock : undefined
  })

  createEffect(() => {
    const child = activeChild()
    if (!child) return
    void sync.session.sync(child.sessionID)
    const timer = setInterval(() => {
      void sync.session.sync(child.sessionID, { force: true })
    }, 3000)
    onCleanup(() => clearInterval(timer))
  })

  // mobilePromptHeightLock effect removed: overflow-anchor: none on contentRef
  // eliminates browser anchoring, so prompt-dock height locking is no longer needed.
  createEffect(
    on(
      () => status().type !== "idle",
      (active) => {
        if (active || hasActiveChild()) return
        // When session goes idle, re-measure prompt dock in case it changed
        const measured = promptDock ? Math.ceil(promptDock.getBoundingClientRect().height) : undefined
        if (measured && measured !== store.promptHeight) setStore("promptHeight", measured)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
        setUi("autoCreated", false)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const id = lastUserMessage()?.id
    if (!id) return
    setStore("expanded", id, sessionBusy())
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
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (blocked()) return
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
      const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
      if (toIndex === undefined) return
      tabs().move(draggable.id.toString(), toIndex)
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
      focusTerminalById(activeId)
    }, 0)
  }

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context" && tab !== "review"),
  )

  const mobileChanges = createMemo(() => !isDesktop() && view().filePane.opened())
  const viewportMetrics = () => {
    if (typeof window === "undefined") return {}
    return {
      innerHeight: window.innerHeight,
      visualViewportHeight: window.visualViewport?.height,
      visualViewportOffsetTop: window.visualViewport?.offsetTop,
      visualViewportPageTop: window.visualViewport?.pageTop,
    }
  }
  const reviewTab = createMemo(() => isDesktop())

  const showAllFiles = () => {
    // No-op: desktop file tree now always shows all files.
  }

  const focusInput = () => inputRef?.focus()

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
    info,
    status,
    userMessages,
    visibleUserMessages,
    activeMessage,
    showAllFiles,
    navigateMessageByOffset,
    setExpanded: (id, fn) => setStore("expanded", id, fn),
    setActiveMessage,
    addSelectionToContext,
    focusInput,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const emptyTurn = () => (
    <div class="h-full pb-30 flex flex-col items-center justify-center text-center gap-6">
      <Mark class="w-14 opacity-10" />
      <div class="text-14-regular text-text-weak max-w-56">{language.t("session.review.noChanges")}</div>
    </div>
  )

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Switch>
      <Match when={!diffsReady()}>
        <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      </Match>
      <Match when={hasReview()}>
        <SessionReviewTab
          diffs={reviewDiffs}
          view={view}
          diffStyle={input.diffStyle}
          onDiffStyleChange={input.onDiffStyleChange}
          onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
          comments={comments.all()}
          focusedComment={comments.focus()}
          onFocusedCommentChange={comments.setFocus}
          onViewFile={openReviewFile}
          classes={input.classes}
        />
      </Match>
      <Match when={true}>
        <SessionReviewTab
          empty={emptyTurn()}
          diffs={reviewDiffs}
          view={view}
          diffStyle={input.diffStyle}
          onDiffStyleChange={input.onDiffStyleChange}
          onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
          comments={comments.all()}
          focusedComment={comments.focus()}
          onFocusedCommentChange={comments.setFocus}
          onViewFile={openReviewFile}
          classes={input.classes}
        />
      </Match>
    </Switch>
  )

  const changesPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-30 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active === "context") return "context"
    if (active === "review" && reviewTab()) return "review"
    if (active && file.pathFromTab(active)) return normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (reviewTab() && hasReview()) return "review"
    return "empty"
  })

  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })

  const desktopFilePaneOpen = createMemo(() => isDesktop() && view().filePane.opened())
  const desktopToolSidebarOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const desktopSidePanelOpen = createMemo(() => desktopFilePaneOpen() || desktopToolSidebarOpen())
  const sessionPanelWidth = createMemo(() => {
    if (!desktopFilePaneOpen()) return "100%"
    if (desktopFilePaneOpen()) return `${layout.session.width()}px`
    return "100%"
  })
  const centered = createMemo(() => isDesktop() && !desktopFilePaneOpen())

  createEffect(() => {
    if (!layout.ready()) return
    if (tabs().active()) return
    if (openedTabs().length === 0 && !contextOpen() && !(reviewTab() && hasReview())) return

    const next = activeTab()
    if (next === "empty") return
    tabs().setActive(next)
  })

  createEffect(() => {
    const id = params.id
    if (!id) return
    if (sync.status === "loading") return

    void sync.session.diff(id, { force: true })
    void sync.session.workspaceDiff(id, { force: true })
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    const wants = isDesktop()
      ? (desktopToolSidebarOpen() && layout.fileTree.mode() === "changes") ||
        (desktopFilePaneOpen() && activeTab() === "review")
      : view().filePane.opened()
    if (!wants) return
    if (sync.status === "loading") return

    void sync.session.diff(id, { force: true })
    void sync.session.workspaceDiff(id, { force: true })
  })

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (layout.fileTree.mode() !== "files") return
    if (sync.status === "loading") return

    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        void file.tree.list("")

        const active = tabs().active()
        if (!active) return
        const path = file.pathFromTab(active)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
    debugName: "session-page",
    followOnResize: true,
    resumeOnly: true,
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  const scrollSpy = createScrollSpy({
    onActive: (id) => {
      if (id === store.messageId) return
      setStore("messageId", id)
    },
  })

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const overflow = max > 1
    const bottom = !overflow || el.scrollTop >= max - 2

    if (typeof window !== "undefined" && window.localStorage.getItem("opencode:scroll-debug") === "1") {
      const viewportTop = el.getBoundingClientRect().top
      const viewportBottom = viewportTop + el.clientHeight
      const blockCandidates = Array.from(
        el.querySelectorAll<HTMLElement>(
          [
            '[data-slot="session-turn-sticky"]',
            '[data-slot="session-turn-collapsible-content-inner"]',
            '[data-slot="session-turn-summary-section"]',
            '[data-component="user-message"]',
          ].join(","),
        ),
      )
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return {
            slot: node.dataset.slot ?? node.dataset.component ?? "unknown",
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            visible: rect.bottom > viewportTop && rect.top < viewportBottom,
            topDistance: Math.abs(rect.top - viewportTop),
          }
        })
        .filter((node) => node.visible)
        .sort((a, b) => a.topDistance - b.topDistance)
        .slice(0, 3)

      console.debug("[scroll-debug]", {
        time: Date.now(),
        scope: "session-page",
        event: "viewport-blocks",
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop,
        blocks: blockCandidates,
      })
    }

    if (typeof window !== "undefined" && window.localStorage.getItem("opencode:scroll-debug") === "1") {
      console.debug("[scroll-debug]", {
        time: Date.now(),
        scope: "session-page-state",
        event: "update-scroll-state",
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        maxScrollTop: max,
        distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop,
        overflow,
        bottom,
      })
    }

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom) return
    setUi("scroll", { overflow, bottom })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.resume()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
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

  createEffect(
    on(
      autoScroll.mode,
      (mode) => {
        if (typeof window !== "undefined" && window.localStorage.getItem("opencode:scroll-debug") === "1") {
          console.debug("[scroll-debug] session-page:mode", {
            sessionID: params.id,
            mode,
            bottom: ui.scroll.bottom,
            overflow: ui.scroll.overflow,
          })
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        scrollSpy.clear()
      },
      { defer: true },
    ),
  )

  const anchor = (id: string) => `message-${id}`

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    scrollSpy.setContainer(el)
    if (el) scheduleScrollState(el)
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      scrollSpy.markDirty()
    },
  )

  const turnInit = 20
  const turnBatch = 20
  let turnHandle: number | undefined
  let turnIdle = false

  function cancelTurnBackfill() {
    const handle = turnHandle
    if (handle === undefined) return
    turnHandle = undefined

    if (turnIdle && window.cancelIdleCallback) {
      window.cancelIdleCallback(handle)
      return
    }

    clearTimeout(handle)
  }

  function scheduleTurnBackfill() {
    if (turnHandle !== undefined) return
    if (store.turnStart <= 0) return

    if (window.requestIdleCallback) {
      turnIdle = true
      turnHandle = window.requestIdleCallback(() => {
        turnHandle = undefined
        backfillTurns()
      })
      return
    }

    turnIdle = false
    turnHandle = window.setTimeout(() => {
      turnHandle = undefined
      backfillTurns()
    }, 0)
  }

  function backfillTurns() {
    const start = store.turnStart
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    const el = scroller
    if (!el) {
      setStore("turnStart", nextStart)
      scheduleTurnBackfill()
      return
    }

    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight

    setStore("turnStart", nextStart)

    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })

    scheduleTurnBackfill()
  }

  createEffect(
    on(
      () => [params.id, messagesReady()] as const,
      ([id, ready]) => {
        cancelTurnBackfill()
        setStore("turnStart", 0)
        if (!id || !ready) return

        const len = visibleUserMessages().length
        const start = len > turnInit ? len - turnInit : 0
        setStore("turnStart", start)
        scheduleTurnBackfill()
      },
      { defer: true },
    ),
  )

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const measured = Math.ceil(height)

      if (measured === store.promptHeight) return

      const el = scroller
      const delta = measured - store.promptHeight
      const stick = el ? el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta) : false

      if (typeof window !== "undefined" && window.localStorage.getItem("opencode:scroll-debug") === "1") {
        console.debug("[scroll-debug]", {
          time: Date.now(),
          scope: "session-page-state",
          event: "prompt-dock-resize",
          promptHeightBefore: store.promptHeight,
          promptHeightAfter: measured,
          promptHeightDelta: delta,
          stick,
          scrollTop: el?.scrollTop,
          scrollHeight: el?.scrollHeight,
          clientHeight: el?.clientHeight,
          distanceFromBottom: el ? el.scrollHeight - el.clientHeight - el.scrollTop : undefined,
          ...viewportMetrics(),
        })
      }

      setStore("promptHeight", measured)

      if (stick) autoScroll.scrollToBottom()

      if (el) scheduleScrollState(el)
      scrollSpy.markDirty()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    working: () => sessionBusy(),
    visibleUserMessages,
    turnStart: () => store.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: (value) => setStore("turnStart", value),
    scheduleTurnBackfill,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPrompt() })
  })

  createEffect(() => {
    if (!terminal.ready()) return
    language.locale()

    touch(
      handoff.terminal,
      params.dir!,
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  createEffect(() => {
    if (!file.ready()) return
    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc
          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null
          return acc
        }, {}),
    })
  })

  // Direct render: listen for file open requests from tool invocation buttons
  const handleOpenFile = (e: Event) => {
    const detail = (e as CustomEvent).detail as { path: string } | undefined
    if (!detail?.path) return
    const tabValue = `file://${detail.path}`
    openTab(tabValue)
  }
  window.addEventListener("opencode:open-file", handleOpenFile)

  onCleanup(() => {
    cancelTurnBackfill()
    document.removeEventListener("keydown", handleKeyDown)
    window.removeEventListener("opencode:open-file", handleOpenFile)
    scrollSpy.destroy()
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <SessionHeader />
      <div
        class="flex-1 min-h-0 flex"
        classList={{
          "flex-col": !isDesktop(),
          "flex-row": isDesktop(),
        }}
      >
        {/* Session panel */}
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger": true,
            "flex-1 pt-2 md:pt-3": true,
            "md:flex-none": desktopFilePaneOpen(),
          }}
          style={{
            width: sessionPanelWidth(),
            "--prompt-height": store.promptHeight ? `${store.promptHeight}px` : undefined,
          }}
        >
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={params.id}>
                <Show when={messagesReady()} fallback={<SessionLoadingFallback />}>
                  <MessageTimeline
                    mobileChanges={mobileChanges()}
                    mobileFallback={reviewContent({
                      diffStyle: "unified",
                      classes: {
                        root: "pb-[calc(var(--prompt-height,8rem)+32px)]",
                        header: "px-4",
                        container: "px-4",
                      },
                      loadingClass: "px-4 py-4 text-text-weak",
                      emptyClass: "h-full pb-30 flex flex-col items-center justify-center text-center gap-6",
                    })}
                    scroll={ui.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onAutoScrollUserIntent={autoScroll.pause}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    isDesktop={isDesktop()}
                    onScrollSpyScroll={scrollSpy.onScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    userScrolled={autoScroll.userScrolled}
                    showHeader={!!(info()?.title || info()?.parentID)}
                    centered={centered()}
                    title={info()?.title}
                    dirtyCount={reviewBubbleCount()}
                    parentID={info()?.parentID}
                    workflowChips={workflowChips()}
                    arbitrationChips={arbitrationChips()}
                    openTitleEditor={openTitleEditor}
                    closeTitleEditor={closeTitleEditor}
                    saveTitleEditor={saveTitleEditor}
                    titleRef={(el: HTMLInputElement) => {
                      titleRef = el
                    }}
                    titleState={title}
                    onTitleDraft={(value: string) => setTitle("draft", value)}
                    onTitleMenuOpen={(open: boolean) => setTitle("menuOpen", open)}
                    onTitlePendingRename={(value: boolean) => setTitle("pendingRename", value)}
                    onNavigateParent={() => {
                      navigate(`/${params.dir}/session/${info()?.parentID}`)
                    }}
                    sessionID={params.id!}
                    onDeleteSession={(sessionID: string) =>
                      dialog.show(() => <DialogDeleteSession sessionID={sessionID} />)
                    }
                    t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
                    setContentRef={(el: HTMLDivElement) => {
                      content = el
                      autoScroll.contentRef(el)

                      const root = scroller
                      if (root) scheduleScrollState(root)
                    }}
                    turnStart={store.turnStart}
                    onRenderEarlier={() => setStore("turnStart", 0)}
                    historyMore={historyMore()}
                    historyLoading={historyLoading()}
                    onLoadEarlier={() => {
                      const id = params.id
                      if (!id) return
                      setStore("turnStart", 0)
                      sync.session.history.loadMore(id)
                    }}
                    renderedUserMessages={renderedUserMessages()}
                    anchor={anchor}
                    onRegisterMessage={scrollSpy.register}
                    onUnregisterMessage={scrollSpy.unregister}
                    onFirstTurnMount={() => {
                      const id = params.id
                      if (!id) return
                      navMark({ dir: params.dir, to: id, name: "session:first-turn-mounted" })
                    }}
                    lastUserMessageID={lastUserMessage()?.id}
                    expanded={store.expanded}
                    onToggleExpanded={(id: string) => setStore("expanded", id, (open: boolean | undefined) => !open)}
                  />
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
                    if (target === sdk.directory) return
                    layout.projects.open(target)
                    navigate(`/${base64Encode(target)}/session`)
                  }}
                />
              </Match>
            </Switch>
          </div>

          <SessionPromptDock
            centered={centered()}
            isChildSession={!!info()?.parentID}
            parentSessionHref={info()?.parentID ? `/${params.dir}/session/${info()?.parentID}` : undefined}
            questionRequest={questionRequest}
            permissionRequest={permRequest}
            blocked={blocked()}
            promptReady={prompt.ready()}
            handoffPrompt={handoff.session.get(sessionKey())?.prompt}
            t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
            responding={ui.responding}
            onDecide={decide}
            inputRef={(el: HTMLDivElement) => {
              inputRef = el
            }}
            newSessionWorktree={newSessionWorktree()}
            onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
            onSubmit={() => {
              comments.clear()
              resumeScroll()
            }}
            setPromptDockRef={(el: HTMLDivElement) => (promptDock = el)}
            activeChild={visibleChildDock()}
            onOpenChildSession={(href) => navigate(href)}
            onAbortActiveChild={async () => {
              const parentSessionID = info()?.parentID ?? params.id
              if (!parentSessionID) return
              await sdk.client.session.abort({ sessionID: parentSessionID })
            }}
          />

          <Show when={desktopFilePaneOpen()}>
            <ResizeHandle
              direction="horizontal"
              size={layout.session.width()}
              min={450}
              max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
              onResize={layout.session.resize}
            />
          </Show>
        </div>

        <SessionSidePanel
          fileOpen={desktopFilePaneOpen()}
          toolOpen={desktopToolSidebarOpen()}
          language={language}
          layout={layout}
          command={command}
          dialog={dialog}
          file={file}
          comments={comments}
          openedTabs={openedTabs}
          activeTab={activeTab}
          activeFileTab={activeFileTab}
          tabs={tabs}
          openTab={openTab}
          showAllFiles={showAllFiles}
          changesPanel={changesPanel}
          vm={{
            messages,
            visibleUserMessages,
            view,
            info,
          }}
          handoffFiles={() => handoff.session.get(sessionKey())?.files}
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
        handoff={() => handoff.terminal.get(params.dir!) ?? []}
        activeTerminalDraggable={() => store.activeTerminalDraggable}
        handleTerminalDragStart={handleTerminalDragStart}
        handleTerminalDragOver={handleTerminalDragOver}
        handleTerminalDragEnd={handleTerminalDragEnd}
        onCloseTab={() => setUi("autoCreated", false)}
      />
    </div>
  )
}
