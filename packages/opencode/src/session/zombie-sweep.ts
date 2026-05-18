// Recovery for messages whose runtime was killed mid-stream or whose tool
// calls hung indefinitely (e.g. daemon SIGTERM, MCP transport stall, TCP
// hang on read_subsession). Without this sweep, the message row stays at
// finish=NULL / time_completed=NULL forever and the frontend spinner spins
// on a corpse.
//
// Two entry points:
//   sweep()       — full scan of every session DB; runs once at boot.
//   sweepRecent() — lightweight scan of recently-modified DBs only; safe
//                   to call on a periodic timer (every 2–5 min).

import { Database } from "bun:sqlite"
import { Glob } from "bun"
import fs from "fs"
import path from "path"

import { Global } from "@/global"
import { Log } from "@/util/log"
import { listActiveSessionIDs } from "@/session/prompt-runtime"

const log = Log.create({ service: "session.zombie-sweep" })

// A message older than this with no finish state is considered orphaned.
// Anything younger could legitimately still be in flight on a slow tool.
const STALE_THRESHOLD_MS = 60_000

// For sweepRecent: only check DBs whose mtime is within this window.
const RECENT_WINDOW_MS = 10 * 60_000

export namespace ZombieSweep {
  export interface Result {
    scanned: number
    stamped: number
    partsStamped: number
  }

  /** Scan a single session DB and reap zombies. */
  function sweepOneDb(dbPath: string, cutoff: number, now: number): { stamped: number; partsStamped: number } {
    let stamped = 0
    let partsStamped = 0
    let db: Database | undefined
    try {
      db = new Database(dbPath)
      db.exec("PRAGMA journal_mode = WAL")

      // 1. Stamp zombie messages (no finish, no completion, older than cutoff).
      const result = db
        .prepare(
          "UPDATE messages SET finish = 'error', time_completed = $now " +
            "WHERE finish IS NULL AND time_completed IS NULL AND time_created < $cutoff",
        )
        .run({ $now: now, $cutoff: cutoff })
      const changes = (result as { changes?: number }).changes ?? 0
      if (changes > 0) {
        stamped += changes
        log.info("stamped zombie messages", {
          session: path.basename(dbPath, ".db"),
          count: changes,
        })
      }

      // 2. Reap orphaned tool parts: any tool part with status "running"
      //    belonging to a message that is no longer in-flight (has finish
      //    set or time_completed set) is a zombie.
      const orphanParts = db
        .prepare(
          `SELECT p.id, p.payload_json FROM parts p
           JOIN messages m ON p.message_id = m.id
           WHERE p.type = 'tool'
             AND (m.finish IS NOT NULL OR m.time_completed IS NOT NULL)
             AND p.payload_json LIKE '%"status":"running"%'`,
        )
        .all() as { id: string; payload_json: string }[]

      if (orphanParts.length > 0) {
        const update = db.prepare("UPDATE parts SET payload_json = $json WHERE id = $id")
        for (const row of orphanParts) {
          try {
            const payload = JSON.parse(row.payload_json)
            payload.state = {
              ...payload.state,
              status: "error",
              error: "Tool call interrupted: daemon restarted while in-flight.",
            }
            update.run({ $json: JSON.stringify(payload), $id: row.id })
            partsStamped++
          } catch {
            // Malformed JSON — skip
          }
        }
        log.info("stamped zombie tool parts", {
          session: path.basename(dbPath, ".db"),
          count: orphanParts.length,
        })
      }
    } finally {
      try {
        db?.close()
      } catch {}
    }
    return { stamped, partsStamped }
  }

  /** Full boot-time scan: every session DB. */
  export async function sweep(): Promise<Result> {
    const dir = path.join(Global.Path.data, "storage", "session")
    const cutoff = Date.now() - STALE_THRESHOLD_MS
    const now = Date.now()
    let scanned = 0
    let stamped = 0
    let partsStamped = 0

    const glob = new Glob("*.db")
    for await (const entry of glob.scan({ cwd: dir, absolute: true })) {
      scanned++
      try {
        const r = sweepOneDb(entry, cutoff, now)
        stamped += r.stamped
        partsStamped += r.partsStamped
      } catch (err) {
        log.warn("zombie sweep failed for session", {
          dbPath: entry,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { scanned, stamped, partsStamped }
  }

  /**
   * Lightweight periodic sweep: only check session DBs whose file was
   * modified within the last RECENT_WINDOW_MS. Keeps the scan to a
   * handful of DBs instead of the full archive.
   *
   * CRITICAL: skip sessions that have an active runtime — their messages
   * and tool parts are legitimately in-flight, not zombies.
   */
  export async function sweepRecent(): Promise<Result> {
    const dir = path.join(Global.Path.data, "storage", "session")
    const cutoff = Date.now() - STALE_THRESHOLD_MS
    const now = Date.now()
    const recentCutoff = now - RECENT_WINDOW_MS
    let scanned = 0
    let stamped = 0
    let partsStamped = 0

    // Sessions with a live runloop must not be swept.
    const liveSessionIDs = new Set(listActiveSessionIDs())

    const glob = new Glob("*.db")
    for await (const entry of glob.scan({ cwd: dir, absolute: true })) {
      const sessionID = path.basename(entry, ".db")
      if (liveSessionIDs.has(sessionID)) continue

      try {
        const stat = fs.statSync(entry)
        if (stat.mtimeMs < recentCutoff) continue
      } catch {
        continue
      }
      scanned++
      try {
        const r = sweepOneDb(entry, cutoff, now)
        stamped += r.stamped
        partsStamped += r.partsStamped
      } catch (err) {
        log.warn("zombie sweep (recent) failed for session", {
          dbPath: entry,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { scanned, stamped, partsStamped }
  }
}
