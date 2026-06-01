import { Bus } from "@/bus"
import { Event as ServerEvent } from "@/server/event"
import { Log } from "@/util/log"
import { Session } from "@/session"

const log = Log.create({ service: "session-storage-watch" })

const SESSION_REFRESH_DEBOUNCE_MS = 150

let started = false
let pending: ReturnType<typeof setTimeout> | undefined

// Retained for the unit test + as the documented definition of what counts as
// a session-catalog mutation. No longer used to gate a filesystem watcher
// (see ensureSessionStorageWatch below).
export function isSessionCatalogMutation(eventType: string, filename?: string | null): boolean {
  if (eventType !== "rename") return false
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

  // RCA 2026-06-01: this previously did `fs.watch(storage/session)` to detect
  // session-catalog changes. Bun's node:fs.watch on a directory opens a file
  // descriptor for EVERY entry in that directory and holds them for the
  // watcher's lifetime. With one .db + -wal + -shm per session (plus legacy
  // subdirs) and sessions accumulating unbounded, the daemon leaked ~3 fds per
  // session (thousands of held fds + their page-cache memory) on every boot —
  // the daemon's growing memory baseline. Verified: a compiled `watch(dir)` on
  // the real session dir held ~7000 fds after ~1s.
  //
  // Fix: the daemon already knows when a session is created or deleted, so we
  // drive the catalog-refresh event off in-process Session lifecycle events
  // instead of watching the filesystem. Zero fd cost.
  //
  // Tradeoff: external / cross-process mutations of the session directory no
  // longer trigger a refresh. Acceptable under the single-daemon-per-user
  // model (only this daemon writes the session catalog).
  Bus.subscribe(Session.Event.Created, () => scheduleRefresh())
  Bus.subscribe(Session.Event.Deleted, () => scheduleRefresh())
}
