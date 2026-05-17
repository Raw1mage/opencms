// Boot-time recovery for messages whose runtime was killed mid-stream
// (e.g. daemon SIGTERM'd by webctl restart while an LLM stream was open
// or a tool call was in progress). Without this sweep, the message row
// stays at finish=NULL / time_completed=NULL forever and the frontend
// spinner spins on a corpse. Stamp them as finish='error' at boot so
// the UI exits the spinning state on next session view.

import { Database } from "bun:sqlite"
import { Glob } from "bun"
import path from "path"

import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "session.zombie-sweep" })

// A message older than this with no finish state is considered orphaned.
// Anything younger could legitimately still be in flight on a slow tool.
const STALE_THRESHOLD_MS = 60_000

export namespace ZombieSweep {
  export interface Result {
    scanned: number
    stamped: number
    partsStamped: number
  }

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
      let db: Database | undefined
      try {
        db = new Database(entry)
        db.exec("PRAGMA journal_mode = WAL")
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
            session: path.basename(entry, ".db"),
            count: changes,
          })
        }

        // Reap orphaned tool parts: any tool part with status "running"
        // belonging to a message that is no longer in-flight (has finish set
        // or time_completed set) is a zombie — its execute() promise died
        // with the old daemon process.
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
            session: path.basename(entry, ".db"),
            count: orphanParts.length,
          })
        }
      } catch (err) {
        log.warn("zombie sweep failed for session", {
          dbPath: entry,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        try {
          db?.close()
        } catch {}
      }
    }
    return { scanned, stamped, partsStamped }
  }
}
