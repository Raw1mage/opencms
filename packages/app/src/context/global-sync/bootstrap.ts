import {
  type Config,
  type Path,
  type PermissionRequest,
  type Project,
  type ProviderAuthResponse,
  type ProviderListResponse,
  type QuestionRequest,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { retry } from "@opencode-ai/util/retry"
import { getFilename } from "@opencode-ai/util/path"
import { showToast } from "@opencode-ai/ui/toast"
import { cmp, normalizeProviderList } from "./utils"
import type { State, StoreSessionStatusEntry, VcsCache } from "./types"
import { formatServerError } from "@/utils/server-errors"

const SILENT_SENTINEL = "__OPENCODE_SILENT_UNAUTHORIZED__"

function isSilentAuthError(err: unknown): boolean {
  return err instanceof Error && err.message === SILENT_SENTINEL
}

export type WorkspaceSnapshot = {
  workspaceId: string
  projectId: string
  directory: string
  kind: "root" | "sandbox" | "derived"
  origin: "local" | "generated" | "imported"
  lifecycleState: "active" | "archived" | "resetting" | "deleting" | "failed"
  displayName?: string
  branch?: string
  attachments: {
    sessionIds: string[]
    activeSessionId?: string
    ptyIds: string[]
    previewIds: string[]
    workerIds: string[]
    draftKeys: string[]
    fileTabKeys: string[]
    commentKeys: string[]
  }
}

async function getWorkspaceJson<T>(input: {
  baseUrl?: string
  fetch?: typeof fetch
  path: string
  directory?: string
}): Promise<T | undefined> {
  if (!input.baseUrl || !input.fetch) return undefined
  const headers: Record<string, string> = {}
  if (input.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(input.directory)
    headers["x-opencode-directory"] = isNonASCII ? encodeURIComponent(input.directory) : input.directory
  }
  const response = await input.fetch(`${input.baseUrl}/api/v2/workspace${input.path}`, { headers })
  if (!response.ok) return undefined
  return (await response.json()) as T
}

export function fetchWorkspaceCurrent(input: { baseUrl?: string; fetch?: typeof fetch; directory?: string }) {
  return getWorkspaceJson<WorkspaceSnapshot>({ ...input, path: "/current" })
}

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  account_families: Record<string, { accounts: Record<string, any>; activeAccount?: string }>
  config: Config
  reload: undefined | "pending" | "complete"
}

export type GlobalRefreshSlice = "config" | "project" | "provider" | "provider_auth" | "account_families"

function globalRefreshTasks(input: {
  globalSDK: ReturnType<typeof createOpencodeClient>
  setGlobalStore: SetStoreFunction<GlobalStore>
}) {
  return {
    config: () =>
      retry(() =>
        input.globalSDK.global.config.get().then((x) => {
          input.setGlobalStore("config", x.data!)
        }),
      ),
    project: () =>
      retry(() =>
        input.globalSDK.project.list().then((x) => {
          const projects = (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
          input.setGlobalStore("project", projects)
        }),
      ),
    provider: () =>
      retry(() =>
        input.globalSDK.provider.list().then((x) => {
          input.setGlobalStore("provider", normalizeProviderList(x.data!))
        }),
      ),
    provider_auth: () =>
      retry(() =>
        input.globalSDK.provider.auth().then((x) => {
          input.setGlobalStore("provider_auth", x.data ?? {})
        }),
      ),
    account_families: () =>
      retry(() =>
        input.globalSDK.account.listAll().then((x) => {
          const payload = x.data as { providers?: Record<string, any>; families?: Record<string, any> } | undefined
          input.setGlobalStore("account_families", payload?.providers ?? payload?.families ?? {})
        }),
      ),
  } satisfies Record<GlobalRefreshSlice, () => Promise<void>>
}

export async function refreshGlobalSlices(input: {
  globalSDK: ReturnType<typeof createOpencodeClient>
  requestFailedTitle: string
  setGlobalStore: SetStoreFunction<GlobalStore>
  slices: GlobalRefreshSlice[]
}) {
  const tasks = globalRefreshTasks(input)
  const selected = [...new Set(input.slices)]
  const results = await Promise.allSettled(selected.map((slice) => tasks[slice]()))
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
    .filter((e) => !isSilentAuthError(e))
  if (errors.length) {
    const message = formatServerError(errors[0])
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : ""
    showToast({
      variant: "error",
      title: input.requestFailedTitle,
      description: message + more,
    })
  }
}

export async function bootstrapGlobal(input: {
  globalSDK: ReturnType<typeof createOpencodeClient>
  connectErrorTitle: string
  connectErrorDescription: string
  requestFailedTitle: string
  setGlobalStore: SetStoreFunction<GlobalStore>
}) {
  const healthPromise = input.globalSDK.global
    .health()
    .then((x) => x.data)
    .catch(() => undefined)

  const pathPromise = input.globalSDK.path
    .get()
    .then((x) => {
      input.setGlobalStore("path", x.data!)
      return x.data?.worktree ?? x.data?.directory
    })
    .catch(() => undefined)

  const tasks = Object.values(globalRefreshTasks(input)).map((task) => task())

  const [health, results] = await Promise.all([
    Promise.all([healthPromise, pathPromise]).then(([h]) => h),
    Promise.allSettled(tasks),
  ])

  if (!health?.healthy) {
    showToast({
      variant: "error",
      title: input.connectErrorTitle,
      description: input.connectErrorDescription,
    })
    input.setGlobalStore("ready", true)
    return
  }

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
    .filter((e) => !isSilentAuthError(e))
  if (errors.length) {
    const message = formatServerError(errors[0])
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : ""
    showToast({
      variant: "error",
      title: input.requestFailedTitle,
      description: message + more,
    })
  }
  input.setGlobalStore("ready", true)
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

export async function bootstrapDirectory(input: {
  directory: string
  sdk: ReturnType<typeof createOpencodeClient>
  fetch?: typeof fetch
  baseUrl?: string
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
}) {
  if (input.store.status !== "complete") input.setStore("status", "loading")
  // Clear transient runtime state that is in-memory on the daemon side.
  // After a daemon restart these entries are stale and would show ghost RATE/ERR badges.
  input.setStore("llm_history", [])
  input.setStore("llm_errors", [])

  const blockingRequests = {
    project: () => input.sdk.project.current().then((x) => input.setStore("project", x.data!.id)),
    provider: () =>
      input.sdk.provider.list().then((x) => {
        input.setStore("provider", normalizeProviderList(x.data!))
      }),
    agent: () => input.sdk.app.agents().then((x) => input.setStore("agent", x.data ?? [])),
    config: () => input.sdk.config.get().then((x) => input.setStore("config", x.data!)),
  }

  try {
    await Promise.all(Object.values(blockingRequests).map((p) => retry(p)))
  } catch (err) {
    console.error("Failed to bootstrap instance", err)
    const project = getFilename(input.directory)
    showToast({
      variant: "error",
      title: `Failed to reload ${project}`,
      description: formatServerError(err),
    })
    input.setStore("status", "partial")
    return
  }

  if (input.store.status !== "complete") input.setStore("status", "partial")

  Promise.allSettled([
    input.sdk.path.get().then((x) => input.setStore("path", x.data!)),
    input.sdk.command.list().then((x) => input.setStore("command", x.data ?? [])),
    fetchWorkspaceCurrent({ baseUrl: input.baseUrl, fetch: input.fetch, directory: input.directory }).then((x) => {
      if (x) input.setStore("workspace", x)
    }),
    input.sdk.session.status().then((x) => {
      // session-ui-freshness R1 / DD-1: stamp receivedAt on every entry of bulk bootstrap response.
      const now = Date.now()
      const stamped: Record<string, StoreSessionStatusEntry> = {}
      for (const [sid, status] of Object.entries(x.data!)) stamped[sid] = { ...status, receivedAt: now }
      input.setStore("session_status", stamped)
    }),
    input.loadSessions(input.directory),
    input.sdk.mcp.status().then((x) => input.setStore("mcp", x.data!)),
    input.sdk.lsp.status().then((x) => input.setStore("lsp", x.data!)),
    input.sdk.vcs.get().then((x) => {
      const next = x.data ?? input.store.vcs
      input.setStore("vcs", next)
      if (next?.branch) input.vcsCache.setStore("value", next)
    }),
    input.sdk.permission.list().then((x) => {
      const grouped = groupBySession(
        (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
      )
      batch(() => {
        for (const sessionID of Object.keys(input.store.permission)) {
          if (grouped[sessionID]) continue
          input.setStore("permission", sessionID, [])
        }
        for (const [sessionID, permissions] of Object.entries(grouped)) {
          input.setStore(
            "permission",
            sessionID,
            reconcile(
              permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
              { key: "id" },
            ),
          )
        }
      })
    }),
    input.sdk.question.list().then((x) => {
      const grouped = groupBySession((x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID))
      batch(() => {
        for (const sessionID of Object.keys(input.store.question)) {
          if (grouped[sessionID]) continue
          input.setStore("question", sessionID, [])
        }
        for (const [sessionID, questions] of Object.entries(grouped)) {
          input.setStore(
            "question",
            sessionID,
            reconcile(
              questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
              { key: "id" },
            ),
          )
        }
      })
    }),
  ]).then((results) => {
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason)
    if (errors.length > 0) {
      console.warn("[bootstrapDirectory] Some non-blocking requests failed:", errors)
    }
    input.setStore("status", "complete")
  })
}
