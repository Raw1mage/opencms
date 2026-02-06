import { retry } from "@opencode-ai/util/retry"
import { produce, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import { normalizeProviderList } from "./utils"

export async function bootstrapGlobal(input: {
  globalSDK: any // SDK client
  setGlobalStore: SetStoreFunction<any>
  connectErrorTitle: string
  connectErrorDescription: string
  requestFailedTitle: string
}) {
  const { globalSDK, setGlobalStore, connectErrorTitle, connectErrorDescription, requestFailedTitle } = input

  const health = await globalSDK.global
    .health()
    .then((x: any) => x.data)
    .catch(() => undefined)

  if (!health?.healthy) {
    setGlobalStore("ready", true)
    return { error: "unhealthy" }
  }

  const tasks = [
    retry(() =>
      globalSDK.path.get().then((x: any) => {
        setGlobalStore("path", x.data!)
      }),
    ),
    retry(() =>
      globalSDK.global.config.get().then((x: any) => {
        setGlobalStore("config", x.data!)
      }),
    ),
    retry(() =>
      globalSDK.project.list().then(async (x: any) => {
        const projects = (x.data ?? [])
          .filter((p: any) => !!p?.id)
          .filter((p: any) => !!p.worktree && !p.worktree.includes("opencode-test"))
          .slice()
          .sort((a: any, b: any) => a.id.localeCompare(b.id))
        setGlobalStore("project", projects)
      }),
    ),
    retry(() =>
      globalSDK.provider.list().then((x: any) => {
        setGlobalStore("provider", normalizeProviderList(x.data!))
      }),
    ),
    retry(() =>
      globalSDK.provider.auth().then((x: any) => {
        setGlobalStore("provider_auth", x.data ?? {})
      }),
    ),
  ]

  const results = await Promise.allSettled(tasks)
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason)

  setGlobalStore("ready", true)
  return { errors }
}

export async function bootstrapDirectory(input: {
  directory: string
  sdk: any
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void>
}) {
  const { directory, sdk, store, setStore, vcsCache, loadSessions } = input

  setStore("status", "loading")

  const blockingRequests = {
    project: () => sdk.project.current().then((x: any) => setStore("project", x.data!.id)),
    provider: () =>
      sdk.provider.list().then((x: any) => {
        setStore("provider", normalizeProviderList(x.data!))
      }),
    agent: () => sdk.app.agents().then((x: any) => setStore("agent", x.data ?? [])),
    config: () => sdk.config.get().then((x: any) => setStore("config", x.data!)),
  }

  try {
    await Promise.all(Object.values(blockingRequests).map((p) => retry(p)))
  } catch (err) {
    setStore("status", "partial")
    throw err
  }

  if (store.status !== "complete") setStore("status", "partial")

  await Promise.all([
    sdk.path.get().then((x: any) => setStore("path", x.data!)),
    sdk.command.list().then((x: any) => setStore("command", x.data ?? [])),
    sdk.app.skills().then((x: any) => setStore("skill", x.data ?? [])),
    sdk.session.status().then((x: any) => setStore("session_status", x.data!)),
    loadSessions(directory),
    sdk.mcp.status().then((x: any) => setStore("mcp", x.data!)),
    sdk.lsp.status().then((x: any) => setStore("lsp", x.data!)),
    sdk.vcs.get().then((x: any) => {
      const next = x.data ?? store.vcs
      setStore("vcs", next)
      if (next?.branch) vcsCache.setStore("value", next)
    }),
    sdk.permission.list().then((x: any) => {
      const grouped: Record<string, any[]> = {}
      for (const perm of x.data ?? []) {
        if (!perm?.id || !perm.sessionID) continue
        const existing = grouped[perm.sessionID]
        if (existing) {
          existing.push(perm)
          continue
        }
        grouped[perm.sessionID] = [perm]
      }

      setStore(
        produce((draft) => {
          for (const sessionID of Object.keys(draft.permission)) {
            if (grouped[sessionID]) continue
            draft.permission[sessionID] = []
          }
          for (const [sessionID, permissions] of Object.entries(grouped)) {
            draft.permission[sessionID] = permissions.filter((p) => !!p?.id).sort((a, b) => a.id.localeCompare(b.id))
          }
        }),
      )
    }),
    sdk.question.list().then((x: any) => {
      const grouped: Record<string, any[]> = {}
      for (const question of x.data ?? []) {
        if (!question?.id || !question.sessionID) continue
        const existing = grouped[question.sessionID]
        if (existing) {
          existing.push(question)
          continue
        }
        grouped[question.sessionID] = [question]
      }

      setStore(
        produce((draft) => {
          for (const sessionID of Object.keys(draft.question)) {
            if (grouped[sessionID]) continue
            draft.question[sessionID] = []
          }
          for (const [sessionID, questions] of Object.entries(grouped)) {
            draft.question[sessionID] = questions.filter((q) => !!q?.id).sort((a, b) => a.id.localeCompare(b.id))
          }
        }),
      )
    }),
  ])

  setStore("status", "complete")
}
