import { createEffect, onCleanup } from "solid-js"
import type { useSync } from "@/context/sync"

const activeStatuses = new Set(["busy", "working", "retry", "compacting", "pending"])

function shouldForceResumeSync(input: { sync: ReturnType<typeof useSync>; sessionID: string }) {
  const session = input.sync.session.get(input.sessionID)
  if (!session) return true

  const status = input.sync.data.session_status[input.sessionID]
  if (status && activeStatuses.has(status.type)) return true

  const messages = input.sync.data.message[input.sessionID]
  if (!messages || messages.length === 0) return true

  const last = messages.at(-1)
  if (!last) return true
  if (last.role === "user") return true

  return false
}

export function useSessionResumeSync(input: {
  enabled: () => boolean
  sessionID: () => string | undefined
  sync: ReturnType<typeof useSync>
}) {
  createEffect(() => {
    if (!input.enabled()) return
    const sessionID = input.sessionID()
    if (!sessionID) return

    let hiddenAt = 0

    const resume = (reason: "resume" | "pageshow" | "online") => {
      if (!input.enabled() || input.sessionID() !== sessionID) return
      const force =
        reason === "online" ||
        reason === "pageshow" ||
        (hiddenAt !== 0 && Date.now() - hiddenAt >= 1500) ||
        shouldForceResumeSync({ sync: input.sync, sessionID })
      void input.sync.session.sync(sessionID, force ? { force: true } : undefined)
    }

    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      resume("resume")
    }
    const onPageShow = () => resume("pageshow")
    const onOnline = () => resume("online")
    // Daemon-restart / SSE-drop recovery: global-sdk dispatches this custom
    // event whenever its event stream reopens after the first successful
    // open. Without this, events fired while the stream was disconnected
    // (e.g. new messages produced during a daemon restart or a proxy
    // keepalive drop) are lost and the UI silently stays stale until the
    // user triggers visibility/pageshow/online naturally.
    const onSseReconnect = () => resume("online")

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pageshow", onPageShow)
    window.addEventListener("online", onOnline)
    window.addEventListener("opencode:sse_reconnect", onSseReconnect)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
      window.removeEventListener("online", onOnline)
      window.removeEventListener("opencode:sse_reconnect", onSseReconnect)
    })
  })
}
