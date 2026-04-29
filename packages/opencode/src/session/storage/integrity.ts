// IntegrityChecker — runs PRAGMA integrity_check exactly once per
// (connection lifetime, sessionID) and caches the verdict.
//
// Spec: /specs/session-storage-db, task 2.3 (DD-7 / DR-3 / INV-3).
//
// Behavior contract:
//   - run(db, sessionID) returns "ok" or the verbose verdict string.
//   - On non-"ok" verdict: publishes session.storage.corrupted Bus event
//     and throws StorageCorruptionError. Caller (SqliteStore) refuses to
//     load the session.
//   - Result is cached per Database handle; subsequent calls on the same
//     handle skip the work.
//   - Cache is invalidated when the connection is closed/evicted by Pool.
//   - DD-13: never silently fall back to legacy on corruption — the throw
//     is the only honest path.

import type { Database } from "bun:sqlite"

import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Log } from "@/util/log"

import { SessionStorageEvent } from "./events"

const log = Log.create({ service: "session.storage.integrity" })

export const StorageCorruptionError = NamedError.create(
  "StorageCorruptionError",
  z.object({
    sessionID: z.string(),
    integrityCheckOutput: z.string(),
    dbPath: z.string(),
  }),
)

const cache = new WeakMap<Database, "ok">()

/**
 * Run integrity_check on the database. Caches "ok" verdict per handle.
 * Throws StorageCorruptionError on failure (after publishing Bus event).
 */
export async function runIntegrityCheck(
  db: Database,
  sessionID: string,
  dbPath: string,
): Promise<void> {
  if (cache.get(db) === "ok") return

  // PRAGMA integrity_check returns one row per problem; on a healthy DB
  // it returns a single row with value "ok".
  const rows = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>
  const verdict = rows
    .map((r) => r.integrity_check)
    .filter((v): v is string => typeof v === "string")
    .join("\n")
    .trim()

  if (verdict === "ok") {
    cache.set(db, "ok")
    return
  }

  log.error("integrity check failed", { sessionID, verdict })

  await Bus.publish(SessionStorageEvent.Corrupted, {
    sessionID,
    integrityCheckOutput: verdict,
    dbPath,
    timestamp: Date.now(),
  }).catch(() => {})

  throw new StorageCorruptionError({
    sessionID,
    integrityCheckOutput: verdict,
    dbPath,
  })
}

/**
 * Force-run integrity check ignoring the cache. Used by `session-inspect
 * check` (DD-12) and any explicit user-driven recovery flow.
 */
export async function runIntegrityCheckUncached(
  db: Database,
  sessionID: string,
  dbPath: string,
): Promise<string> {
  cache.delete(db)
  try {
    await runIntegrityCheck(db, sessionID, dbPath)
    return "ok"
  } catch (e) {
    if (StorageCorruptionError.isInstance(e)) return e.data.integrityCheckOutput
    throw e
  }
}
