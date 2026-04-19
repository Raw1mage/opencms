import type { SessionMonitorInfo } from "@opencode-ai/sdk/v2/client"
import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { useGlobalSDK } from "@/context/global-sdk"

const ACTIVE_FALLBACK_MS = 15_000
const IDLE_FALLBACK_MS = 90_000
const MIN_REFRESH_MS = 6_000
const EVENT_DEBOUNCE_MS = 500
const MAX_MESSAGES = 80

const activeStatuses = new Set(["busy", "working", "retry", "compacting", "pending"])

function sanitizeMonitorError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  // SDK throws raw HTML string on non-JSON error responses (e.g. 504 gateway pages).
  // Detect and replace with a short message to avoid flooding the UI.
  if (raw.length > 300 || /^\s*<!DOCTYPE/i.test(raw) || /^\s*<html/i.test(raw)) {
    const status = raw.match(/\b(5\d{2}|4\d{2})\b/)?.[1]
    return status ? `Server error (${status})` : "Server error"
  }
  return raw
}

export function useStatusMonitor(input: {
  enabled: () => boolean
  sessionID: () => string | undefined
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
}) {
  const globalSDK = useGlobalSDK()
  const [monitor, setMonitor] = createStore({
    items: [] as SessionMonitorInfo[],
    loading: false,
    initialized: false,
    error: undefined as string | undefined,
  })

  createEffect(() => {
    if (!input.enabled()) return
    const sessionID = input.sessionID()
    if (!sessionID) {
      setMonitor({ items: [], loading: false, initialized: false, error: undefined })
      return
    }

    let cancelled = false
    let inFlight = false
    let lastFetchedAt = 0
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    const isBusy = () => {
      const status = input.sync.data.session_status[sessionID]
      return !!status && activeStatuses.has(status.type)
    }

    const isVisible = () => !document.hidden

    const clearTimers = () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      if (pollTimer) clearTimeout(pollTimer)
      refreshTimer = undefined
      pollTimer = undefined
    }

    const scheduleFallback = () => {
      if (cancelled) return
      if (!input.enabled() || input.sessionID() !== sessionID) return
      if (!isVisible()) return
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = setTimeout(
        () => {
          void refresh(false)
        },
        isBusy() ? ACTIVE_FALLBACK_MS : IDLE_FALLBACK_MS,
      )
    }

    const refresh = async (force: boolean) => {
      if (cancelled || inFlight) return
      if (!input.enabled() || input.sessionID() !== sessionID) return
      if (!isVisible()) return
      const now = Date.now()
      if (!force && now - lastFetchedAt < MIN_REFRESH_MS) {
        scheduleFallback()
        return
      }

      inFlight = true
      if (!monitor.initialized) setMonitor("loading", true)
      try {
        const result = await input.sdk.client.session.top({
          sessionID,
          includeDescendants: true,
          maxMessages: MAX_MESSAGES,
        })
        if (cancelled) return
        setMonitor({
          items: result.data ?? [],
          loading: false,
          initialized: true,
          error: undefined,
        })
        lastFetchedAt = Date.now()
      } catch (error) {
        if (cancelled) return
        setMonitor({
          items: monitor.items,
          loading: false,
          initialized: true,
          error: sanitizeMonitorError(error),
        })
      } finally {
        inFlight = false
        scheduleFallback()
      }
    }

    const requestRefresh = (delay: number, force = false) => {
      if (cancelled) return
      if (!input.enabled() || input.sessionID() !== sessionID) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        void refresh(force)
      }, delay)
    }

    const stop = input.sdk.event.listen((e) => {
      const event = e.details as { type: string; properties?: any }
      if (cancelled) return
      if (!input.enabled() || input.sessionID() !== sessionID) return

      if (event.type === "session.status" && event.properties?.sessionID === sessionID) {
        requestRefresh(event.properties?.status?.type === "idle" ? 0 : EVENT_DEBOUNCE_MS, true)
        return
      }

      const monitorRelevant =
        event.type === "session.updated" ||
        event.type === "session.created" ||
        event.type === "session.deleted" ||
        event.type === "session.diff" ||
        (event.type === "message.part.updated" && event.properties?.part?.type === "tool") ||
        event.type === "message.part.removed"

      if (!monitorRelevant) return
      const immediate = event.type === "message.part.updated" || event.type === "message.part.removed"
      requestRefresh(immediate ? 0 : EVENT_DEBOUNCE_MS, immediate)
    })

    const onVisibility = () => {
      if (document.hidden) {
        if (pollTimer) clearTimeout(pollTimer)
        return
      }
      requestRefresh(0, true)
    }
    document.addEventListener("visibilitychange", onVisibility)

    let lastConnectionStatus = globalSDK.connectionStatus()
    createEffect(() => {
      const status = globalSDK.connectionStatus()
      const previous = lastConnectionStatus
      lastConnectionStatus = status
      if (status === previous) return
      if (status === "connected" && previous !== "connected") {
        requestRefresh(0, true)
      }
    })

    void refresh(true)

    onCleanup(() => {
      cancelled = true
      clearTimers()
      document.removeEventListener("visibilitychange", onVisibility)
      stop()
    })
  })

  return monitor
}
