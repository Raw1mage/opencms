import {
  type Config,
  type Path,
  type Project,
  type ProviderAuthResponse,
  type ProviderListResponse,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { createStore, produce, reconcile } from "solid-js/store"
import { useGlobalSDK } from "./global-sdk"
import type { InitError } from "../pages/error"
import {
  createContext,
  createEffect,
  untrack,
  getOwner,
  useContext,
  onCleanup,
  onMount,
  type ParentProps,
  Switch,
  Match,
} from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import { usePlatform } from "./platform"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { createRefreshQueue } from "./global-sync/queue"
import { createChildStoreManager } from "./global-sync/child-store"
import { trimSessions } from "./global-sync/session-trim"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { LLM_HISTORY_CAP, type LlmHistoryEntry } from "./global-sync/types"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  refreshGlobalSlices,
  type GlobalRefreshSlice,
} from "./global-sync/bootstrap"
import { sanitizeProject } from "./global-sync/utils"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  account_families: Record<string, { accounts: Record<string, any>; activeAccount?: string }>
  config: Config
  reload: undefined | "pending" | "complete"
}

function normalizeDirectoryKey(value: string) {
  if (!value || value === "global") return "global"
  const normalized = value.replaceAll("\\", "/")
  if (normalized === "/") return normalized
  return normalized.replace(/\/+$/, "")
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string"))]
}

function sameStringSet(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false
  const right = new Set(b)
  return a.every((item) => right.has(item))
}

type GlobalRefreshScope = Partial<Record<GlobalRefreshSlice, true>>

function scopeSlices(scope: GlobalRefreshScope): GlobalRefreshSlice[] {
  return (Object.keys(scope) as GlobalRefreshSlice[]).filter((key) => scope[key])
}

function inferConfigRefreshScope(config: Config): GlobalRefreshScope | "full" {
  const keys = Object.keys(config) as Array<keyof Config>
  if (keys.length === 0) return { config: true }

  const scope: GlobalRefreshScope = {}
  for (const key of keys) {
    if (key === "disabled_providers") {
      scope.config = true
      scope.provider = true
      continue
    }
    if (key === "permission") {
      scope.config = true
      continue
    }
    if (key === "provider") {
      scope.config = true
      scope.provider = true
      scope.provider_auth = true
      continue
    }
    return "full"
  }
  return scope
}

export function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof (error as any).message === "string" && (error as any).message)
      return (error as any).message
    if ("error" in error && typeof (error as any).error === "string" && (error as any).error)
      return (error as any).error
    try {
      return JSON.stringify(error)
    } catch {
      return "Unknown error"
    }
  }
  return "Unknown error"
}
function setDevStats(value: {
  activeDirectoryStores: number
  evictions: number
  loadSessionsFullFetchFallback: number
}) {
  ;(globalThis as { __OPENCODE_GLOBAL_SYNC_STATS?: typeof value }).__OPENCODE_GLOBAL_SYNC_STATS = value
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const stats = {
    evictions: 0,
    loadSessionsFallback: 0,
  }

  const sdkCache = new Map<string, ReturnType<typeof createOpencodeClient>>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const [projectCache, setProjectCache, , projectCacheReady] = persisted(
    Persist.global("globalSync.project", ["globalSync.project.v1"]),
    createStore({ value: [] as Project[] }),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: projectCache.value,
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
    account_families: {},
    config: {},
    reload: undefined,
  })
  const [configOverlay, setConfigOverlay] = createStore<{ disabled_providers?: string[] }>({})
  let disabledProvidersMutationVersion = 0
  let pendingGlobalDisposedScope: GlobalRefreshScope | undefined
  let pendingGlobalDisposedUntil = 0

  const updateStats = (activeDirectoryStores: number) => {
    if (!import.meta.env.DEV) return
    setDevStats({
      activeDirectoryStores,
      evictions: stats.evictions,
      loadSessionsFullFetchFallback: stats.loadSessionsFallback,
    })
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    bootstrap,
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    markStats: updateStats,
    incrementEvictions: () => {
      stats.evictions += 1
      updateStats(Object.keys(children.children).length)
    },
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      queue.clear(directory)
      sessionMeta.delete(directory)
      sdkCache.delete(directory)
    },
  })

  const sdkFor = (directory: string) => {
    const cached = sdkCache.get(directory)
    if (cached) return cached

    // Wrap fetch to intercept X-Opencode-Resolved-Directory from server.
    // When server falls back (e.g., stale directory → process.cwd()),
    // it sets this header. We detect the mismatch and auto-heal by replacing
    // the stale project entry so the client never needs manual localStorage clearing.
    const healedDirs = new Set<string>()
    const interceptedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const baseFetch = globalSDK.fetch ?? globalThis.fetch
        const response = await baseFetch(input, init)
        const resolved = response.headers.get("x-opencode-resolved-directory")
        if (resolved && resolved !== directory && !healedDirs.has(resolved)) {
          healedDirs.add(resolved)
          console.warn(`[global-sync] Directory healed: ${directory} → ${resolved}`)
          // Replace the stale project in the global store using the resolved path
          setGlobalStore("project", (prev: Project[]) =>
            prev.map((p) =>
              p.worktree === directory || p.id === directory ? { ...p, worktree: resolved, id: resolved } : p,
            ),
          )
          // Re-key the sdk cache under the resolved directory
          sdkCache.delete(directory)
          sdkCache.set(resolved, newSdk)
        }
        return response
      },
      {
        preconnect: (globalThis.fetch as unknown as { preconnect?: (...args: unknown[]) => unknown }).preconnect,
      },
    ) as typeof fetch
    const newSdk = createOpencodeClient({
      baseUrl: globalSDK.url,
      fetch: interceptedFetch,
      directory,
      throwOnError: true,
    })
    sdkCache.set(directory, newSdk)
    return newSdk
  }

  createEffect(() => {
    if (!projectCacheReady()) return
    if (globalStore.project.length !== 0) return
    const cached = projectCache.value
    if (cached.length === 0) return
    setGlobalStore("project", cached)
  })

  createEffect(() => {
    if (!projectCacheReady()) return
    const projects = globalStore.project
    if (projects.length === 0) {
      const cachedLength = untrack(() => projectCache.value.length)
      if (cachedLength !== 0) return
    }
    setProjectCache("value", projects.map(sanitizeProject))
  })

  createEffect(() => {
    if (globalStore.reload !== "complete") return
    setGlobalStore("reload", undefined)
    queue.refresh()
  })

  const configuredDisabledProviders = () => normalizeStringList(globalStore.config.disabled_providers)
  const effectiveDisabledProviders = () => configOverlay.disabled_providers ?? configuredDisabledProviders()

  createEffect(() => {
    const optimistic = configOverlay.disabled_providers
    if (!optimistic) return
    if (!sameStringSet(optimistic, configuredDisabledProviders())) return
    setConfigOverlay("disabled_providers", undefined)
  })

  const beginDisabledProvidersMutation = (next: string[]) => {
    const version = ++disabledProvidersMutationVersion
    const previous = configOverlay.disabled_providers
    setConfigOverlay("disabled_providers", normalizeStringList(next))
    return { version, previous }
  }

  const rollbackDisabledProvidersMutation = (state: { version: number; previous?: string[] }) => {
    if (state.version !== disabledProvidersMutationVersion) return
    setConfigOverlay("disabled_providers", state.previous)
  }

  async function loadSessions(directory: string) {
    const pending = sessionLoads.get(directory)
    if (pending) return pending

    children.pin(directory)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(directory)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, { limit: store.limit, permission: store.permission })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(directory)
      return
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = loadRootSessionsWithFallback({
      directory,
      limit,
      list: (query) => globalSDK.client.session.list(query),
      onFallback: () => {
        stats.loadSessionsFallback += 1
        updateStats(Object.keys(children.children).length)
      },
    })
      .then((x) => {
        const nonArchived = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const limit = store.limit
        // Server now returns both roots and children; no need to manually
        // preserve in-memory child sessions — trimSessions handles both.
        const sessions = trimSessions(nonArchived, { limit, permission: store.permission })
        const rootCount = nonArchived.filter((s) => !s.parentID).length
        setStore("sessionTotal", estimateRootSessionTotal({ count: rootCount, limit: x.limit, limited: x.limited }))
        setStore("session", reconcile(sessions, { key: "id" }))
        sessionMeta.set(directory, { limit })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        const project = getFilename(directory)
        showToast({
          variant: "error",
          title: language.t("toast.session.listFailed.title", { project }),
          description: formatServerError(err),
        })
      })

    sessionLoads.set(directory, promise)
    promise.finally(() => {
      sessionLoads.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    children.pin(directory)
    const promise = (async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(directory)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        sdk,
        fetch: globalSDK.fetch,
        baseUrl: globalSDK.url,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
      })
    })()

    booting.set(directory, promise)
    promise.finally(() => {
      booting.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = normalizeDirectoryKey(e.name)
    const event = e.details

    if (event?.type === "tui.toast.show") {
      const { message, variant, title, duration } = (event.properties || {}) as any
      if (!message) return
      showToast({
        title,
        description: message,
        variant,
        duration,
      })
      // Capture rotation/ratelimit toasts into LLM status card history.
      // Toast is the only event guaranteed to bypass directory routing,
      // so we piggyback structured history onto it.
      if (typeof message === "string" && message.includes("->")) {
        const lines = message
          .split("\n")
          .map((l: string) => l.trim())
          .filter(Boolean)
        // lines[0] = "(reason)detail", lines[1] = "from->", lines[2] = "to"
        if (lines.length >= 2) {
          const reason = lines[0] ?? ""
          // Find the line with "->" and extract from/to
          const arrowIdx = lines.findIndex((l: string) => l.includes("->"))
          if (arrowIdx !== -1) {
            const fromPart = lines[arrowIdx]!.replace("->", "").trim()
            const toPart = lines[arrowIdx + 1]?.trim() ?? fromPart
            const [fromProvider, fromModel, fromAccount] = fromPart.split(",")
            const [toProvider, toModel, toAccount] = toPart.split(",")
            // Find child store for this directory and push history
            const resolved =
              children.children[directory] ??
              children.children[
                Object.keys(children.children).find((k) => normalizeDirectoryKey(k) === directory) ?? ""
              ]
            if (resolved) {
              const [, setStore] = resolved
              const entry: LlmHistoryEntry = {
                providerId: fromProvider ?? "",
                modelId: fromModel ?? "",
                accountId: fromAccount,
                timestamp: Date.now(),
                state: "rotated",
                message: reason,
                toProviderId: toProvider,
                toModelId: toModel,
                toAccountId: toAccount,
              }
              setStore(
                produce((draft) => {
                  if (!draft.llm_history) draft.llm_history = []
                  draft.llm_history.push(entry)
                  if (draft.llm_history.length > LLM_HISTORY_CAP) {
                    draft.llm_history = draft.llm_history.slice(-LLM_HISTORY_CAP)
                  }
                }),
              )
            }
          }
        }
      }
      return
    }

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: queue.refresh,
        onDisposed: handlePendingGlobalDisposed,
        setGlobalProject(next) {
          if (typeof next === "function") {
            setGlobalStore("project", produce(next))
            return
          }
          setGlobalStore("project", next)
        },
      })
      return
    }

    // Directory-matched dispatch: deliver only to the matching child store.
    // Falls back to broadcast if no exact match (normalization edge cases).
    const matched = children.children[directory]
    if (matched) {
      children.mark(directory)
      const [store, setStore] = matched
      applyDirectoryEvent({
        event,
        directory,
        store,
        setStore,
        push: queue.push,
        vcsCache: children.vcsCache.get(directory),
        loadLsp: () => {
          sdkFor(directory)
            .lsp.status()
            .then((x) => setStore("lsp", x.data ?? []))
        },
        loadMcp: () => {
          sdkFor(directory)
            .mcp.status()
            .then((x) => {
              if (x.data) setStore("mcp", reconcile(x.data))
            })
        },
      })
    } else {
      // Fallback broadcast: normalization mismatch between SSE directory
      // and child store key (symlinks, trailing slashes, encoding).
      for (const [dir, child] of Object.entries(children.children)) {
        children.mark(dir)
        const [store, setStore] = child
        applyDirectoryEvent({
          event,
          directory: dir,
          store,
          setStore,
          push: queue.push,
          vcsCache: children.vcsCache.get(dir),
          loadLsp: () => {
            sdkFor(dir)
              .lsp.status()
              .then((x) => setStore("lsp", x.data ?? []))
          },
          loadMcp: () => {
            sdkFor(dir)
              .mcp.status()
              .then((x) => {
                if (x.data) setStore("mcp", reconcile(x.data))
              })
          },
        })
      }
    }
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directory)
    }
  })

  async function bootstrap() {
    await bootstrapGlobal({
      globalSDK: globalSDK.client,
      connectErrorTitle: language.t("dialog.server.add.error"),
      connectErrorDescription: language.t("error.globalSync.connectFailed", { url: globalSDK.url }),
      requestFailedTitle: language.t("common.requestFailed"),
      setGlobalStore,
    })
  }

  const refreshGlobal = async (scope: GlobalRefreshScope) => {
    const slices = scopeSlices(scope)
    if (slices.length === 0) return
    await refreshGlobalSlices({
      globalSDK: globalSDK.client,
      requestFailedTitle: language.t("common.requestFailed"),
      setGlobalStore,
      slices,
    })
  }

  const handlePendingGlobalDisposed = () => {
    const scope = pendingGlobalDisposedScope
    if (!scope) return false
    if (Date.now() > pendingGlobalDisposedUntil) {
      pendingGlobalDisposedScope = undefined
      pendingGlobalDisposedUntil = 0
      return false
    }
    pendingGlobalDisposedScope = undefined
    pendingGlobalDisposedUntil = 0
    void refreshGlobal(scope)
    return true
  }

  let hiddenAt = 0

  const refreshVisibleState = async (reason: "resume" | "pageshow" | "online") => {
    if (reason === "online") {
      await bootstrap().catch(() => {})
      queue.refresh()
      return
    }

    if (reason === "pageshow") {
      queue.refresh()
      await Promise.all(Object.keys(children.children).map((directory) => bootstrapInstance(directory).catch(() => {})))
      return
    }

    if (hiddenAt !== 0 && Date.now() - hiddenAt < 1500) {
      queue.refresh()
      return
    }

    queue.refresh()
    await Promise.all(Object.keys(children.children).map((directory) => bootstrapInstance(directory).catch(() => {})))
  }

  onMount(() => {
    void bootstrap()

    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      void refreshVisibleState("resume")
    }
    const onPageShow = () => {
      void refreshVisibleState("pageshow")
    }
    const onOnline = () => {
      void refreshVisibleState("online")
    }

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
    window.addEventListener("online", onOnline)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
      window.removeEventListener("online", onOnline)
    })
  })

  const projectApi = {
    loadSessions,
    refresh() {
      return refreshGlobal({ project: true })
    },
    refreshDirectory(directory: string) {
      return bootstrapInstance(directory)
    },
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfig = async (config: Config) => {
    const overlayState = Array.isArray(config.disabled_providers)
      ? beginDisabledProvidersMutation(config.disabled_providers)
      : undefined
    const scope = inferConfigRefreshScope(config)
    setGlobalStore("reload", "pending")
    if (scope !== "full") {
      pendingGlobalDisposedScope = scope
      pendingGlobalDisposedUntil = Date.now() + 5000
    }
    return globalSDK.client.global.config
      .update({ config })
      .then(() => (scope === "full" ? bootstrap() : refreshGlobal(scope)))
      .then(() => {
        setGlobalStore("reload", "complete")
      })
      .catch((error) => {
        if (scope !== "full") {
          pendingGlobalDisposedScope = undefined
          pendingGlobalDisposedUntil = 0
        }
        if (overlayState) rollbackDisabledProvidersMutation(overlayState)
        setGlobalStore("reload", undefined)
        throw error
      })
  }

  const setDisabledProviders = async (next: string[]) => {
    const overlayState = beginDisabledProvidersMutation(next)
    try {
      pendingGlobalDisposedScope = { config: true, provider: true }
      pendingGlobalDisposedUntil = Date.now() + 5000
      await globalSDK.client.global.config.update(
        {
          config: {
            disabled_providers: normalizeStringList(next),
          },
        },
        { throwOnError: true },
      )
      await refreshGlobal({ config: true, provider: true })
    } catch (error) {
      pendingGlobalDisposedScope = undefined
      pendingGlobalDisposedUntil = 0
      rollbackDisabledProvidersMutation(overlayState)
      throw error
    }
  }

  const setProviderDisabled = async (providerID: string, disabled: boolean) => {
    const current = new Set(effectiveDisabledProviders())
    if (disabled) current.add(providerID)
    else current.delete(providerID)
    await setDisabledProviders([...current])
  }

  const refreshProviderState = async (directory?: string) => {
    await refreshGlobal({
      config: true,
      provider: true,
      provider_auth: true,
      account_families: true,
    })
    if (!directory) return
    await bootstrapInstance(directory)
  }

  return {
    data: globalStore,
    set: setGlobalStore,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    bootstrap,
    updateConfig,
    refreshProviderState,
    configActions: {
      disabledProviders: effectiveDisabledProviders,
      isProviderDisabled(providerID: string) {
        return effectiveDisabledProviders().includes(providerID)
      },
      setDisabledProviders,
      setProviderDisabled,
    },
    project: projectApi,
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return (
    <Switch>
      <Match when={value.ready}>
        <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}

export { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
export { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
