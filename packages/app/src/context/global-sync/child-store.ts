import { createStore, produce, type SetStoreFunction, type Store } from "solid-js/store"
import { runWithOwner, type Owner, createEffect } from "solid-js"
import { Persist, persisted } from "@/utils/persist"
import type { State, VcsCache, MetaCache, IconCache, ProjectMeta } from "./types"
import type { VcsInfo } from "@opencode-ai/sdk/v2/client"

export function createChildStoreManager(options: { owner: Owner; onBootstrap: (directory: string) => void }) {
  const children: Record<string, [Store<State>, SetStoreFunction<State>]> = {}
  const vcsCache = new Map<string, VcsCache>()
  const metaCache = new Map<string, MetaCache>()
  const iconCache = new Map<string, IconCache>()

  function ensureChild(directory: string) {
    if (!directory) console.error("No directory provided")
    if (!children[directory]) {
      const vcs = runWithOwner(options.owner, () =>
        persisted(
          Persist.workspace(directory, "vcs", ["vcs.v1"]),
          createStore({ value: undefined as VcsInfo | undefined }),
        ),
      )
      if (!vcs) throw new Error("Failed to create persisted cache")
      const vcsStore = vcs[0]
      const vcsReady = vcs[3]
      vcsCache.set(directory, { store: vcsStore, setStore: vcs[1], ready: vcsReady })

      const meta = runWithOwner(options.owner, () =>
        persisted(
          Persist.workspace(directory, "project", ["project.v1"]),
          createStore({ value: undefined as ProjectMeta | undefined }),
        ),
      )
      if (!meta) throw new Error("Failed to create persisted project metadata")
      metaCache.set(directory, { store: meta[0], setStore: meta[1], ready: meta[3] })

      const icon = runWithOwner(options.owner, () =>
        persisted(
          Persist.workspace(directory, "icon", ["icon.v1"]),
          createStore({ value: undefined as string | undefined }),
        ),
      )
      if (!icon) throw new Error("Failed to create persisted project icon")
      iconCache.set(directory, { store: icon[0], setStore: icon[1], ready: icon[3] })

      const init = () => {
        const child = createStore<State>({
          status: "loading" as const,
          agent: [],
          command: [],
          skill: [],
          project: "",
          projectMeta: meta[0].value,
          icon: icon[0].value,
          provider: { all: [], connected: [], default: {} },
          config: {},
          path: { state: "", config: "", worktree: "", directory: "", home: "" },
          session: [],
          sessionTotal: 0,
          session_status: {},
          session_diff: {},
          todo: {},
          permission: {},
          question: {},
          mcp: {},
          lsp: [],
          vcs: vcsStore.value,
          limit: 5,
          message: {},
          part: {},
        })

        children[directory] = child

        createEffect(() => {
          if (!vcsReady()) return
          const cached = vcsStore.value
          if (!cached?.branch) return
          child[1]("vcs", (value) => value ?? cached)
        })

        createEffect(() => {
          child[1]("projectMeta", meta[0].value)
        })

        createEffect(() => {
          child[1]("icon", icon[0].value)
        })
      }

      runWithOwner(options.owner, init)
    }
    const childStore = children[directory]
    if (!childStore) throw new Error("Failed to create store")
    return childStore
  }

  function child(directory: string, childOptions: { bootstrap?: boolean } = {}) {
    const childStore = ensureChild(directory)
    const shouldBootstrap = childOptions.bootstrap ?? true
    if (shouldBootstrap && childStore[0].status === "loading") {
      options.onBootstrap(directory)
    }
    return childStore
  }

  function projectMeta(directory: string, patch: ProjectMeta) {
    const [store, setStore] = ensureChild(directory)
    const cached = metaCache.get(directory)
    if (!cached) return
    const previous = store.projectMeta ?? {}
    const icon = patch.icon ? { ...(previous.icon ?? {}), ...patch.icon } : previous.icon
    const commands = patch.commands ? { ...(previous.commands ?? {}), ...patch.commands } : previous.commands
    const next = {
      ...previous,
      ...patch,
      icon,
      commands,
    }
    cached.setStore("value", next)
    setStore("projectMeta", next)
  }

  function projectIcon(directory: string, value: string | undefined) {
    const [store, setStore] = ensureChild(directory)
    const cached = iconCache.get(directory)
    if (!cached) return
    if (store.icon === value) return
    cached.setStore("value", value)
    setStore("icon", value)
  }

  return {
    children,
    vcsCache,
    ensureChild,
    child,
    projectMeta,
    projectIcon,
  }
}
