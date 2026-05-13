import { createStore, produce, reconcile } from "solid-js/store"
import type { FileNode } from "@opencode-ai/sdk/v2"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  // Inline FileNode entries (not keyed by relative path). Storing the
  // actual node objects per directory avoids the cross-view key collision
  // we hit when two views legitimately use the same relative path ("..")
  // to refer to different filesystem entities — e.g. the synthetic ".."
  // entry of the workspace view and the real "projects" entry seen when
  // the user navigates to the workspace's parent both end up with
  // path === ".." and would overwrite each other in a global node map.
  children?: FileNode[]
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
}

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const inflight = new Map<string, Promise<void>>()

  const reset = () => {
    inflight.clear()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  const listDir = (input: string, opts?: { force?: boolean; silent?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Promise.resolve()

    const pending = inflight.get(dir)
    if (pending) return pending

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )

    const directory = options.scope()

    const promise = options
      .list(dir)
      .then((nodes) => {
        if (options.scope() !== directory) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextPaths = new Set(nodes.map((n) => n.path))

        setTree(
          "node",
          produce((draft) => {
            // Maintain the global path→node map for back-compat callers
            // (watcher invalidation looks up by relative path). Render path
            // does NOT depend on this map any more; the per-dir inline
            // children array below is the source of truth for the view.
            const removedDirs: string[] = []

            for (const child of prevChildren) {
              if (nextPaths.has(child.path)) continue
              const existing = draft[child.path]
              if (existing?.type === "directory") removedDirs.push(child.path)
              delete draft[child.path]
            }

            if (removedDirs.length > 0) {
              const keys = Object.keys(draft)
              for (const key of keys) {
                for (const removed of removedDirs) {
                  if (!key.startsWith(removed + "/")) continue
                  delete draft[key]
                  break
                }
              }
            }

            for (const node of nodes) {
              const existing = draft[node.path]
              if (
                existing &&
                existing.name === node.name &&
                existing.absolute === node.absolute &&
                existing.type === node.type &&
                existing.ignored === node.ignored &&
                existing.size === node.size &&
                existing.modifiedAt === node.modifiedAt
              )
                continue
              draft[node.path] = node
            }
          }),
        )

        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loaded = true
            draft.loading = false
            draft.children = nodes
          }),
        )
      })
      .catch((e) => {
        if (options.scope() !== directory) return
        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loading = false
            draft.error = e.message
          }),
        )
        if (!opts?.silent) options.onError(e.message)
      })
      .finally(() => {
        inflight.delete(dir)
      })

    inflight.set(dir, promise)
    return promise
  }

  const expandDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    void listDir(dir, { force: true })
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]?.children ?? []
  }

  /**
   * Walk a path top-down: mark every ancestor expanded and ensure each
   * is listed exactly once. Used by header pin chips to bring a deep
   * folder into view without triggering `expandDir`'s force-refresh on
   * every level (which would multiply requests by depth and trip the
   * server-side rate limiter).
   *
   * Idempotent: ancestors already loaded skip the network call via
   * `listDir`'s no-force short-circuit. Concurrent focus() calls share
   * the same in-flight promises through the inflight map.
   */
  const focus = async (input: string) => {
    const target = options.normalizeDir(input)
    if (!target) return
    const segments = target.split("/")
    let prefix = ""
    for (const seg of segments) {
      prefix = prefix ? `${prefix}/${seg}` : seg
      ensureDir(prefix)
      setTree("dir", prefix, "expanded", true)
      await listDir(prefix)
    }
  }

  const refreshLoaded = (filter?: (dir: string) => boolean) => {
    const targets: string[] = []
    for (const [dir, state] of Object.entries(tree.dir)) {
      if (!state?.loaded) continue
      if (!state.expanded) continue
      if (filter && !filter(dir)) continue
      targets.push(dir)
    }
    return Promise.all(targets.map((dir) => listDir(dir, { force: true, silent: true })))
  }

  return {
    listDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    focus,
    refreshLoaded,
    reset,
  }
}
