import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import { childMapByParent, sortedRootSessions } from "./helpers"
import { Persist, persisted } from "@/utils/persist"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  nav: Accessor<HTMLElement | undefined>
  hoverSession: Accessor<string | undefined>
  setHoverSession: (id: string | undefined) => void
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
}

type ClaudeNativeSession = {
  sourceSessionID: string
  transcriptPath: string
  title: string
  time: { created: number; updated: number }
  importedSessionID?: string
  currentLineCount: number
  importedLineCount?: number
  hasNewContent: boolean
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const [workspaceStore] = globalSync.child(directory, { bootstrap: false })
    const kind =
      directory === project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.workspaceLabel(directory, workspaceStore.vcs?.branch, project.id)
    return `${kind} : ${name}`
  })

  return (
    <Show when={label()}>
      {(value) => <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">{value()}</div>}
    </Show>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <span class="text-14-medium text-text-base shrink-0">
      {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")} :
    </span>
    <Show
      when={!props.local()}
      fallback={
        <span class="text-14-medium text-text-base min-w-0 truncate">
          {props.branch() ?? getFilename(props.directory)}
        </span>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-14-medium text-text-base min-w-0 truncate"
        displayClass="text-14-medium text-text-base min-w-0 truncate"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  sidebarHovering: Accessor<boolean>
  mobile?: boolean
  nav: Accessor<HTMLElement | undefined>
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  setHoverSession: WorkspaceSidebarContext["setHoverSession"]
  clearHoverProjectSoon: WorkspaceSidebarContext["clearHoverProjectSoon"]
  navigateToNewSession: () => void
}): JSX.Element => (
  <div
    class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
    classList={{
      "opacity-100 pointer-events-auto": props.menuOpen(),
      "opacity-0 pointer-events-none": !props.menuOpen(),
      "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
      "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
    }}
  >
    <DropdownMenu
      modal={!props.sidebarHovering()}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal mount={!props.mobile ? props.nav() : undefined}>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            if (!props.pendingRename()) return
            event.preventDefault()
            props.setPendingRename(false)
            props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
          }}
        >
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              props.setPendingRename(true)
              props.setMenuOpen(false)
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButton
          icon="plus-small"
          variant="ghost"
          class="size-6 rounded-md opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto"
          data-action="workspace-new-session"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("command.session.new")}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.setHoverSession(undefined)
            props.clearHoverProjectSoon()
            props.navigateToNewSession()
          }}
        />
      </Tooltip>
    </Show>
  </div>
)

const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  directory: string
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  projectLabel?: Accessor<string>
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<Session[]>
  allSessions: Accessor<Session[]>
  children: Accessor<Map<string, string[]>>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  // Persisted state for date group collapsing
  const [dateGroupExpanded, setDateGroupExpanded] = persisted(
    Persist.global("sidebar.dateGroups.expanded"),
    createStore<Record<string, boolean>>({}),
  )

  // Persisted state for session children collapsing
  const [sessionExpanded, setSessionExpanded] = persisted(
    Persist.global("sidebar.sessions.expanded"),
    createStore<Record<string, boolean>>({}),
  )

  // Management mode toggle
  const [managementMode, setManagementMode] = createSignal(false)
  const [sessionTab, setSessionTab] = persisted(
    Persist.global("sidebar.sessionList.tab"),
    createStore({ value: "opencode" as "opencode" | "claude" }),
  )
  const [refreshVersion, setRefreshVersion] = createSignal(0)
  const [importingSource, setImportingSource] = createSignal<string | undefined>()
  const [importError, setImportError] = createSignal<string | undefined>()
  const [claudeSessions] = createResource(
    () => ({ directory: props.directory, refresh: refreshVersion() }),
    async ({ directory }) => {
      const url = new URL("/api/v2/session/import/claude", globalSDK.url)
      url.searchParams.set("directory", directory)
      const response = await globalSDK.fetch(url)
      if (!response.ok) throw new Error(`Failed to load Claude sessions (${response.status})`)
      return (await response.json()) as ClaudeNativeSession[]
    },
  )
  const activeSessions = createMemo(() => (sessionTab.value === "claude" ? [] : props.sessions()))
  const activeAllSessions = createMemo(() => (sessionTab.value === "claude" ? [] : props.allSessions()))
  const activeChildren = createMemo(() =>
    sessionTab.value === "claude" ? new Map<string, string[]>() : props.children(),
  )
  const activeLoading = createMemo(() => (sessionTab.value === "claude" ? claudeSessions.loading : props.loading()))
  const activeHasMore = createMemo(() => (sessionTab.value === "claude" ? false : props.hasMore()))

  const openClaudeSession = async (row: ClaudeNativeSession) => {
    setImportError(undefined)
    setImportingSource(row.sourceSessionID)
    try {
      const response = await globalSDK.fetch(new URL("/api/v2/session/import/claude", globalSDK.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: props.directory,
          sourceSessionID: row.sourceSessionID,
          transcriptPath: row.transcriptPath,
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => undefined)
        throw new Error(body?.message ?? `Failed to import Claude session (${response.status})`)
      }
      const body = (await response.json()) as { sessionID: string }
      navigate(`/${props.slug()}/session/${body.sessionID}`)
      setRefreshVersion((value) => value + 1)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    } finally {
      setImportingSource(undefined)
    }
  }

  const sessionGroups = createMemo(() => {
    const sessions = activeSessions()
    const byID = new Map(activeAllSessions().map((session) => [session.id, session]))
    const now = new Date()
    const today = now.toDateString()
    const groups: { key: string; label: string; rows: { session: Session; label: string; child: boolean }[] }[] = []
    for (const root of sessions) {
      const rootDate = new Date(root.time.updated ?? root.time.created)
      const key = rootDate.toDateString()
      const label =
        key === today
          ? "Today"
          : rootDate
              .toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
              })
              .replace(/,/g, "")
      const children = (activeChildren().get(root.id) ?? [])
        .map((id) => byID.get(id))
        .filter((session): session is Session => !!session)
        .sort((a, b) => (a.time.created ?? 0) - (b.time.created ?? 0))
      const rootLabel = `${root.title}${children.length > 0 ? ` [${children.length}]` : ""}`
      const rows: { session: Session; label: string; child: boolean }[] = [
        { session: root, label: rootLabel, child: false },
      ]
      for (let index = 0; index < children.length; index++) {
        const child = children[index]
        const prefix = index === children.length - 1 ? "└─ " : "├─ "
        rows.push({ session: child, label: `${prefix}${child.title}`, child: true })
      }
      const prev = groups[groups.length - 1]
      if (prev && prev.key === key) {
        prev.rows.push(...rows)
        continue
      }
      groups.push({ key, label, rows })
    }
    return groups
  })

  const toggleDateGroup = (key: string) => {
    const currentValue = dateGroupExpanded[key] ?? true
    setDateGroupExpanded(key, !currentValue)
  }

  const toggleSessionChildren = (sessionId: string) => {
    const currentValue = sessionExpanded[sessionId] ?? true
    if (typeof localStorage !== "undefined" && localStorage.getItem("opencode:debug:sidebar") === "1")
      console.log("[toggleSessionChildren]", sessionId, "current:", currentValue, "new:", !currentValue)
    setSessionExpanded(sessionId, !currentValue)
  }

  const isDateGroupExpanded = (key: string) => {
    // Default to expanded (true) if not set
    return dateGroupExpanded[key] ?? true
  }

  const isSessionExpanded = (sessionId: string) => {
    // Default to expanded (true) if not set
    return sessionExpanded[sessionId] ?? true
  }

  return (
    <nav class="flex flex-col gap-1 px-2">
      <div class="flex items-center justify-end gap-2 px-2 pt-1 pb-2">
        <Show when={props.showNew() && sessionTab.value === "opencode"}>
          <div class="flex-1 min-w-0">
            <NewSessionItem
              slug={props.slug()}
              mobile={props.mobile}
              sidebarExpanded={props.ctx.sidebarExpanded}
              clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
              setHoverSession={props.ctx.setHoverSession}
            />
          </div>
        </Show>
        <div class="shrink-0">
          <Tooltip value={props.language.t("common.edit")} placement="top">
            <div classList={{ "rounded-md bg-surface-interactive-base": managementMode() }}>
              <IconButton
                icon="pencil-line"
                variant="ghost"
                size="small"
                onClick={() => {
                  if (typeof localStorage !== "undefined" && localStorage.getItem("opencode:debug:sidebar") === "1")
                    console.log("[Edit button clicked]", managementMode())
                  setManagementMode(!managementMode())
                }}
              />
            </div>
          </Tooltip>
        </div>
      </div>
      <div class="px-2 pb-2 flex items-center gap-1">
        <button
          type="button"
          class="rounded-md px-2 py-1 text-12-medium transition-colors"
          classList={{
            "bg-surface-interactive-base text-text-strong": sessionTab.value === "opencode",
            "text-text-weak hover:text-text-base": sessionTab.value !== "opencode",
          }}
          onClick={() => setSessionTab("value", "opencode")}
        >
          OpenCode
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-12-medium transition-colors"
          classList={{
            "bg-surface-interactive-base text-text-strong": sessionTab.value === "claude",
            "text-text-weak hover:text-text-base": sessionTab.value !== "claude",
          }}
          onClick={() => setSessionTab("value", "claude")}
        >
          Claude
        </button>
        <Show when={sessionTab.value === "claude"}>
          <button
            type="button"
            class="ml-auto rounded-md px-2 py-1 text-12-medium text-text-weak hover:text-text-base"
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            Refresh
          </button>
        </Show>
      </div>
      <Show when={activeLoading()}>
        <SessionSkeleton />
      </Show>
      <Show when={sessionTab.value === "claude" && claudeSessions.error}>
        <div class="px-4 py-2 text-12-regular text-warning">
          {claudeSessions.error instanceof Error ? claudeSessions.error.message : "Failed to load Claude sessions"}
        </div>
      </Show>
      <Show when={sessionTab.value === "claude" && importError()}>
        <div class="px-4 py-2 text-12-regular text-warning">{importError()}</div>
      </Show>
      <Show
        when={
          !activeLoading() &&
          (sessionTab.value === "claude" ? (claudeSessions() ?? []).length === 0 : sessionGroups().length === 0)
        }
      >
        <div class="px-4 py-2 text-12-regular text-text-weak">
          {sessionTab.value === "claude" ? "No Claude sessions in this project." : "No sessions yet."}
        </div>
      </Show>
      <Show when={sessionTab.value === "claude"}>
        <For each={claudeSessions() ?? []}>
          {(row) => (
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-4 py-2 text-left text-13-regular text-text-base hover:bg-surface-interactive-base disabled:opacity-60"
              disabled={!!importingSource()}
              aria-label={`Open Claude session ${row.title}`}
              onClick={() => openClaudeSession(row)}
            >
              <Icon name="code" size="small" class="shrink-0 text-text-weak" />
              <span
                class="size-2 rounded-full bg-green-500 shrink-0"
                classList={{ invisible: !row.hasNewContent }}
                title="New content since last import"
              />
              <span class="min-w-0 flex-1 truncate">{row.title}</span>
              <Show when={importingSource() === row.sourceSessionID}>
                <Spinner class="size-[13px] shrink-0 text-text-weak" />
              </Show>
            </button>
          )}
        </For>
      </Show>
      <For each={sessionTab.value === "claude" ? [] : sessionGroups()}>
        {(group) => {
          const expanded = () => isDateGroupExpanded(group.key)
          return (
            <div class="flex flex-col gap-0.5">
              <button
                type="button"
                class="flex items-center gap-1 pl-1 pr-2 pt-2 pb-1 text-12-medium tracking-wide text-text-weak uppercase hover:text-text-base transition-colors cursor-pointer"
                onClick={() => toggleDateGroup(group.key)}
              >
                <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" class="shrink-0" />
                <span>{group.label}</span>
              </button>
              <Show when={expanded()}>
                <For each={group.rows}>
                  {(row, index) => {
                    // Check if this is a main session (not a child)
                    if (row.child) {
                      // This is a child session - find its parent
                      // Look backwards to find the parent session
                      let parentId: string | undefined
                      for (let i = index() - 1; i >= 0; i--) {
                        const potentialParent = group.rows[i]
                        if (!potentialParent.child) {
                          parentId = potentialParent.session.id
                          break
                        }
                      }

                      // Only show if parent is expanded
                      const parentExpanded = () => (parentId ? isSessionExpanded(parentId) : true)

                      return (
                        <Show when={parentExpanded()}>
                          <div class="pl-6">
                            <SessionItem
                              session={row.session}
                              labelOverride={row.label}
                              child={row.child}
                              slug={props.slug()}
                              mobile={props.mobile}
                              dense
                              popover={managementMode()}
                              children={activeChildren()}
                              sidebarExpanded={props.ctx.sidebarExpanded}
                              sidebarHovering={props.ctx.sidebarHovering}
                              nav={props.ctx.nav}
                              hoverSession={props.ctx.hoverSession}
                              setHoverSession={props.ctx.setHoverSession}
                              clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                              prefetchSession={props.ctx.prefetchSession}
                            />
                          </div>
                        </Show>
                      )
                    }

                    // This is a main session
                    const hasChildren = (activeChildren().get(row.session.id)?.length ?? 0) > 0
                    const childrenExpanded = () => isSessionExpanded(row.session.id)

                    return (
                      <div class="flex items-center gap-0">
                        <Show when={hasChildren}>
                          <button
                            type="button"
                            class="shrink-0 flex items-center justify-center w-5 h-8 text-text-weak hover:text-text-base transition-colors cursor-pointer"
                            aria-label={childrenExpanded() ? "Collapse" : "Expand"}
                            onClick={(e: MouseEvent) => {
                              if (
                                typeof localStorage !== "undefined" &&
                                localStorage.getItem("opencode:debug:sidebar") === "1"
                              )
                                console.log("[Chevron clicked]", row.session.id, row.session.title)
                              e.preventDefault()
                              e.stopPropagation()
                              toggleSessionChildren(row.session.id)
                            }}
                          >
                            <Icon name={childrenExpanded() ? "chevron-down" : "chevron-right"} size="small" />
                          </button>
                        </Show>
                        <div
                          class="flex-1 min-w-0"
                          classList={{
                            "pl-5": !hasChildren,
                          }}
                        >
                          <SessionItem
                            session={row.session}
                            labelOverride={row.session.title}
                            child={row.child}
                            slug={props.slug()}
                            mobile={props.mobile}
                            dense
                            popover={managementMode()}
                            children={activeChildren()}
                            sidebarExpanded={props.ctx.sidebarExpanded}
                            sidebarHovering={props.ctx.sidebarHovering}
                            nav={props.ctx.nav}
                            hoverSession={props.ctx.hoverSession}
                            setHoverSession={props.ctx.setHoverSession}
                            clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                            prefetchSession={props.ctx.prefetchSession}
                          />
                        </div>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </div>
          )
        }}
      </For>
      <Show when={activeHasMore()}>
        <div class="relative w-full py-1">
          <Button
            variant="ghost"
            class="flex w-full text-left justify-start text-14-regular text-text-weak pl-9 pr-10"
            size="large"
            onClick={(e: MouseEvent) => {
              props.loadMore()
              ;(e.currentTarget as HTMLButtonElement).blur()
            }}
          >
            {props.language.t("common.loadMore")}
          </Button>
        </div>
      </Show>
    </nav>
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const params = useParams()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const sortable = createSortable(props.directory)
  const [workspaceStore, setWorkspaceStore] = globalSync.child(props.directory, { bootstrap: false })
  const [menu, setMenu] = createStore({
    open: false,
    pendingRename: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const sessions = createMemo(() => sortedRootSessions(workspaceStore, props.sortNow()))
  const children = createMemo(() => childMapByParent(workspaceStore.session))
  const local = createMemo(() => props.directory === props.project.worktree)
  const active = createMemo(() => props.ctx.currentDir() === props.directory)
  const workspaceValue = createMemo(() => {
    const branch = workspaceStore.vcs?.branch
    const name = branch ?? getFilename(props.directory)
    return props.ctx.workspaceName(props.directory, props.project.id, branch) ?? name
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const boot = createMemo(() => open() || active())
  const booted = createMemo((prev) => prev || workspaceStore.status === "complete", false)
  const hasMore = createMemo(() => workspaceStore.sessionTotal > sessions().length)
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const wasBusy = createMemo((prev) => prev || busy(), false)
  const loading = createMemo(() => open() && !booted() && sessions().length === 0 && !wasBusy())
  const touch = createMediaQuery("(hover: none)")
  const showNew = createMemo(() => !loading() && (touch() || sessions().length === 0 || (active() && !params.id)))
  const loadMore = async () => {
    setWorkspaceStore("limit", (limit) => (limit ?? 0) + 25)
    await globalSync.project.loadSessions(props.directory)
  }

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
    if (value) return
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  createEffect(() => {
    if (!boot()) return
    globalSync.child(props.directory, { bootstrap: true })
  })

  return (
    <div
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        <div class="px-2 py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={base64Encode(props.directory)}
          >
            <div class="flex items-center gap-1">
              <Show
                when={workspaceEditActive()}
                fallback={
                  <Collapsible.Trigger
                    class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover transition-[padding] duration-200 ${
                      menu.open ? "pr-16" : "pr-2"
                    } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                    data-action="workspace-toggle"
                    data-workspace={base64Encode(props.directory)}
                  >
                    <WorkspaceHeader
                      local={local}
                      busy={busy}
                      open={open}
                      directory={props.directory}
                      language={language}
                      branch={() => workspaceStore.vcs?.branch}
                      workspaceValue={workspaceValue}
                      workspaceEditActive={workspaceEditActive}
                      InlineEditor={props.ctx.InlineEditor}
                      renameWorkspace={props.ctx.renameWorkspace}
                      setEditor={props.ctx.setEditor}
                      projectId={props.project.id}
                    />
                  </Collapsible.Trigger>
                }
              >
                <div
                  class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md transition-[padding] duration-200 ${
                    menu.open ? "pr-16" : "pr-2"
                  } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                >
                  <WorkspaceHeader
                    local={local}
                    busy={busy}
                    open={open}
                    directory={props.directory}
                    language={language}
                    branch={() => workspaceStore.vcs?.branch}
                    workspaceValue={workspaceValue}
                    workspaceEditActive={workspaceEditActive}
                    InlineEditor={props.ctx.InlineEditor}
                    renameWorkspace={props.ctx.renameWorkspace}
                    setEditor={props.ctx.setEditor}
                    projectId={props.project.id}
                  />
                </div>
              </Show>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menu.open}
                pendingRename={() => menu.pendingRename}
                setMenuOpen={(open) => setMenu("open", open)}
                setPendingRename={(value) => setMenu("pendingRename", value)}
                sidebarHovering={props.ctx.sidebarHovering}
                mobile={props.mobile}
                nav={props.ctx.nav}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                openEditor={props.ctx.openEditor}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                setHoverSession={props.ctx.setHoverSession}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                navigateToNewSession={() => navigate(`/${slug()}/session`)}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content>
          <WorkspaceSessionList
            slug={slug}
            directory={props.directory}
            mobile={props.mobile}
            ctx={props.ctx}
            projectLabel={() =>
              props.ctx.workspaceName(props.directory, props.project.id, workspaceStore.vcs?.branch) ??
              getFilename(props.directory)
            }
            showNew={showNew}
            loading={loading}
            sessions={sessions}
            allSessions={() => workspaceStore.session}
            children={children}
            hasMore={hasMore}
            loadMore={loadMore}
            language={language}
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const workspace = createMemo(() => {
    const [store, setStore] = globalSync.child(props.project.worktree)
    return { store, setStore }
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => sortedRootSessions(workspace().store, props.sortNow()))
  const children = createMemo(() => childMapByParent(workspace().store.session))
  const booted = createMemo((prev) => prev || workspace().store.status === "complete", false)
  const loading = createMemo(() => !booted() && sessions().length === 0)
  const hasMore = createMemo(() => workspace().store.sessionTotal > sessions().length)
  const loadMore = async () => {
    workspace().setStore("limit", (limit) => (limit ?? 0) + 25)
    await globalSync.project.loadSessions(props.project.worktree)
  }

  return (
    <div
      ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
      class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
    >
      <WorkspaceSessionList
        slug={slug}
        directory={props.project.worktree}
        mobile={props.mobile}
        ctx={props.ctx}
        projectLabel={() => props.project.name || getFilename(props.project.worktree)}
        showNew={() => false}
        loading={loading}
        sessions={sessions}
        allSessions={() => workspace().store.session}
        children={children}
        hasMore={hasMore}
        loadMore={loadMore}
        language={language}
      />
    </div>
  )
}
