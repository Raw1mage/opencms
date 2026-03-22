import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import { sendSessionReloadDebugBeacon } from "@/utils/debug-beacon"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { State } from "./global-sync/types"
import { buildMonitorEntries, buildSessionTelemetryFromProjector } from "@/pages/session/monitor-helper"

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const diffCacheKey = (sessionID: string, messageID?: string) =>
  messageID ? `${sessionID}:msg:${messageID}` : sessionID

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (!messages) {
    draft.message[input.sessionID] = [input.message]
  }
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    messages.splice(result.index, 0, input.message)
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    const next = [...messages]
    next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (!result.found) return messages
    const next = [...messages]
    next.splice(result.index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const fallbackChild: [Store<State>, SetStoreFunction<State>] = createStore<State>({
      status: "loading" as const,
      agent: [],
      command: [],
      project: "",
      workspace: undefined,
      projectMeta: undefined,
      icon: undefined,
      provider: { all: [], connected: [], default: {} },
      config: {},
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      session: [],
      sessionTotal: 0,
      session_status: {},
      active_child: {},
      session_telemetry: {},
      session_diff: {},
      workspace_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp: {},
      killswitch_status: undefined,
      llm_errors: [],
      llm_history: [],
      lsp: [],
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
    })
    let fallbackWarned = false
    const current = createMemo(() => globalSync.child(sdk.directory))
    const currentChild = () => {
      const child = current()
      if (child) return child
      if (import.meta.env.DEV && !fallbackWarned) {
        fallbackWarned = true
        console.warn(
          `[sync] Missing globalSync child for ${sdk.directory}; using fallback child store during bootstrap`,
        )
      }
      return fallbackChild
    }
    const currentStore = () => currentChild()[0]
    const currentSetter = () => currentChild()[1]
    const target = (directory?: string) => {
      if (!directory || directory === sdk.directory) return currentChild()
      return globalSync.child(directory)
    }
    const absolute = (path: string) => (currentStore().path.directory + "/" + path).replace("//", "/")
    const messagePageSize = 400
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const getSession = (sessionID: string) => {
      const store = currentStore()
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const limitFor = (count: number) => {
      if (count <= messagePageSize) return messagePageSize
      return Math.ceil(count / messagePageSize) * messagePageSize
    }

    const fetchMessages = async (input: { client: typeof sdk.client; sessionID: string; limit: number }) => {
      const messages = await retry(() =>
        input.client.session.messages({ directory: sdk.directory, sessionID: input.sessionID, limit: input.limit }),
      )
      const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
      const session = items
        .map((x) => x.info)
        .filter((m) => !!m?.id)
        .sort((a, b) => cmp(a.id, b.id))
      const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
      return {
        session,
        part,
        complete: session.length < input.limit,
      }
    }

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return
      sendSessionReloadDebugBeacon({
        sdk,
        event: "loadMessages:start",
        sessionID: input.sessionID,
        payload: {
          directory: input.directory,
          limit: input.limit,
        },
      })
      setMeta("loading", key, true)
      await fetchMessages(input)
        .then((next) => {
          sendSessionReloadDebugBeacon({
            sdk,
            event: "loadMessages:success",
            sessionID: input.sessionID,
            payload: {
              directory: input.directory,
              messageCount: next.session.length,
              complete: next.complete,
            },
          })
          batch(() => {
            input.setStore("message", input.sessionID, reconcile(next.session, { key: "id" }))
            for (const message of next.part) {
              input.setStore("part", message.id, reconcile(message.part, { key: "id" }))
            }
            setMeta("limit", key, input.limit)
            setMeta("complete", key, next.complete)
          })
        })
        .catch((error) => {
          sendSessionReloadDebugBeacon({
            sdk,
            event: "loadMessages:error",
            sessionID: input.sessionID,
            payload: {
              directory: input.directory,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          throw error
        })
        .finally(() => {
          sendSessionReloadDebugBeacon({
            sdk,
            event: "loadMessages:done",
            sessionID: input.sessionID,
            payload: {
              directory: input.directory,
            },
          })
          setMeta("loading", key, false)
        })
    }

    return {
      get data() {
        return currentStore()
      },
      get set(): Setter {
        return currentSetter()
      },
      get status() {
        return currentStore().status
      },
      get ready() {
        return currentStore().status !== "loading"
      },
      get project() {
        const store = currentStore()
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const [, setStore] = target(input.directory)
            setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const [, setStore] = target(input.directory)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
          },
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerId: string; modelID: string; accountId?: string }
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
          }
          const [, setStore] = target()
          setOptimisticAdd(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string, options?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)
          const force = !!options?.force
          const hasSession = (() => {
            const match = Binary.search(store.session, sessionID, (s) => s.id)
            return match.found
          })()
          const hasMessages = store.message[sessionID] !== undefined
          const hydrated = meta.limit[key] !== undefined
          sendSessionReloadDebugBeacon({
            sdk,
            event: "session.sync:start",
            sessionID,
            payload: {
              directory,
              force,
              hasSession,
              hasMessages,
              hydrated,
            },
          })
          if (!force && hasSession && hasMessages && hydrated) return
          const count = store.message[sessionID]?.length ?? 0
          const limit = hydrated ? (meta.limit[key] ?? messagePageSize) : limitFor(count)

          const sessionReq =
            hasSession && !force
              ? Promise.resolve()
              : retry(() => client.session.get({ directory, sessionID })).then((session) => {
                  const data = session.data
                  sendSessionReloadDebugBeacon({
                    sdk,
                    event: "session.sync:get",
                    sessionID,
                    payload: {
                      directory,
                      found: !!data,
                      resolvedDirectory: data?.directory,
                    },
                  })
                  if (!data) return
                  setStore(
                    "session",
                    produce((draft) => {
                      const match = Binary.search(draft, sessionID, (s) => s.id)
                      if (match.found) {
                        draft[match.index] = data
                        return
                      }
                      draft.splice(match.index, 0, data)
                    }),
                  )
                })

          const messagesReq =
            hasMessages && hydrated && !force
              ? Promise.resolve()
              : loadMessages({
                  directory,
                  client,
                  setStore,
                  sessionID,
                  limit,
                })

          return runInflight(inflight, key, () =>
            Promise.all([sessionReq, messagesReq])
              .then(() => {
                sendSessionReloadDebugBeacon({
                  sdk,
                  event: "session.sync:done",
                  sessionID,
                  payload: {
                    directory,
                  },
                })
              })
              .catch((error) => {
                sendSessionReloadDebugBeacon({
                  sdk,
                  event: "session.sync:error",
                  sessionID,
                  payload: {
                    directory,
                    error: error instanceof Error ? error.message : String(error),
                  },
                })
                throw error
              }),
          )
        },
        async diff(sessionID: string, options?: { force?: boolean; messageID?: string }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const cacheKey = diffCacheKey(sessionID, options?.messageID)
          if (!options?.force && store.session_diff[cacheKey] !== undefined) return
          const key = keyFor(directory, cacheKey)
          return runInflight(inflightDiff, key, () => {
            if (options?.messageID) {
              return retry(() => client.session.diff({ sessionID, messageID: options.messageID })).then((response) => {
                setStore("session_diff", cacheKey, reconcile(response.data ?? [], { key: "file" }))
              })
            }
            return retry(() => client.session.diff({ sessionID })).then((response) => {
              setStore("session_diff", cacheKey, reconcile(response.data ?? [], { key: "file" }))
            })
          })
        },
        async workspaceDiff(sessionID: string, options?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (!options?.force && store.workspace_diff[sessionID] !== undefined) return
          const session = getSession(sessionID)
          const targetDirectory = session?.directory ?? directory
          const key = keyFor(directory, `workspace:${sessionID}`)
          return runInflight(inflightDiff, key, () =>
            retry(() => client.file.status({ directory: targetDirectory })).then((response) => {
              setStore("workspace_diff", sessionID, reconcile(response.data ?? [], { key: "path" }))
            }),
          )
        },
        async todo(sessionID: string, options?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          if (!options?.force && store.todo[sessionID] !== undefined) return
          const key = keyFor(directory, sessionID)
          return runInflight(inflightTodo, key, () =>
            retry(() => client.session.todo({ sessionID })).then((todo) => {
              setStore("todo", sessionID, reconcile(todo.data ?? [], { key: "id" }))
            }),
          )
        },
        async telemetry(
          sessionID: string,
          options?: {
            force?: boolean
            monitor?: Parameters<typeof buildSessionTelemetryFromProjector>[0]["monitorEntries"]
            loading?: boolean
            error?: string
          },
        ) {
          const directory = sdk.directory
          const [store, setStore] = globalSync.child(directory)
          if (store.session_telemetry[sessionID] !== undefined) return
          const session = getSession(sessionID)
          const status = store.session_status[sessionID]
          const monitorEntries =
            options?.monitor ??
            (await retry(() =>
              sdk.client.session.top({
                sessionID,
                includeDescendants: true,
                maxMessages: 80,
              }),
            ).then((result) => result.data ?? []))
          setStore(
            "session_telemetry",
            sessionID,
            reconcile(
              buildSessionTelemetryFromProjector({
                session,
                status,
                monitorEntries,
                loading: options?.loading,
                error: options?.error,
              }),
            ),
          )
        },
        history: {
          more(sessionID: string) {
            const store = currentStore()
            const key = keyFor(sdk.directory, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return true
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count = messagePageSize) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            const key = keyFor(directory, sessionID)
            if (meta.loading[key]) return
            if (meta.complete[key]) return
            const currentLimit = meta.limit[key] ?? messagePageSize
            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: currentLimit + count,
            })
          },
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => currentStore().session.length >= currentStore().limit),
      },
      absolute,
      get directory() {
        return currentStore().path.directory
      },
    }
  },
})
