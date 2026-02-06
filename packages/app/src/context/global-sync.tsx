import {
  type Config,
  type Path,
  type Project,
  type ProviderAuthResponse,
  type ProviderListResponse,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
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
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { bootstrapDirectory, bootstrapGlobal } from "./global-sync/bootstrap"
import { sanitizeProject } from "./global-sync/utils"
import type { ProjectMeta } from "./global-sync/types"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

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
    config: {},
    reload: undefined,
  })

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    bootstrap: () => bootstrap(),
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
  })

  const sdkFor = (directory: string) => {
    const cached = sdkCache.get(directory)
    if (cached) return cached
    const sdk = createOpencodeClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      directory,
      throwOnError: true,
    })
    sdkCache.set(directory, sdk)
    return sdk
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

  async function loadSessions(directory: string) {
    const pending = sessionLoads.get(directory)
    if (pending) return pending

    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(directory)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, { limit: store.limit, permission: store.permission })
      if (next.length !== store.session.length) {
        setStore("session", (prev: any) => next)
      }
      return
    }

    const promise = globalSDK.client.session
      .list({ directory, roots: true })
      .then((x) => {
        const nonArchived = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .sort((a, b) => a.id.localeCompare(b.id))

        const limit = store.limit
        const childSessions = store.session.filter((s) => !!s.parentID)
        const sessions = trimSessions([...nonArchived, ...childSessions], { limit, permission: store.permission })

        setStore("sessionTotal", nonArchived.length)
        setStore("session", (prev: any) => sessions)
        sessionMeta.set(directory, { limit })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        const project = getFilename(directory)
        showToast({ title: language.t("toast.session.listFailed.title", { project }), description: err.message })
      })

    sessionLoads.set(directory, promise)
    promise.finally(() => {
      sessionLoads.delete(directory)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    const promise = (async () => {
      const child = children.ensureChild(directory)
      const vcsCache = children.vcsCache.get(directory)
      if (!vcsCache) return
      const sdk = sdkFor(directory)

      try {
        await bootstrapDirectory({
          directory,
          sdk,
          store: child[0],
          setStore: child[1],
          vcsCache,
          loadSessions,
        })
      } catch (err) {
        console.error("Failed to bootstrap instance", err)
        const project = getFilename(directory)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: `Failed to reload ${project}`, description: message })
      }
    })()

    booting.set(directory, promise)
    promise.finally(() => {
      booting.delete(directory)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: queue.refresh,
        setGlobalProject: (next: any) => setGlobalStore("project", next),
      })
      return
    }

    const existing = children.children[directory]
    if (!existing) return

    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      store,
      setStore,
      push: queue.push,
      directory,
      loadLsp: () => {
        sdkFor(directory)
          .lsp.status()
          .then((x) => setStore("lsp", x.data ?? []))
      },
      vcsCache: children.vcsCache.get(directory),
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })

  async function bootstrap() {
    await bootstrapGlobal({
      globalSDK: globalSDK.client,
      setGlobalStore,
      connectErrorTitle: language.t("dialog.server.add.error"),
      connectErrorDescription: language.t("error.globalSync.connectFailed", { url: globalSDK.url }),
      requestFailedTitle: language.t("common.requestFailed"),
    })
  }

  onMount(() => {
    void bootstrap()
  })

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
    updateConfig: (config: Config) => {
      setGlobalStore("reload", "pending")
      return globalSDK.client.global.config.update({ config }).finally(() => {
        setTimeout(() => {
          setGlobalStore("reload", "complete")
        }, 1000)
      })
    },
    project: {
      loadSessions,
      meta: (directory: string, patch: ProjectMeta) => children.projectMeta(directory, patch),
      icon: (directory: string, value: string | undefined) => children.projectIcon(directory, value),
    },
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
