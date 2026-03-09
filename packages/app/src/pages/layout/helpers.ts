import { getFilename } from "@opencode-ai/util/path"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { formatApiErrorMessage } from "@/utils/api-error"
import { normalizeWorkspaceDirectory } from "@/context/global-sync/workspace-adapter"

export const workspaceKey = (directory: string) => normalizeWorkspaceDirectory(directory)

export function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

export const isRootVisibleSession = (session: Session, directory: string) =>
  workspaceKey(session.directory) === workspaceKey(directory) && !session.parentID && !session.time?.archived

export const sortedRootSessions = (store: { session: Session[]; path: { directory: string } }, now: number) =>
  store.session.filter((session) => isRootVisibleSession(session, store.path.directory)).sort(sortSessions(now))

export const latestRootSession = (stores: { session: Session[]; path: { directory: string } }[], now: number) =>
  stores
    .flatMap((store) => store.session.filter((session) => isRootVisibleSession(session, store.path.directory)))
    .sort(sortSessions(now))[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined>,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request).some((list) => list?.some(include))
}

export const childMapByParent = (sessions: Session[]) => {
  const map = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const existing = map.get(session.parentID)
    if (existing) {
      existing.push(session.id)
      continue
    }
    map.set(session.parentID, [session.id])
  }
  return map
}

export function getDraggableId(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  if (!("draggable" in event)) return undefined
  const draggable = (event as { draggable?: { id?: unknown } }).draggable
  if (!draggable) return undefined
  return typeof draggable.id === "string" ? draggable.id : undefined
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree)

export const errorMessage = (err: unknown, fallback: string) => {
  return formatApiErrorMessage({
    error: err,
    fallback,
    projectBoundaryMessage:
      "This workspace action is limited to the active project directory. Open the target folder as a workspace first.",
  })
}

export const syncWorkspaceOrder = (local: string, dirs: string[], existing?: string[]) => {
  const root = workspaceKey(local)
  const canonical = new Map(dirs.map((directory) => [workspaceKey(directory), directory]))
  if (!existing) return [local, ...dirs.filter((directory) => workspaceKey(directory) !== root)]
  const keep = existing.filter((directory) => {
    const key = workspaceKey(directory)
    return key !== root && canonical.has(key)
  })
  const keepKeys = new Set(keep.map((directory) => workspaceKey(directory)))
  const missing = dirs.filter((directory) => {
    const key = workspaceKey(directory)
    return key !== root && !keepKeys.has(key)
  })
  return [local, ...missing, ...keep]
}
