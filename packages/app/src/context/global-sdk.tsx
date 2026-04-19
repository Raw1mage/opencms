import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createEffect, createSignal, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { useWebAuth } from "./web-auth"

export type GlobalConnectionStatus = "connected" | "reconnecting" | "degraded" | "resyncing" | "blocked"

function normalizeDirectoryKey(value: string) {
  if (!value || value === "global") return "global"
  const normalized = value.replaceAll("\\", "/")
  if (normalized === "/") return normalized
  return normalized.replace(/\/+$/, "")
}

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const webAuth = useWebAuth()
    const abort = new AbortController()

    const fetchWithAuth = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => webAuth.authorizedFetch(input, init),
      {
        preconnect: (globalThis.fetch as unknown as { preconnect?: (...args: unknown[]) => unknown }).preconnect,
      },
    ) as typeof fetch

    // ── Auto-heal: prune stored projects that no longer exist on the active server ──
    // Runs once when server.url is set. Queries /api/v2/path (with auth) to get the
    // server's canonical worktree, then removes any stale project entries from the
    // persisted store so the user never needs to clear localStorage manually.
    createEffect(() => {
      const url = server.url
      if (!url) return
      if (webAuth.enabled() && !webAuth.authenticated()) return
      const username = webAuth.session()?.username ?? ""
      void username

      void (async () => {
        try {
          const res = await fetchWithAuth(`${url}/api/v2/path`)
          if (!res.ok) return
          const data = (await res.json()) as { worktree?: string; directory?: string }
          const serverWorktree = data?.worktree ?? data?.directory
          if (!serverWorktree) return

          const currentProjects = server.projects.list()
          const exists = currentProjects.some((p: { worktree: string }) => p.worktree === serverWorktree)
          if (!exists && serverWorktree !== "/") {
            console.info(`[global-sdk] Auto-healing: ensuring server worktree ${serverWorktree} is open.`)
            server.projects.open(serverWorktree)
          }
        } catch {
          // Non-critical cleanup — ignore errors
        }
      })()
    })

    const eventFetch = (() => {
      if (!platform.fetch) return
      try {
        const url = new URL(server.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const streamFetch = eventFetch ?? fetchWithAuth

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()
    const [reconnectVersion, setReconnectVersion] = createSignal(0)
    const [connectionStatus, setConnectionStatus] = createSignal<GlobalConnectionStatus>("connected")

    type Queued = { directory: string; payload: Event }
    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8
    const RECONNECT_DELAY_MS = 250

    let queue: Queued[] = []
    let buffer: Queued[] = []
    const coalesced = new Map<string, number>()
    const staleDeltas = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        // Delta-aware: when the event carries a delta (text stripped), each event
        // is append-only and must NOT be coalesced — dropping intermediate deltas
        // loses text. Only coalesce full-part updates (no delta field).
        if ((payload.properties as any).delta) return undefined
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = queue
      const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()
      staleDeltas.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          const payload = event.payload as { type?: string; properties?: { messageID?: string; partID?: string } }
          if (skip && payload.type === "message.part.delta") {
            const props = payload.properties
            if (!props?.messageID || !props?.partID) continue
            if (skip.has(deltaKey(event.directory, props.messageID, props.partID))) continue
          }
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
    }

    let streamErrorLogged = false
    let streamEstablished = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const shouldConnectEventStream = () => {
      if (!webAuth.enabled()) return true
      return webAuth.authenticated()
    }
    const isUnauthorized = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes("401") || message.toLowerCase().includes("unauthorized")
    }

    const reconnect = (reason: string) => {
      if (abort.signal.aborted) return
      streamErrorLogged = false
      setConnectionStatus((value) => (value === "resyncing" ? value : "resyncing"))
      console.info("[global-sdk] reconnecting event stream", { reason, url: server.url })
      setReconnectVersion((value) => value + 1)
    }
    const setDegraded = () => {
      if (abort.signal.aborted) return
      setConnectionStatus((value) => (value === "degraded" ? value : "degraded"))
    }
    const setBlocked = () => {
      if (abort.signal.aborted) return
      setConnectionStatus((value) => (value === "blocked" ? value : "blocked"))
    }
    const setReconnecting = () => {
      if (abort.signal.aborted) return
      setConnectionStatus((value) => (value === "reconnecting" ? value : "reconnecting"))
    }
    const setConnected = () => {
      if (abort.signal.aborted) return
      streamEstablished = true
      setConnectionStatus((value) => (value === "connected" ? value : "connected"))
    }

    createEffect(() => {
      reconnectVersion()
      const streamAbort = new AbortController()
      const signal = AbortSignal.any([abort.signal, streamAbort.signal])
      const loopSdk = createOpencodeClient({
        baseUrl: server.url,
        signal,
        fetch: streamFetch,
      })

      void (async () => {
        let backoff = RECONNECT_DELAY_MS

        while (!signal.aborted) {
          if (!shouldConnectEventStream()) {
            streamErrorLogged = false
            setBlocked()
            await wait(RECONNECT_DELAY_MS)
            continue
          }

          if (connectionStatus() !== "resyncing" && (streamEstablished || connectionStatus() !== "connected")) {
            setReconnecting()
          }

          try {
            const events = await loopSdk.global.event({
              onSseError: (error) => {
                if (signal.aborted) return
                if (error instanceof Error && error.name === "AbortError") return
                if ((error as DOMException)?.name === "AbortError") return
                if (isUnauthorized(error) && webAuth.enabled() && !webAuth.authenticated()) return
                if (streamErrorLogged) return
                streamErrorLogged = true
                setDegraded()
                console.error("[global-sdk] event stream error", {
                  url: server.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                })
              },
            })
            setConnected()
            let yielded = Date.now()
            for await (const event of events.stream) {
              backoff = RECONNECT_DELAY_MS
              streamErrorLogged = false
              setConnected()
              const directory = normalizeDirectoryKey(event.directory ?? "global")
              const payload = event.payload
              const k = key(directory, payload)
              if (k) {
                const i = coalesced.get(k)
                if (i !== undefined) {
                  queue[i] = { directory, payload }
                  if (payload.type === "message.part.updated") {
                    const part = payload.properties.part
                    staleDeltas.add(deltaKey(directory, part.messageID, part.id))
                  }
                  continue
                }
                coalesced.set(k, queue.length)
              }
              queue.push({ directory, payload })
              schedule()

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
            if (!signal.aborted && streamEstablished) {
              setDegraded()
            }
          } catch (error) {
            if (signal.aborted) return
            if (error instanceof Error && error.name === "AbortError") return
            if ((error as DOMException)?.name === "AbortError") return

            if (isUnauthorized(error) && webAuth.enabled() && !webAuth.authenticated()) {
              setBlocked()
              await wait(RECONNECT_DELAY_MS)
              continue
            }
            if (!streamErrorLogged) {
              streamErrorLogged = true
              setDegraded()
              console.error("[global-sdk] event stream failed", {
                url: server.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            }
          }

          if (signal.aborted) return
          await wait(backoff)
          backoff = Math.min(backoff * 2, 10000)
        }
      })().finally(flush)

      onCleanup(() => {
        streamAbort.abort()
      })
    })

    const onVisibility = () => {
      if (document.hidden) return
      reconnect("visibilitychange")
    }
    const onPageShow = () => reconnect("pageshow")
    const onOnline = () => reconnect("online")

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
    window.addEventListener("online", onOnline)

    onCleanup(() => {
      abort.abort()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
      window.removeEventListener("online", onOnline)
      flush()
    })

    const sdk = createOpencodeClient({
      baseUrl: server.url,
      fetch: fetchWithAuth,
      throwOnError: true,
    })

    return { url: server.url, client: sdk, event: emitter, fetch: fetchWithAuth, connectionStatus }
  },
})
