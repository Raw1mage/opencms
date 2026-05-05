import { A, useNavigate, useParams } from "@solidjs/router"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject, getAvatarColors } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { DirtyCountBubble } from "@/components/dirty-count-bubble"
import { base64Encode } from "@opencode-ai/util/encode"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Icon } from "@opencode-ai/ui/icon"
import { MessageNav } from "@opencode-ai/ui/message-nav"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/util/binary"
import { getFilename } from "@opencode-ai/util/path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { type Message, type Session, type TextPart, type UserMessage } from "@opencode-ai/sdk/v2/client"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from "solid-js"
import { produce } from "solid-js/store"
import { agentColor } from "@/utils/agent"
import { hasProjectPermissions } from "./helpers"
import { sessionPermissionRequest } from "../session/session-request-tree"

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"
const sidebarDirtyInflight = new Map<string, Promise<void>>()

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  notify?: boolean
  directories?: string[]
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => props.directories ?? [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))
  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={
            props.project.id === OPENCODE_PROJECT_ID ? "https://opencode.ai/favicon.svg" : props.project.icon?.override
          }
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  labelOverride?: string
  child?: boolean
  slug: string
  mobile?: boolean
  dense?: boolean
  popover?: boolean
  children: Map<string, string[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
}

const SessionRow = (props: {
  session: Session
  label: Accessor<string>
  child: Accessor<boolean>
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  scheduleHoverPrefetch: () => void
  cancelHoverPrefetch: () => void
  timeLabel: Accessor<string>
  dirtyCount: Accessor<number>
  showActions: Accessor<boolean>
  actionMenu?: JSX.Element
  isActive: Accessor<boolean>
  onActiveSelect?: () => void
  ignoreClick?: () => boolean
}): JSX.Element => (
  <div class={`flex items-center min-w-0 w-full ${props.dense ? "gap-1" : "gap-2"}`}>
    <Show when={props.showActions()}>
      <div
        data-session-action
        class={`shrink-0 flex items-center justify-center text-text-weak ${props.dense ? "w-6" : "size-6"}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {props.actionMenu}
      </div>
    </Show>
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center justify-between min-w-0 text-left w-full focus:outline-none ${props.dense ? "py-0.5 gap-1" : "py-1 gap-2"}`}
      onPointerEnter={props.scheduleHoverPrefetch}
      onPointerLeave={props.cancelHoverPrefetch}
      onMouseEnter={props.scheduleHoverPrefetch}
      onMouseLeave={props.cancelHoverPrefetch}
      onFocus={() => props.prefetchSession(props.session, "high")}
      onClick={(event) => {
        if (props.ignoreClick?.()) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (props.isActive() && props.onActiveSelect) {
          event.preventDefault()
          props.onActiveSelect()
          return
        }
        props.setHoverSession(undefined)
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class={`flex items-center w-full ${props.dense ? "gap-1" : "gap-1.5"}`}>
        <div
          class={`shrink-0 flex items-center justify-center ${props.dense ? "w-2.5" : "size-4"}`}
          style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
        >
          <Switch fallback={<div class="size-1.5 rounded-full bg-transparent" />}>
            <Match when={props.isWorking()}>
              <Spinner class="size-[15px]" />
            </Match>
            <Match when={props.hasPermissions()}>
              <div class="size-1.5 rounded-full bg-surface-warning-strong" />
            </Match>
            <Match when={props.hasError()}>
              <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
            </Match>
            <Match when={props.unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
        <span
          class="text-13-regular grow min-w-0 overflow-hidden text-ellipsis truncate"
          classList={{
            "font-mono text-12-regular": props.child(),
            "text-text-interactive-base": props.isActive(),
            "text-text-strong": !props.isActive(),
          }}
        >
          {props.label()}
        </span>
        <Show when={props.dirtyCount() > 0}>
          <DirtyCountBubble count={props.dirtyCount()} active={props.isActive()} interactiveGroup="session" />
        </Show>
        <span
          class="shrink-0 min-w-[4.5rem] whitespace-nowrap text-right text-11-regular tabular-nums pr-0.5"
          classList={{
            "text-text-interactive-base": props.isActive(),
            "text-text-weak": !props.isActive(),
          }}
        >
          {props.timeLabel()}
        </span>
      </div>
    </A>
  </div>
)

const SessionHoverPreview = (props: {
  mobile?: boolean
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  session: Session
  sidebarHovering: Accessor<boolean>
  hoverReady: Accessor<boolean>
  hoverMessages: Accessor<UserMessage[] | undefined>
  language: ReturnType<typeof useLanguage>
  isActive: Accessor<boolean>
  slug: string
  setHoverSession: (id: string | undefined) => void
  messageLabel: (message: Message) => string | undefined
  onMessageSelect: (message: Message) => void
  trigger: JSX.Element
}): JSX.Element => (
  <HoverCard
    openDelay={1000}
    closeDelay={props.sidebarHovering() ? 600 : 0}
    placement="right-start"
    gutter={16}
    shift={-2}
    trigger={props.trigger}
    mount={!props.mobile ? props.nav() : undefined}
    open={props.hoverSession() === props.session.id}
    onOpenChange={(open) => props.setHoverSession(open ? props.session.id : undefined)}
  >
    <Show
      when={props.hoverReady()}
      fallback={<div class="text-12-regular text-text-weak">{props.language.t("session.messages.loading")}</div>}
    >
      <div class="overflow-y-auto max-h-72 h-full">
        <MessageNav
          messages={props.hoverMessages() ?? []}
          current={undefined}
          getLabel={props.messageLabel}
          onMessageSelect={props.onMessageSelect}
          size="normal"
          class="w-60"
        />
      </div>
    </Show>
  </HoverCard>
)

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const navigate = useNavigate()
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore, setSessionStore] = globalSync.child(props.session.directory)
  const directoryClient = createMemo(() =>
    createOpencodeClient({
      baseUrl: globalSDK.url,
      fetch: globalSDK.fetch,
      directory: props.session.directory,
      throwOnError: true,
    }),
  )
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    const status = sessionStore.session_status[props.session.id]
    return status?.type === "busy" || status?.type === "retry"
  })

  const tint = createMemo(() => {
    const messages = sessionStore.message[props.session.id]
    if (!messages) return undefined
    let user: Message | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== "user") continue
      user = message
      break
    }
    if (!user?.agent) return undefined

    const agent = sessionStore.agent.find((a) => a.name === user.agent)
    return agentColor(user.agent, agent?.color)
  })

  const hoverMessages = createMemo(() =>
    sessionStore.message[props.session.id]?.filter((message): message is UserMessage => message.role === "user"),
  )
  const dirtyCount = createMemo(() => {
    const currentDiffs = sessionStore.session_diff[props.session.id]
    return currentDiffs?.length ?? 0
  })
  const hoverReady = createMemo(() => sessionStore.message[props.session.id] !== undefined)
  const hoverAllowed = createMemo(() => !props.mobile && props.sidebarExpanded())
  const hoverEnabled = createMemo(() => (props.popover ?? true) && hoverAllowed())
  const showActions = createMemo(() => props.popover !== false)
  const isActive = createMemo(() => props.session.id === params.id)
  const isChild = createMemo(() => !!props.child)
  const rowLabel = createMemo(() => props.labelOverride ?? props.session.title)
  const sessionTime = createMemo(() => props.session.time.updated ?? props.session.time.created)
  const timeLabel = createMemo(() =>
    new Date(sessionTime()).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }),
  )

  const hoverPrefetch = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const recentAction = { until: 0 }
  const [menuOpen, setMenuOpen] = createSignal(false)
  const markRecentAction = () => {
    recentAction.until = Date.now() + 900
  }
  const shouldIgnoreActiveClose = () => menuOpen() || Date.now() < recentAction.until
  const cancelHoverPrefetch = () => {
    if (hoverPrefetch.current === undefined) return
    clearTimeout(hoverPrefetch.current)
    hoverPrefetch.current = undefined
  }
  const scheduleHoverPrefetch = () => {
    if (hoverPrefetch.current !== undefined) return
    hoverPrefetch.current = setTimeout(() => {
      hoverPrefetch.current = undefined
      props.prefetchSession(props.session)
    }, 200)
  }

  onCleanup(cancelHoverPrefetch)

  createEffect(() => {
    if (sessionStore.message[props.session.id] === undefined) return
    if (sessionStore.session_diff[props.session.id] !== undefined) return

    const requestKey = `${props.session.directory}:${props.session.id}`
    if (sidebarDirtyInflight.has(requestKey)) return

    const request = directoryClient()
      .session.diff({ sessionID: props.session.id })
      .then((response) => {
        setSessionStore("session_diff", props.session.id, response.data ?? [])
      })
      .catch(() => {})
      .finally(() => {
        sidebarDirtyInflight.delete(requestKey)
      })

    sidebarDirtyInflight.set(requestKey, request)
  })

  const messageLabel = (message: Message) => {
    const parts = sessionStore.part[message.id] ?? []
    const text = parts.find((part): part is TextPart => part?.type === "text" && !part.synthetic && !part.ignored)
    return text?.text
  }
  const item = (
    <SessionRow
      session={props.session}
      label={rowLabel}
      child={isChild}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      setHoverSession={props.setHoverSession}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      prefetchSession={props.prefetchSession}
      scheduleHoverPrefetch={scheduleHoverPrefetch}
      cancelHoverPrefetch={cancelHoverPrefetch}
      timeLabel={timeLabel}
      dirtyCount={dirtyCount}
      showActions={showActions}
      isActive={isActive}
      ignoreClick={shouldIgnoreActiveClose}
      onActiveSelect={() => {
        if (shouldIgnoreActiveClose()) return
        if (props.mobile) {
          layout.mobileSidebar.hide()
          return
        }
        layout.sidebar.close()
      }}
      actionMenu={
        <DropdownMenu
          placement="bottom-start"
          onOpenChange={(open) => {
            setMenuOpen(open)
            markRecentAction()
          }}
        >
          <DropdownMenu.Trigger
            data-session-action
            class="flex items-center justify-center size-6 rounded-md text-icon-base bg-surface-raised-base hover:bg-surface-raised-base-hover data-[expanded]:bg-surface-base-active border border-border-weak-base shadow-xs"
            aria-label={language.t("common.moreOptions")}
            onTouchStart={(event: TouchEvent) => {
              markRecentAction()
              event.preventDefault()
              event.stopPropagation()
            }}
            onPointerDown={(event: PointerEvent) => {
              markRecentAction()
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event: MouseEvent) => {
              markRecentAction()
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <Icon name="dot-grid" size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item
              onSelect={() => {
                void renameSession()
              }}
            >
              <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              onSelect={() => {
                void deleteSession()
              }}
            >
              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      }
    />
  )

  const renameSession = async () => {
    const next = window.prompt(language.t("common.rename"), props.session.title)?.trim()
    if (!next || next === props.session.title) return
    await globalSDK.client.session
      .update({
        directory: props.session.directory,
        sessionID: props.session.id,
        title: next,
      })
      .then(() => {
        setSessionStore(
          "session",
          produce((draft) => {
            const match = Binary.search(draft, props.session.id, (s) => s.id)
            if (!match.found) return
            draft[match.index].title = next
          }),
        )
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: String((err as { message?: string })?.message ?? err),
        })
      })
  }

  const performDelete = async () => {
    await globalSDK.client.session
      .delete({
        directory: props.session.directory,
        sessionID: props.session.id,
      })
      .then(() => {
        setSessionStore(
          "session",
          produce((draft) => {
            const match = Binary.search(draft, props.session.id, (s) => s.id)
            if (!match.found) return
            draft.splice(match.index, 1)
          }),
        )
        if (isActive()) navigate(`/${props.slug}/session`)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: String((err as { message?: string })?.message ?? err),
        })
      })
  }

  const deleteSession = () => {
    dialog.show(() => (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <span class="text-14-regular text-text-strong">
            {language.t("session.delete.confirm", { name: props.session.title })}
          </span>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={async () => {
                dialog.close()
                await performDelete()
              }}
            >
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  return (
    <div
      data-session-id={props.session.id}
      class="group/session relative w-full rounded-md cursor-default transition-colors pl-2 pr-2
             border border-transparent hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover"
      style={
        isActive()
          ? {
              "background-color": "var(--surface-base-interactive-active)",
              "border-color": "var(--border-weak-base)",
            }
          : undefined
      }
    >
      <Show
        when={hoverEnabled()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={rowLabel()} gutter={10}>
            {item}
          </Tooltip>
        }
      >
        <SessionHoverPreview
          mobile={props.mobile}
          nav={props.nav}
          hoverSession={props.hoverSession}
          session={props.session}
          sidebarHovering={props.sidebarHovering}
          hoverReady={hoverReady}
          hoverMessages={hoverMessages}
          language={language}
          isActive={isActive}
          slug={props.slug}
          setHoverSession={props.setHoverSession}
          messageLabel={messageLabel}
          onMessageSelect={(message) => {
            if (!isActive()) {
              layout.pendingMessage.set(`${base64Encode(props.session.directory)}/${props.session.id}`, message.id)
              navigate(`${props.slug}/session/${props.session.id}`)
              return
            }
            window.history.replaceState(null, "", `#message-${message.id}`)
            window.dispatchEvent(new HashChangeEvent("hashchange"))
          }}
          trigger={item}
        />
      </Show>
    </div>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  setHoverSession: (id: string | undefined) => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center justify-between gap-3 min-w-0 text-left w-full focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        props.setHoverSession(undefined)
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="flex items-center gap-1 w-full">
        <div class="shrink-0 size-6 flex items-center justify-center">
          <Icon name="plus-small" size="small" class="text-icon-weak" />
        </div>
        <span class="text-14-regular text-text-strong grow-1 min-w-0 overflow-hidden text-ellipsis truncate">
          {label}
        </span>
      </div>
    </A>
  )

  return (
    <div class="group/session relative w-full rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10}>
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
