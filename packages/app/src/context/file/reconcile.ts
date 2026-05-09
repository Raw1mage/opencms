/**
 * Tab and content reconcile logic for file-operation results.
 *
 * Pure helpers used by the file context after a successful File namespace
 * mutation (rename / move / copy / delete-to-recyclebin / restore-from-
 * recyclebin / upload). They translate an `OperationResult` into a list of
 * tab edits and content-cache invalidations so callers can apply both
 * without re-implementing the path math.
 */

export type FileOperationKind =
  | "create-file"
  | "create-directory"
  | "rename"
  | "move"
  | "copy"
  | "delete-to-recyclebin"
  | "restore-from-recyclebin"
  | "upload"

export interface OperationLike {
  operation: FileOperationKind | string
  source?: string
  destination?: string
}

export interface TabReconcile {
  kept: string[]
  closed: string[]
  rebound: Array<{ from: string; to: string }>
  activeRebind?: string
}

export interface ContentReconcile {
  invalidate: string[]
  rebind: Array<{ from: string; to: string }>
}

const isFileTab = (tab: string) => tab.startsWith("file://")

function isDescendant(child: string, parent: string): boolean {
  if (!parent) return false
  return child.startsWith(parent + "/")
}

function rebindPath(child: string, fromBase: string, toBase: string): string {
  if (child === fromBase) return toBase
  if (isDescendant(child, fromBase)) return toBase + child.slice(fromBase.length)
  return child
}

const REBIND_OPS: ReadonlySet<string> = new Set(["rename", "move"])
const DELETE_OPS: ReadonlySet<string> = new Set(["delete-to-recyclebin"])

/**
 * Compute the new tab list, dropped tabs, and rebind map for a given
 * file-operation result.
 *
 * - rename / move: any tab whose underlying path equals `source` (or
 *   descends from `source`) is rebound to the corresponding `destination`
 *   path. The active tab follows the rebind if it was affected.
 * - delete-to-recyclebin: any tab equal to or descending from `source` is
 *   closed; the active tab falls back to its left neighbor (or right if
 *   no left), matching the existing `tabs.close()` UX.
 * - other operations (create-file, create-directory, copy, restore,
 *   upload): no tab edits — the call returns a no-op TabReconcile.
 *
 * Non-file tabs (anything not prefixed `file://`) are passed through
 * untouched.
 */
export function reconcileTabsForOperation(
  tabs: string[],
  active: string | undefined,
  result: OperationLike,
  pathFromTab: (tab: string) => string | undefined,
  toTab: (path: string) => string,
): TabReconcile {
  const reply: TabReconcile = { kept: [...tabs], closed: [], rebound: [] }
  if (!result.source) return reply

  const source = result.source
  const destination = result.destination

  if (REBIND_OPS.has(result.operation) && destination) {
    reply.kept = tabs.map((tab) => {
      if (!isFileTab(tab)) return tab
      const filePath = pathFromTab(tab)
      if (!filePath) return tab
      if (filePath !== source && !isDescendant(filePath, source)) return tab
      const newPath = rebindPath(filePath, source, destination)
      const newTab = toTab(newPath)
      reply.rebound.push({ from: tab, to: newTab })
      return newTab
    })
    if (active) {
      const hit = reply.rebound.find((r) => r.from === active)
      if (hit) reply.activeRebind = hit.to
    }
    return reply
  }

  if (DELETE_OPS.has(result.operation)) {
    const survivors: string[] = []
    let activeIndex = -1
    let activeDropped = false
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]
      if (!isFileTab(tab)) {
        if (tab === active) activeIndex = survivors.length
        survivors.push(tab)
        continue
      }
      const filePath = pathFromTab(tab)
      if (!filePath || (filePath !== source && !isDescendant(filePath, source))) {
        if (tab === active) activeIndex = survivors.length
        survivors.push(tab)
        continue
      }
      reply.closed.push(tab)
      if (tab === active) activeDropped = true
    }
    reply.kept = survivors
    if (activeDropped && survivors.length > 0) {
      // Mirror layout.tabs.close() neighbor-picking semantics: when active
      // is dropped, prefer the left neighbor of the *original* index.
      const originalActiveIdx = tabs.findIndex((t) => t === active)
      const left = tabs
        .slice(0, originalActiveIdx)
        .reverse()
        .find((t) => survivors.includes(t))
      const right = tabs.slice(originalActiveIdx + 1).find((t) => survivors.includes(t))
      reply.activeRebind = left ?? right ?? survivors[0]
    } else if (activeDropped) {
      reply.activeRebind = undefined
    } else if (activeIndex !== -1) {
      reply.activeRebind = survivors[activeIndex]
    }
    return reply
  }

  return reply
}

/**
 * Compute content-cache invalidations + rebinds for a file-operation result.
 *
 * The file context's content cache is keyed by relative project path. A
 * rename/move shifts the keys; delete invalidates them. Callers feed the
 * returned lists into `setFileContentBytes(undefined)` / `removeFileContentBytes`.
 *
 * Caveat: the cache is currently flat (no per-directory index), so callers
 * that need to invalidate a renamed/deleted directory must enumerate their
 * own keys; this helper only emits the `source`-equals-key case. Descendant
 * cleanup remains the caller's responsibility for now.
 */
export function reconcileContentForOperation(result: OperationLike): ContentReconcile {
  const reply: ContentReconcile = { invalidate: [], rebind: [] }
  if (!result.source) return reply
  if (REBIND_OPS.has(result.operation) && result.destination) {
    reply.rebind.push({ from: result.source, to: result.destination })
    return reply
  }
  if (DELETE_OPS.has(result.operation)) {
    reply.invalidate.push(result.source)
    return reply
  }
  return reply
}
