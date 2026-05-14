import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createEffect, createSignal, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { useWebAuth } from "./web-auth"

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

    // Removed 2026-05-03: this effect used to auto-open the server's
    // canonical worktree as a sidebar tab on every page load. Two
    // problems with that: (a) when the server's CWD is a parent dir
    // like `~/projects`, it pollutes the sidebar with a non-project
    // tab on every reload; (b) opening tabs is a user gesture, not
    // something the runtime should do unilaterally. If a tab needs to
    // be there, the user (or a deliberate flow) opens it.

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

    type Queued = { directory: string; payload: Event }
    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8
    const RECONNECT_DELAY_MS = 250
    // A connection must stay open this long with at least one event received
    // before we trust it enough to reset the reconnect backoff. Below this
    // threshold the stream is treated as a flap and backoff continues to grow
    // exponentially toward its 10s cap. (frontend/resync T1.4.2, DD-10)
    const CONNECTION_STABLE_MS = 3_000
    // verifyChannel() considers SSE "fresh" if an event arrived within this
    // window. Tuned to be larger than typical streaming inter-event gaps
    // (~100-500ms) but smaller than typical idle gaps. (frontend/resync T1.1.1)
    const SSE_FRESHNESS_MS = 5_000
    // verifyChannel() default timeout — caller may override.
    const SSE_VERIFY_TIMEOUT_MS = 2_000

    let queue: Queued[] = []
    let buffer: Queued[] = []
    const coalesced = new Map<string, number>()
    const recentlySeen = new Map<string, number>()
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
      const now = Date.now()
      for (const [eventKey, seenAt] of recentlySeen) {
        if (now - seenAt > 2_000) recentlySeen.delete(eventKey)
      }
      staleDeltas.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          const payload = event.payload as { type?: string; properties?: { messageID?: string; partID?: string } }
          const eventKey = key(event.directory, event.payload)
          if (eventKey) recentlySeen.set(eventKey, now)
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
    // Timestamp of the last received SSE event (wall-clock ms). 0 = never yet.
    // Used by submit.ts to detect silently-dead SSE before sending a prompt:
    // if the stream is stale (no heartbeat or event within N seconds), force
    // a reconnect before the POST so the reply's inbound path is alive.
    // Server writes `server.heartbeat` every 30s, so a gap > ~30s with nothing
    // means the downstream proxy has dropped the stream (NAT/idle timeout).
    let lastEventAt = 0
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
      console.info("[global-sdk] reconnecting event stream", { reason, url: server.url })
      setReconnectVersion((value) => value + 1)
    }

    // Resolves when the next SSE event arrives, or rejects when the provided
    // signal aborts. Used by verifyChannel() to race against a timeout. The
    // listener is a one-shot — emitter.listen returns an unsubscribe fn we
    // call from both resolve and abort paths to avoid leaks.
    const waitForFirstEvent = (signal: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"))
          return
        }
        let unsubscribe: (() => void) | undefined
        const onAbort = () => {
          unsubscribe?.()
          reject(new DOMException("aborted", "AbortError"))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        unsubscribe = emitter.listen(() => {
          signal.removeEventListener("abort", onAbort)
          unsubscribe?.()
          resolve()
        })
      })

    // verifyChannel — Channel-ownership API. Callers ("client" surfaces:
    // submit handler, permission approve, session switch, etc.) invoke this
    // before any mutating action that expects a server reply. Contract:
    //   - Never throws. Always resolves with VerifyChannelResult.
    //   - If lastEventAt is within SSE_FRESHNESS_MS, return alive immediately.
    //   - Otherwise force a reconnect and race the first new event against
    //     the caller-provided timeout (default SSE_VERIFY_TIMEOUT_MS = 2s).
    //   - Caller MAY observe `timedOut: true` but MUST NOT block on this
    //     result — active polling is the correctness floor (frontend/resync
    //     DD-3, DD-4; spec.md AC-2).
    type VerifyChannelResult = { alive: boolean; rebuilt: boolean; timedOut: boolean }
    const verifyChannel = async (opts?: { timeoutMs?: number }): Promise<VerifyChannelResult> => {
      const timeoutMs = opts?.timeoutMs ?? SSE_VERIFY_TIMEOUT_MS
      try {
        // Fresh path: SSE delivered an event recently enough that we trust
        // the channel without forcing a reconnect.
        if (lastEventAt > 0 && Date.now() - lastEventAt < SSE_FRESHNESS_MS) {
          return { alive: true, rebuilt: false, timedOut: false }
        }
        // Stale path: rebuild and race against timeout.
        reconnect("verify-channel")
        const raceAbort = new AbortController()
        const timer = setTimeout(() => raceAbort.abort(), timeoutMs)
        try {
          await waitForFirstEvent(raceAbort.signal)
          return { alive: true, rebuilt: true, timedOut: false }
        } catch (raceErr) {
          // AbortError from raceAbort timeout fires here. Any other error
          // (shouldn't happen) is treated as timeout too — never throw.
          return { alive: false, rebuilt: true, timedOut: true }
        } finally {
          clearTimeout(timer)
        }
      } catch (outerErr) {
        // Belt-and-suspenders: any unexpected throw (synchronous reconnect
        // failure, etc.) still returns a sane result instead of throwing.
        // (frontend/resync errors.md E1)
        console.warn("[global-sdk] verifyChannel hit unexpected error", { error: outerErr })
        return { alive: false, rebuilt: true, timedOut: true }
      }
    }

    // Counts successful SSE stream opens for this provider instance. The
    // FIRST open is the initial load; subsequent opens mean the stream had
    // dropped (daemon restart, network hiccup, Cloudflare keepalive) and
    // auto-reconnected. On every non-first open we broadcast a window event
    // so useSessionResumeSync / other listeners can force-refetch their data.
    // Without this signal, clients miss events fired while the stream was
    // disconnected and the UI silently goes stale until the next
    // visibilitychange / pageshow / online.
    let streamOpenCount = 0

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
            await wait(RECONNECT_DELAY_MS)
            continue
          }

          // Hoisted across try/catch so the post-iteration backoff decision
          // applies symmetrically to clean-end and error-end paths. Connection
          // is "stable" if it stayed open ≥ CONNECTION_STABLE_MS and received
          // at least one event (frontend/resync T1.4.2).
          let eventsThisConnection = 0
          const connectionOpenedAt = Date.now()
          try {
            const events = await loopSdk.global.event({
              onSseError: (error) => {
                if (signal.aborted) return
                if (error instanceof Error && error.name === "AbortError") return
                if ((error as DOMException)?.name === "AbortError") return
                if (isUnauthorized(error) && webAuth.enabled() && !webAuth.authenticated()) return
                if (streamErrorLogged) return
                streamErrorLogged = true
                console.error("[global-sdk] event stream error", {
                  url: server.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                })
              },
            })
            const previousEventAt = lastEventAt
            streamOpenCount += 1
            lastEventAt = Date.now()
            if (streamOpenCount > 1 && typeof window !== "undefined") {
              const gapMs = previousEventAt === 0 ? 0 : Date.now() - previousEventAt
              console.info("[global-sdk] event stream reconnected — dispatching resync", {
                url: server.url,
                openCount: streamOpenCount,
                gapMs,
              })
              // Always resync on reconnect. Even short gaps can miss events
              // when the daemon restarted (new process, no event replay).
              // P2 active poll (viewing-session-resync) is merge-safe with
              // in-flight streaming (DD-4, DD-6), so no race concern.
              window.dispatchEvent(new CustomEvent("opencode:viewing-session-resync", {
                detail: { reason: "sse-reconnect" },
              }))
              // Legacy event retained for consumers not yet migrated to P2.
              const SSE_LONG_OUTAGE_THRESHOLD_MS = 30_000
              if (gapMs > SSE_LONG_OUTAGE_THRESHOLD_MS) {
                window.dispatchEvent(new CustomEvent("opencode:sse_reconnect"))
              }
            }
            let yielded = Date.now()
            for await (const event of events.stream) {
              lastEventAt = Date.now()
              eventsThisConnection += 1
              streamErrorLogged = false
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
                const seenAt = recentlySeen.get(k)
                if (seenAt !== undefined && Date.now() - seenAt < 2_000) continue
                coalesced.set(k, queue.length)
              }
              queue.push({ directory, payload })
              schedule()

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
            // Clean exit: server / proxy closed the stream without throwing.
            // Distinct log message from the error path so flap-storm vs real
            // failure are diagnosable (frontend/resync T1.4.3).
            console.info("[global-sdk] event stream ended cleanly", {
              url: server.url,
              eventsThisConnection,
              connectionAgeMs: Date.now() - connectionOpenedAt,
              currentBackoffMs: backoff,
            })
          } catch (error) {
            if (signal.aborted) return
            if (error instanceof Error && error.name === "AbortError") return
            if ((error as DOMException)?.name === "AbortError") return

            if (isUnauthorized(error) && webAuth.enabled() && !webAuth.authenticated()) {
              await wait(RECONNECT_DELAY_MS)
              continue
            }
            if (!streamErrorLogged) {
              streamErrorLogged = true
              console.error("[global-sdk] event stream failed", {
                url: server.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            }
          }

          if (signal.aborted) return

          // Reset backoff only when the connection was stable enough to trust
          // (≥ CONNECTION_STABLE_MS uptime + at least one event). This guards
          // against flap storms where a connection FIN-ed within a few hundred
          // ms keeps re-spawning at the minimum backoff (frontend/resync DD-10,
          // errors.md E6). Either end path (clean / error) reaches here.
          if (eventsThisConnection > 0 && Date.now() - connectionOpenedAt > CONNECTION_STABLE_MS) {
            backoff = RECONNECT_DELAY_MS
          }

          await wait(backoff)
          backoff = Math.min(backoff * 2, 10000)
        }
      })().finally(flush)

      onCleanup(() => {
        streamAbort.abort()
      })
    })

    // Lifecycle handlers dispatch `opencode:viewing-session-resync` so the
    // currently-viewing session view can pull a fresh snapshot independently
    // of SSE. Client owns the channel — we don't wait for server to push
    // anything. (frontend/resync P2, AC-5)
    const dispatchViewingResync = (reason: string) => {
      if (typeof window === "undefined") return
      window.dispatchEvent(
        new CustomEvent("opencode:viewing-session-resync", { detail: { reason } }),
      )
    }
    const onVisibility = () => {
      if (document.hidden) return
      reconnect("visibilitychange")
      dispatchViewingResync("visibilitychange")
    }
    // pageshow fires on every show including initial page load. We only need
    // to force-reconnect when it's a bfcache restore (event.persisted = true);
    // a normal initial load already opened a fresh stream and reconnecting
    // immediately just produces a noisy 65ms-gap "short flap" in the log.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        reconnect("pageshow-bfcache")
        dispatchViewingResync("pageshow-bfcache")
      }
    }
    const onOnline = () => {
      reconnect("online")
      dispatchViewingResync("online")
    }

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

    return {
      url: server.url,
      client: sdk,
      event: emitter,
      fetch: fetchWithAuth,
      // SSE liveness probe for callers (e.g. prompt submit) that want to
      // verify the inbound channel is fresh before doing something that
      // expects a server reply. Returns 0 if the stream has never produced
      // an event for this session; otherwise the wall-clock ms of the last
      // one.
      lastEventAt: () => lastEventAt,
      // Trigger a fresh SSE connection. Safe to call at any time — the
      // existing stream is aborted, a new HTTP GET /global/event is made.
      // Same mechanism as the auto-reconnect loop, just user-initiated.
      forceSseReconnect: (reason: string) => reconnect(reason),
      // verifyChannel — verify-or-rebuild SSE channel. Never throws. Use
      // before any mutating action that expects a server reply (submit,
      // permission approve, abort, etc.). See frontend/resync DD-1/DD-2/DD-3.
      verifyChannel,
    }
  },
})
