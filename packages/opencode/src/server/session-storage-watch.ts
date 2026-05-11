import path from "path"
import { watch } from "node:fs"
import { Bus } from "@/bus"
import { Global } from "@/global"
import { Event as ServerEvent } from "@/server/event"
import { Log } from "@/util/log"

const log = Log.create({ service: "session-storage-watch" })

const SESSION_REFRESH_DEBOUNCE_MS = 150

let started = false
let pending: ReturnType<typeof setTimeout> | undefined

export function isSessionCatalogMutation(filename?: string | null): boolean {
  if (!filename) return false
  return filename.startsWith("ses_")
}

function scheduleRefresh() {
  if (pending) return
  pending = setTimeout(() => {
    pending = undefined
    void Bus.publish(ServerEvent.Disposed, {}, { directory: "global" }).catch((error) => {
      log.warn("failed to publish session catalog refresh", { error })
    })
  }, SESSION_REFRESH_DEBOUNCE_MS)
}

export function ensureSessionStorageWatch() {
  if (started) return
  started = true

  if (process.env.NODE_ENV === "test") return

  const sessionDir = path.join(Global.Path.data, "storage", "session")
  try {
    const watcher = watch(sessionDir, (_eventType, filename) => {
      if (!isSessionCatalogMutation(filename)) return
      scheduleRefresh()
    })
    watcher.on("error", (error) => {
      log.warn("session storage watch error", { error, sessionDir })
    })
  } catch (error) {
    log.warn("failed to start session storage watch", { error, sessionDir })
  }
}
