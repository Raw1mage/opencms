import { batch, createEffect, createMemo, onCleanup, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Persist } from "@/utils/persist"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { getFilename } from "@opencode-ai/util/path"
import type { FileOperationResult } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useGlobalSync } from "./global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import { reconcileTabsForOperation } from "./file/reconcile"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"
import { formatApiErrorMessage } from "@/utils/api-error"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown) {
  return formatApiErrorMessage({
    error,
    fallback: "Unknown error",
    projectBoundaryMessage:
      "This workspace can only access files inside the active project directory. Switch workspace before opening paths outside this project.",
  })
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const globalSync = useGlobalSync()
    const params = useParams()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() => `${params.dir}${params.id ? "/" + params.id : ""}`)

    const inflight = new Map<string, Promise<void>>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) => sdk.client.file.list({ path: dir }).then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    // ── Pinned folders ────────────────────────────────────────────────
    // Per-(workspace, session) shortcut list rendered in file-tree
    // header. Click a chip → focus(): expand all ancestors, scroll the
    // row into view, briefly highlight. Population is driven by the
    // file-tree right-click @Mention action (file → pin parent folder;
    // folder → pin self). Persisted via the same storage scheme as the
    // prompt input/context so navigating away and back keeps pins.
    const pinKey = createMemo(() => Persist.scoped(scope(), params.id, "pinned-folders").key)
    const [pinned, setPinned] = createSignal<string[]>([])
    createEffect(() => {
      const k = pinKey()
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem(k) : null
        setPinned(raw ? (JSON.parse(raw) as string[]) : [])
      } catch {
        setPinned([])
      }
    })
    const writePins = (next: string[]) => {
      setPinned(next)
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(pinKey(), JSON.stringify(next))
      } catch {}
    }
    const pinFolder = (input: string) => {
      const folder = path.normalizeDir(input)
      // Skip pinning the workspace root — it's always visible, no value.
      if (folder === "") return
      const current = pinned()
      if (current.includes(folder)) return
      writePins([...current, folder])
    }
    const unpinFolder = (input: string) => {
      const folder = path.normalizeDir(input)
      writePins(pinned().filter((p) => p !== folder))
    }

    /**
     * Focus a folder in the tree: expand every ancestor up to root, then
     * scroll the matching row into view and apply a brief highlight.
     * Used by header pin chips. Awaits expansion fetches so deep paths
     * become visible after their dirs load.
     */
    const focusFolder = async (input: string) => {
      const folder = path.normalizeDir(input)
      if (folder === "") return
      const segments = folder.split("/")
      // Expand ancestors top-down so each child listing has a parent loaded.
      // expandDir triggers listDir(force) — await it so the next iteration
      // can find the now-rendered row.
      let prefix = ""
      for (const seg of segments) {
        prefix = prefix ? `${prefix}/${seg}` : seg
        // expandDir is fire-and-forget internally; trigger and let the
        // tree-store's listDir kick off; await listDir directly so the
        // dom is settled before we query.
        tree.expandDir(prefix)
        await tree.listDir(prefix)
      }
      // Wait one frame so SolidJS reactive updates have rendered.
      await new Promise((r) =>
        typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(() => r(undefined)) : setTimeout(r, 16),
      )
      const target = document.querySelector<HTMLElement>(
        `[data-filetree-row="true"][data-filetree-row-path="${CSS.escape(folder)}"]`,
      )
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" })
        target.dataset.filetreeFocusFlash = "1"
        setTimeout(() => {
          delete target.dataset.filetreeFocusFlash
        }, 1200)
      }
    }

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      inflight.clear()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache()
    const view = createMemo(() => {
      const directory = scope()
      return viewCache.load(directory, params.id)
    })

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk.client.file
        .read({ path: file })
        .then((x) => {
          if (scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e))
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const stop = sdk.event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    const matchingStoreKeys = (source: string): string[] => {
      const prefix = source + "/"
      return Object.keys(store.file).filter((key) => key === source || key.startsWith(prefix))
    }

    const applyOperationResult = (result: FileOperationResult) => {
      // 1. Refresh exactly the directories the server reports as affected.
      for (const dir of result.affectedDirectories ?? []) {
        if (!dir && dir !== "") continue
        void tree.listDir(dir, { force: true })
      }

      // 2. Tab reconcile — close on delete, rebind on rename/move.
      if (result.source) {
        const allTabs = tabs.all()
        const reconciled = reconcileTabsForOperation(
          allTabs,
          tabs.active(),
          result,
          path.pathFromTab,
          path.tab,
        )
        if (reconciled.closed.length > 0 || reconciled.rebound.length > 0) {
          batch(() => {
            tabs.setAll(reconciled.kept)
            tabs.setActive(reconciled.activeRebind)
          })
        }
      }

      // 3. Content / store reconcile.
      const isRebind = (result.operation === "rename" || result.operation === "move") && result.source && result.destination
      const isDelete = result.operation === "delete-to-recyclebin" && result.source

      if (isRebind && result.source && result.destination) {
        const source = result.source
        const destination = result.destination
        const matches = matchingStoreKeys(source)
        if (matches.length > 0) {
          batch(() => {
            setStore(
              "file",
              produce((draft) => {
                for (const oldKey of matches) {
                  const state = draft[oldKey]
                  if (!state) continue
                  const newKey = oldKey === source ? destination : destination + oldKey.slice(source.length)
                  delete draft[oldKey]
                  draft[newKey] = { ...state, path: newKey, name: getFilename(newKey) }
                }
              }),
            )
          })
          // Drop LRU entries; the next read repopulates against the new path.
          for (const oldKey of matches) removeFileContentBytes(oldKey)
        }
      }

      if (isDelete && result.source) {
        const matches = matchingStoreKeys(result.source)
        if (matches.length > 0) {
          batch(() => {
            setStore(
              "file",
              produce((draft) => {
                for (const key of matches) delete draft[key]
              }),
            )
          })
          for (const key of matches) removeFileContentBytes(key)
        }
      }
    }

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        refreshLoaded: tree.refreshLoaded,
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
        focus: focusFolder,
      },
      pinnedFolders: {
        list: pinned,
        pin: pinFolder,
        unpin: unpinFolder,
      },
      get,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
      applyOperationResult,
    }
  },
})
