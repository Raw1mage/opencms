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
import { frontendTweaks } from "./frontend-tweaks"

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
      codex_transport: {},
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
      partCount: {} as Record<string, number>, // populated from /session/:id/meta when lazyload flag=1
    })

    /**
     * specs/frontend-session-lazyload R6: when flag=1, pick initial message
     * page size based on server-reported partCount (tweaks.initial_page_size_*).
     * When flag=0, returns the legacy constant to preserve INV-2 baseline.
     */
    const pageSizeFor = (partCount: number): number | "all" => {
      const cfg = frontendTweaks()
      if (cfg.frontend_session_lazyload !== 1) return messagePageSize
      if (partCount <= 50) return cfg.initial_page_size_small
      if (partCount <= 200) return cfg.initial_page_size_medium
      return cfg.initial_page_size_large
    }

    /**
     * Fetch /session/:id/meta via raw sdk.fetch. Once the SDK is regenerated
     * this can migrate to sdk.client.session.meta(). Failure returns null so
     * the caller can fall back to legacy sizing (INV-6 is enforced at the
     * openRootSession seam, not here — sync() already ran, so we just use
     * the legacy page size).
     */
    const fetchSessionMeta = async (
      directory: string,
      sessionID: string,
    ): Promise<{ partCount: number; totalBytes: number } | null> => {
      try {
        const response = await sdk.fetch(
          `${sdk.url}/api/v2/session/${encodeURIComponent(sessionID)}/meta?directory=${encodeURIComponent(directory)}`,
        )
        if (!response.ok) return null
        const body = (await response.json()) as { partCount: number; totalBytes: number }
        return { partCount: body.partCount, totalBytes: body.totalBytes }
      } catch {
        return null
      }
    }

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

    // Incremental tail fetch — used by force-resync when we already have
    // messages hydrated. Instead of re-downloading the whole session (which
    // races an in-flight streaming reply and can wipe partial parts), ask
    // the server for just the messages created since shortly before our
    // newest known message, then merge them into the existing store.
    const INCREMENTAL_SINCE_MARGIN_MS = 1000
    const loadMessagesIncremental = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      store: Store<State>
      sessionID: string
    }) => {
      const existing = input.store.message[input.sessionID] ?? []
      if (existing.length === 0) return // caller should use loadMessages for cold start
      // Use the newest known message's created time as the cursor, minus a
      // small margin so any message written during that boundary second is
      // included. The server returns messages with time.created >= since.
      let newest = 0
      for (const msg of existing) {
        const t = msg?.time?.created
        if (typeof t === "number" && t > newest) newest = t
      }
      if (newest === 0) return // nothing to anchor against — let caller decide
      const since = newest - INCREMENTAL_SINCE_MARGIN_MS
      sendSessionReloadDebugBeacon({
        sdk,
        event: "loadMessagesIncremental:start",
        sessionID: input.sessionID,
        payload: { directory: input.directory, since },
      })
      try {
        const url = new URL(`${sdk.url}/api/v2/session/${input.sessionID}/message`)
        url.searchParams.set("directory", input.directory)
        url.searchParams.set("since", String(since))
        const res = await retry(() => sdk.fetch(url.toString()))
        if (!res.ok) throw new Error(`incremental fetch ${res.status}`)
        const raw = (await res.json()) as Array<{ info: Message; parts: Part[] }>
        const incoming = raw.filter((x) => !!x?.info?.id)
        sendSessionReloadDebugBeacon({
          sdk,
          event: "loadMessagesIncremental:success",
          sessionID: input.sessionID,
          payload: { directory: input.directory, since, incomingCount: incoming.length },
        })
        if (incoming.length === 0) return
        batch(() => {
          input.setStore(
            "message",
            input.sessionID,
            produce((draft: Message[]) => {
              for (const item of incoming) {
                const msg = item.info
                const idx = draft.findIndex((m) => m?.id === msg.id)
                if (idx >= 0) draft[idx] = msg
                else draft.push(msg)
              }
              draft.sort((a, b) => cmp(a?.id ?? "", b?.id ?? ""))
            }),
          )
          for (const item of incoming) {
            input.setStore("part", item.info.id, reconcile(sortParts(item.parts), { key: "id" }))
          }
        })
      } catch (error) {
        sendSessionReloadDebugBeacon({
          sdk,
          event: "loadMessagesIncremental:error",
          sessionID: input.sessionID,
          payload: {
            directory: input.directory,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      }
    }

    // R9 (frontend-session-lazyload revise 2026-04-22): cursor-based older
    // history pagination. Replaces the previous "grow `limit` and refetch
    // the whole prefix" hack with a true append. Uses direct fetch so we
    // can send the `beforeMessageID` query param without waiting for an
    // SDK regen cycle (mirrors the `loadMessagesIncremental` pattern).
    const loadOlderMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      store: Store<State>
      sessionID: string
      beforeMessageID: string
      limit: number
    }): Promise<{ appended: number }> => {
      const url = new URL(`${sdk.url}/api/v2/session/${input.sessionID}/message`)
      url.searchParams.set("directory", input.directory)
      url.searchParams.set("beforeMessageID", input.beforeMessageID)
      url.searchParams.set("limit", String(input.limit))
      const res = await retry(() => sdk.fetch(url.toString()))
      if (!res.ok) throw new Error(`loadOlder fetch ${res.status}`)
      const raw = (await res.json()) as Array<{ info: Message; parts: Part[] }>
      const incoming = raw.filter((x) => !!x?.info?.id)
      if (incoming.length === 0) return { appended: 0 }
      batch(() => {
        input.setStore(
          "message",
          input.sessionID,
          produce((draft: Message[]) => {
            const known = new Set(draft.map((m) => m?.id))
            for (const item of incoming) {
              const msg = item.info
              if (!msg?.id || known.has(msg.id)) continue
              draft.push(msg)
              known.add(msg.id)
            }
            // id prefix encodes creation time, so id sort is chronological.
            draft.sort((a, b) => cmp(a?.id ?? "", b?.id ?? ""))
          }),
        )
        for (const item of incoming) {
          input.setStore("part", item.info.id, reconcile(sortParts(item.parts), { key: "id" }))
        }
      })
      return { appended: incoming.length }
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
          const forceInput = !!options?.force
          const hasSession = (() => {
            const match = Binary.search(store.session, sessionID, (s) => s.id)
            return match.found
          })()
          const hasMessages = store.message[sessionID] !== undefined
          const hydrated = meta.limit[key] !== undefined
          // mobile-hotfix (2026-04-24): use-session-resume-sync dispatches
          // force:true on every visibility change / pageshow / online /
          // SSE reconnect. On mobile Safari these events fire rapidly
          // (address bar toggle, foreground/background). Each one was
          // retriggering loadMessages full-tail download + re-render,
          // stacking up until the browser killed the tab with "unable to
          // open this page". While the session is already hydrated we
          // keep force-mode only for metadata freshness and let the
          // incremental message path handle the rest — never the full
          // tail refetch that was crashing the tab.
          const force = forceInput && !(hasSession && hasMessages && hydrated)
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

          // specs/frontend-session-lazyload R6: first-time hydration with
          // flag=1 fetches /meta to pick a tighter initial page size. Flag=0
          // takes the legacy limitFor() path unchanged (INV-2).
          let limit: number
          if (hydrated) {
            limit = meta.limit[key] ?? messagePageSize
          } else if (frontendTweaks().frontend_session_lazyload === 1) {
            const metaInfo = await fetchSessionMeta(directory, sessionID)
            if (metaInfo) {
              setMeta("partCount", key, metaInfo.partCount)
              const bucket = pageSizeFor(metaInfo.partCount)
              limit = bucket === "all" ? Math.max(messagePageSize, metaInfo.partCount + 1) : bucket
            } else {
              limit = limitFor(count)
            }
          } else {
            limit = limitFor(count)
          }

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

          // Incremental resync: when force-refreshing a session we already
          // have hydrated, fetch only new messages (tail) instead of
          // re-downloading the whole history. Full loadMessages races
          // against in-flight streaming replies — the point-in-time GET
          // snapshot can predate the still-being-written assistant message
          // and reconcile-wipe its partial parts from the store. The
          // incremental path merges new messages only, leaving the streaming
          // one untouched so SSE deltas keep flowing into it.
          const canUseIncremental = force && hasSession && hasMessages && hydrated
          const messagesReq = canUseIncremental
            ? loadMessagesIncremental({
                directory,
                client,
                setStore,
                store,
                sessionID,
              }).catch(() => {
                // Incremental fetch failed — fall back to full refetch so
                // the user doesn't end up with a missed reply just because
                // the incremental endpoint hiccuped.
                return loadMessages({ directory, client, setStore, sessionID, limit })
              })
            : hasMessages && hydrated && !force
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
          async loadMore(sessionID: string, count?: number) {
            // R9 (frontend-session-lazyload revise 2026-04-22): cursor
            // append. The old path (`currentLimit + count` full refetch)
            // was the whole-slice-refetch anti-pattern INV-9 forbids — it
            // doubled the downloaded payload on each scroll-up and caused
            // the cold-open starvation spike this revise targets.
            if (count === undefined) {
              const cfg = frontendTweaks()
              count = cfg.frontend_session_lazyload === 1 ? cfg.initial_page_size_large : messagePageSize
            }
            const directory = sdk.directory
            const client = sdk.client
            const [store, setStore] = globalSync.child(directory)
            const key = keyFor(directory, sessionID)
            if (meta.loading[key]) return
            if (meta.complete[key]) return
            const existing = store.message[sessionID] ?? []
            if (existing.length === 0) {
              // Cold-start should go through `sync.session.sync` / loadMessages,
              // not through loadMore. Without an anchor cursor there's no
              // "older" to fetch. Treat as no-op rather than silently hitting
              // the tail endpoint (which would duplicate what the page open
              // already did).
              return
            }
            // id prefix encodes creation time, so lexicographically smallest
            // known id is the oldest — the cursor for the next older page.
            let oldest = existing[0]?.id
            for (const msg of existing) {
              if (!msg?.id) continue
              if (!oldest || msg.id < oldest) oldest = msg.id
            }
            if (!oldest) return
            setMeta("loading", key, true)
            try {
              const { appended } = await loadOlderMessages({
                directory,
                client,
                setStore,
                store,
                sessionID,
                beforeMessageID: oldest,
                limit: count,
              })
              // R9: `complete` is now driven by the server returning an
              // empty page (or fewer than requested), NOT by a client-side
              // `currentLimit + count` arithmetic. This survives sessions
              // that gain new older messages via race-y writes.
              if (appended < count) setMeta("complete", key, true)
              setMeta("limit", key, (existing.length + appended))
            } finally {
              setMeta("loading", key, false)
            }
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
