import { createStore, produce } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useGlobalSDK } from "./global-sdk"
import { useServer } from "./server"
import { usePlatform } from "./platform"
import { Project } from "@opencode-ai/sdk/v2"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import { normalizeWorkspaceDirectory } from "./global-sync/workspace-adapter"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_PANEL_WIDTH = 344
const DEFAULT_SESSION_WIDTH = 600
const DEFAULT_TERMINAL_HEIGHT = 280
const STATUS_SIDEBAR_ORDER_DEFAULT = ["servers", "monitor", "todo", "skills", "mcp", "llm"] as const
type StatusSidebarKey = (typeof STATUS_SIDEBAR_ORDER_DEFAULT)[number]
const CONTEXT_SIDEBAR_ORDER_DEFAULT = ["summary", "breakdown", "promptTelemetry", "roundTelemetry", "quota"] as const
type ContextSidebarKey = (typeof CONTEXT_SIDEBAR_ORDER_DEFAULT)[number]
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

type SessionTabs = {
  active?: string
  all: string[]
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  pendingMessage?: string
  pendingMessageAt?: number
}

type TabHandoff = {
  dir: string
  id: string
  at: number
}

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }

export type ReviewDiffStyle = "unified" | "split"

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}

export function buildProjectRootMap(input: {
  projects: Array<{ id: string; worktree: string }>
  openProjects: string[]
  resolveProjectID: (directory: string) => string | undefined
}) {
  const map = new Map<string, string>()
  for (const project of input.projects) {
    const root = normalizeWorkspaceDirectory(project.worktree)
    map.set(root, root)
  }
  for (const directory of input.openProjects) {
    const normalized = normalizeWorkspaceDirectory(directory)
    const projectID = input.resolveProjectID(normalized)
    if (!projectID) continue
    const root = input.projects.find((item) => item.id === projectID)?.worktree
    if (!root) continue
    map.set(normalized, normalizeWorkspaceDirectory(root))
  }
  return map
}

export function resolveProjectRoot(directory: string, roots: Map<string, string>) {
  const normalized = normalizeWorkspaceDirectory(directory)
  if (roots.size === 0) return directory

  const visited = new Set<string>()
  const chain = [normalized]

  while (chain.length) {
    const current = chain[chain.length - 1]
    if (!current) return normalized

    const next = roots.get(current)
    if (!next) return current
    if (next === current) return current

    if (visited.has(next)) return normalized
    visited.add(next)
    chain.push(next)
  }

  return normalized
}

export function migrateLayoutState(value: unknown) {
  if (!isRecord(value)) return value

  const sidebar = value.sidebar
  const migratedSidebar = (() => {
    if (!isRecord(sidebar)) return sidebar
    if (typeof sidebar.workspaces !== "boolean") return sidebar
    return {
      ...sidebar,
      workspaces: {},
      workspacesDefault: sidebar.workspaces,
    }
  })()

  const review = value.review
  const fileTree = value.fileTree
  const migratedFileTree = (() => {
    if (!isRecord(fileTree)) return fileTree
    const mode =
      fileTree.mode === "files" ||
      fileTree.mode === "status" ||
      fileTree.mode === "changes" ||
      fileTree.mode === "context"
        ? fileTree.mode
        : fileTree.mode === "monitor" || fileTree.mode === "todo" || fileTree.mode === "accounts"
          ? "status"
          : fileTree.tab === "all"
            ? "files"
            : "changes"
    const width = typeof fileTree.width === "number" ? fileTree.width : DEFAULT_PANEL_WIDTH
    if (fileTree.tab === "changes" || fileTree.tab === "all") {
      return { ...fileTree, opened: false, width, mode }
    }

    return {
      ...fileTree,
      opened: false,
      width: width === 260 ? DEFAULT_PANEL_WIDTH : width,
      tab: "changes",
      mode,
    }
  })()

  const migratedReview = (() => {
    if (!isRecord(review)) return review
    if (typeof review.panelOpened === "boolean") return { ...review, panelOpened: false }
    return {
      ...review,
      panelOpened: false,
    }
  })()

  if (migratedSidebar === sidebar && migratedReview === review && migratedFileTree === fileTree) return value
  return {
    ...value,
    sidebar: migratedSidebar,
    review: migratedReview,
    fileTree: migratedFileTree,
  }
}

function nextSessionTabsForOpen(current: SessionTabs | undefined, tab: string): SessionTabs {
  const all = current?.all ?? []
  if (tab === "review") return { all: all.filter((x) => x !== "review"), active: tab }
  if (tab === "context") return { all: [tab, ...all.filter((x) => x !== tab)], active: tab }
  if (!all.includes(tab)) return { all: [...all, tab], active: tab }
  return { all, active: tab }
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  init: () => {
    const globalSdk = useGlobalSDK()
    const globalSync = useGlobalSync()
    const server = useServer()
    const platform = usePlatform()

    const target = Persist.global("layout", ["layout.v10", "layout.v9", "layout.v8"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate: migrateLayoutState },
      createStore({
        sidebar: {
          opened: false,
          width: DEFAULT_PANEL_WIDTH,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        terminal: {
          height: DEFAULT_TERMINAL_HEIGHT,
          opened: false,
        },
        review: {
          diffStyle: "split" as ReviewDiffStyle,
          panelOpened: false,
        },
        fileTree: {
          opened: false,
          width: DEFAULT_PANEL_WIDTH,
          tab: "changes" as "changes" | "all",
          mode: "changes" as "files" | "status" | "changes" | "context",
        },
        statusSidebar: {
          order: ["servers", "monitor", "todo", "skills", "mcp", "llm"] as Array<
            "monitor" | "todo" | "skills" | "servers" | "mcp" | "llm"
          >,
          expanded: {
            llm: true,
            monitor: true,
            todo: true,
            skills: true,
            servers: true,
            mcp: true,
          } as Record<"monitor" | "todo" | "skills" | "servers" | "mcp" | "llm", boolean>,
        },
        contextSidebar: {
          order: [...CONTEXT_SIDEBAR_ORDER_DEFAULT] as ContextSidebarKey[],
          expanded: {
            summary: true,
            breakdown: true,
            promptTelemetry: true,
            roundTelemetry: true,
            quota: true,
          } as Record<ContextSidebarKey, boolean>,
        },
        session: {
          width: DEFAULT_SESSION_WIDTH,
        },
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
        handoff: {
          tabs: undefined as TabHandoff | undefined,
        },
      }),
    )

    const MAX_SESSION_KEYS = 50
    const PENDING_MESSAGE_TTL_MS = 2 * 60 * 1000
    const usage = {
      active: undefined as string | undefined,
      pruned: false,
      used: new Map<string, number>(),
    }

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const parts = key.split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session ? Persist.session(dir, session, entry.key) : Persist.workspace(dir, entry.key)
          void removePersisted(target, platform)

          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey }, platform)
        }
      }
    }

    function prune(keep?: string) {
      const drop = pruneSessionKeys({
        keep,
        max: MAX_SESSION_KEYS,
        used: usage.used,
        view: Object.keys(store.sessionView),
        tabs: Object.keys(store.sessionTabs),
      })
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        usage.used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      usage.active = sessionKey
      usage.used.set(sessionKey, Date.now())

      if (!ready()) return
      if (usage.pruned) return

      usage.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = usage.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...(prev ?? {}), ...next }))
        prune(keep)
      },
    })

    const ensureKey = (key: string) => ensureSessionKey(key, touch, (sessionKey) => scroll.seed(sessionKey))

    createEffect(() => {
      if (!ready()) return
      if (usage.pruned) return
      const active = usage.active
      if (!active) return
      usage.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      window.addEventListener("pagehide", flush)
      document.addEventListener("visibilitychange", handleVisibility)

      onCleanup(() => {
        window.removeEventListener("pagehide", flush)
        document.removeEventListener("visibilitychange", handleVisibility)
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = new Map<string, AvatarColorKey>()

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const [childStore] = globalSync.child(project.worktree, { bootstrap: false })
      const projectID = childStore.project
      const metadata = projectID
        ? globalSync.data.project.find((x) => x.id === projectID)
        : globalSync.data.project.find((x) => x.worktree === project.worktree)

      const local = childStore.projectMeta
      const localOverride =
        local?.name !== undefined ||
        local?.commands?.start !== undefined ||
        local?.icon?.override !== undefined ||
        local?.icon?.color !== undefined

      const base = {
        ...(metadata ?? {}),
        ...project,
        icon: {
          url: metadata?.icon?.url,
          override: metadata?.icon?.override ?? childStore.icon,
          color: metadata?.icon?.color,
        },
      }

      const isGlobal = projectID === "global" || (metadata?.id === undefined && localOverride)
      if (!isGlobal) return base

      return {
        ...base,
        id: base.id ?? "global",
        name: local?.name,
        commands: local?.commands,
        icon: {
          url: base.icon?.url,
          override: local?.icon?.override,
          color: local?.icon?.color,
        },
      }
    }

    const roots = createMemo(() => {
      return buildProjectRootMap({
        projects: globalSync.data.project,
        openProjects: server.projects.list().map((project) => project.worktree),
        resolveProjectID(directory) {
          const [store] = globalSync.child(directory, { bootstrap: false })
          return store.workspace?.projectId || store.project
        },
      })
    })

    const rootFor = (directory: string) => resolveProjectRoot(directory, roots())

    createEffect(() => {
      const projects = server.projects.list()
      const seen = new Set(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue

          server.projects.close(project.worktree)

          if (!seen.has(root)) {
            server.projects.open(root)
            seen.add(root)
          }

          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    const enriched = createMemo(() => server.projects.list().map(enrich))
    const list = createMemo(() => {
      const projects = enriched()
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return
      if (!globalSync.ready) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        globalSync.project.icon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (project.icon?.color) colorRequested.delete(project.worktree)
      }

      const used = new Set<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) used.add(color)
      }

      for (const project of projects) {
        if (project.icon?.color) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          used.add(color)
          setColors(worktree, color)
        }
        if (!project.id) continue

        const requested = colorRequested.get(worktree)
        if (requested === color) continue
        colorRequested.set(worktree, color)

        if (project.id === "global") {
          globalSync.project.meta(worktree, { icon: { color } })
          continue
        }

        void globalSdk.client.project
          .update({ projectID: project.id, directory: worktree, icon: { color } })
          .catch(() => {
            if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
          })
      }
    })

    onMount(() => {
      Promise.all(
        server.projects.list().map((project) => {
          return globalSync.project.loadSessions(project.worktree)
        }),
      )
    })

    return {
      ready,
      handoff: {
        tabs: createMemo(() => store.handoff?.tabs),
        setTabs(dir: string, id: string) {
          setStore("handoff", "tabs", { dir, id, at: Date.now() })
        },
        clearTabs() {
          if (!store.handoff?.tabs) return
          setStore("handoff", "tabs", undefined)
        },
      },
      projects: {
        list,
        open(directory: string) {
          const root = rootFor(directory)
          if (server.projects.list().find((x) => x.worktree === root)) return
          globalSync.project.loadSessions(root)
          server.projects.open(root)
        },
        close(directory: string) {
          server.projects.close(directory)
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
        },
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle, panelOpened: false })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
      },
      fileTree: {
        opened: createMemo(() => store.fileTree?.opened ?? false),
        width: createMemo(() => store.fileTree?.width ?? DEFAULT_PANEL_WIDTH),
        tab: createMemo(() => store.fileTree?.tab ?? "changes"),
        mode: createMemo(() => store.fileTree?.mode ?? "changes"),
        setTab(tab: "changes" | "all") {
          if (!store.fileTree) {
            setStore("fileTree", {
              opened: true,
              width: DEFAULT_PANEL_WIDTH,
              tab,
              mode: tab === "all" ? "files" : "changes",
            })
            return
          }
          setStore("fileTree", "opened", true)
          setStore("fileTree", "mode", tab === "all" ? "files" : "changes")
          setStore("fileTree", "tab", tab)
        },
        show(mode: "files" | "status" | "changes" | "context") {
          if (!store.fileTree) {
            setStore("fileTree", {
              opened: true,
              width: DEFAULT_PANEL_WIDTH,
              tab: mode === "files" ? "all" : "changes",
              mode,
            })
            return
          }
          setStore("fileTree", "opened", true)
          setStore("fileTree", "mode", mode)
          if (mode === "files") setStore("fileTree", "tab", "all")
          if (mode === "changes") setStore("fileTree", "tab", "changes")
        },
        open() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_PANEL_WIDTH, tab: "changes", mode: "changes" })
            return
          }
          setStore("fileTree", "opened", true)
        },
        close() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: DEFAULT_PANEL_WIDTH, tab: "changes", mode: "changes" })
            return
          }
          setStore("fileTree", "opened", false)
        },
        toggle() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_PANEL_WIDTH, tab: "all", mode: "files" })
            return
          }
          if (!store.fileTree.opened) {
            setStore("fileTree", "opened", true)
            setStore("fileTree", "mode", "files")
            setStore("fileTree", "tab", "all")
            return
          }
          if ((store.fileTree.mode ?? "files") !== "files") {
            setStore("fileTree", "mode", "files")
            setStore("fileTree", "tab", "all")
            return
          }
          setStore("fileTree", "opened", false)
        },
        resize(width: number) {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width, tab: "changes", mode: "changes" })
            return
          }
          setStore("fileTree", "width", width)
        },
      },
      statusSidebar: {
        order: createMemo(() =>
          (
            store.statusSidebar?.order?.filter((key): key is StatusSidebarKey =>
              STATUS_SIDEBAR_ORDER_DEFAULT.includes(key as StatusSidebarKey),
            ) ?? STATUS_SIDEBAR_ORDER_DEFAULT
          ).concat(STATUS_SIDEBAR_ORDER_DEFAULT.filter((key) => !(store.statusSidebar?.order ?? []).includes(key))),
        ),
        setOrder(order: StatusSidebarKey[]) {
          setStore("statusSidebar", "order", order)
        },
        expanded(key: StatusSidebarKey) {
          return () => store.statusSidebar?.expanded?.[key] ?? true
        },
        setExpanded(key: StatusSidebarKey, value: boolean) {
          setStore("statusSidebar", "expanded", key, value)
        },
        toggleExpanded(key: StatusSidebarKey) {
          setStore("statusSidebar", "expanded", key, (value) => !value)
        },
      },
      contextSidebar: {
        order: createMemo(() =>
          (
            store.contextSidebar?.order?.filter((key): key is ContextSidebarKey =>
              CONTEXT_SIDEBAR_ORDER_DEFAULT.includes(key as ContextSidebarKey),
            ) ?? CONTEXT_SIDEBAR_ORDER_DEFAULT
          ).concat(CONTEXT_SIDEBAR_ORDER_DEFAULT.filter((key) => !(store.contextSidebar?.order ?? []).includes(key))),
        ),
        setOrder(order: ContextSidebarKey[]) {
          setStore("contextSidebar", "order", order)
        },
        expanded(key: ContextSidebarKey) {
          return () => store.contextSidebar?.expanded?.[key] ?? true
        },
        setExpanded(key: ContextSidebarKey, value: boolean) {
          setStore("contextSidebar", "expanded", key, value)
        },
        toggleExpanded(key: ContextSidebarKey) {
          setStore("contextSidebar", "expanded", key, (value) => !value)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? DEFAULT_SESSION_WIDTH),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            return
          }
          setStore("session", "width", width)
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = Date.now()
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(usage.active ?? sessionKey)
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (Date.now() - at > PENDING_MESSAGE_TTL_MS) return
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const terminalOpened = createMemo(() => store.terminal?.opened ?? false)
        const filePaneOpened = createMemo(() => store.review?.panelOpened ?? false)

        function setTerminalOpened(next: boolean) {
          const current = store.terminal
          if (!current) {
            setStore("terminal", { height: DEFAULT_TERMINAL_HEIGHT, opened: next })
            return
          }

          const value = current.opened ?? false
          if (value === next) return
          setStore("terminal", "opened", next)
        }

        function setFilePaneOpened(next: boolean) {
          const current = store.review
          if (!current) {
            setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: next })
            return
          }

          const value = current.panelOpened ?? false
          if (value === next) return
          setStore("review", "panelOpened", next)
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          terminal: {
            opened: terminalOpened,
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
          },
          filePane: {
            opened: filePaneOpened,
            open() {
              setFilePaneOpened(true)
            },
            close() {
              setFilePaneOpened(false)
            },
            toggle() {
              setFilePaneOpened(!filePaneOpened())
            },
          },
          reviewPanel: {
            opened: filePaneOpened,
            open() {
              setFilePaneOpened(true)
            },
            close() {
              setFilePaneOpened(false)
            },
            toggle() {
              setFilePaneOpened(!filePaneOpened())
            },
          },
          review: {
            open: createMemo(() => s().reviewOpen),
            setOpen(open: string[]) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: open,
                })
                return
              }

              if (same(current.reviewOpen, open)) return
              setStore("sessionView", session, "reviewOpen", open)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        return {
          tabs,
          active: createMemo(() => tabs().active),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          setActive(tab: string | undefined) {
            const session = key()
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: tab })
            } else {
              setStore("sessionTabs", session, "active", tab)
            }
          },
          setAll(all: string[]) {
            const session = key()
            const next = all.filter((tab) => tab !== "review")
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: next, active: undefined })
            } else {
              setStore("sessionTabs", session, "all", next)
            }
          },
          async open(tab: string) {
            const session = key()
            const next = nextSessionTabsForOpen(store.sessionTabs[session], tab)
            setStore("sessionTabs", session, next)
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return

            if (tab === "review") {
              if (current.active !== tab) return
              setStore("sessionTabs", session, "active", current.all[0])
              return
            }

            const all = current.all.filter((x) => x !== tab)
            if (current.active !== tab) {
              setStore("sessionTabs", session, "all", all)
              return
            }

            const index = current.all.findIndex((f) => f === tab)
            const next = current.all[index - 1] ?? current.all[index + 1] ?? all[0]
            batch(() => {
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", next)
            })
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})
