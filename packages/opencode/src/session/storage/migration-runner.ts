// MigrationRunner — schema version manager.
//
// Spec: /specs/session-storage-db, task 2.4 (DD-7 / DR-5 / INV-8).
//
// Behavior contract:
//   - Reads `PRAGMA user_version` to detect schema state.
//     0 = fresh database; bootstrap to v1. >0 = existing; check vs target.
//   - For each forward step (vN → vN+1) wraps the migration SQL in a
//     transaction. Failure → ROLLBACK, leave DB at vN, publish Bus event,
//     throw SchemaMigrationFailedError. Caller opens read-only.
//   - Refuses to load a DB with user_version > target (SchemaVersionTooNewError).
//   - INV-8 monotonic forward-only: there is no live downgrade path.
//     `rollback` exists for unit tests only.

import type { Database } from "bun:sqlite"

import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Log } from "@/util/log"

import { SessionStorageEvent } from "./events"
import * as v1 from "./migrations/v1"

const log = Log.create({ service: "session.storage.migration" })

export const SchemaMigrationFailedError = NamedError.create(
  "SchemaMigrationFailedError",
  z.object({
    sessionID: z.string(),
    fromVersion: z.number(),
    toVersion: z.number(),
    error: z.string(),
    dbPath: z.string(),
  }),
)

export const SchemaVersionTooNewError = NamedError.create(
  "SchemaVersionTooNewError",
  z.object({
    sessionID: z.string(),
    dbVersion: z.number(),
    runtimeVersion: z.number(),
    dbPath: z.string(),
  }),
)

interface Migration {
  /** Target version after this migration runs. */
  to: number
  apply(db: Database): void
  rollback(db: Database): void
}

const MIGRATIONS: Migration[] = [
  { to: v1.VERSION, apply: v1.applyV1, rollback: v1.rollbackV1 },
]

export const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].to

function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null
  return row?.user_version ?? 0
}

function writeUserVersion(db: Database, version: number): void {
  // PRAGMA user_version takes a literal int; not parameterizable.
  db.exec(`PRAGMA user_version = ${version}`)
}

function writeMetaSchemaVersion(db: Database, version: number): void {
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(version),
  )
}

function writeMetaSessionId(db: Database, sessionID: string): void {
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("session_id", sessionID)
}

/**
 * Bring a session's database up to TARGET_VERSION. Caller-owned: must run
 * after Pool.acquire and after IntegrityChecker.run on a freshly-pooled
 * connection.
 */
export async function ensureSchema(
  db: Database,
  sessionID: string,
  dbPath: string,
): Promise<void> {
  const current = readUserVersion(db)

  if (current > TARGET_VERSION) {
    throw new SchemaVersionTooNewError({
      sessionID,
      dbVersion: current,
      runtimeVersion: TARGET_VERSION,
      dbPath,
    })
  }

  if (current === TARGET_VERSION) return

  for (const migration of MIGRATIONS) {
    if (migration.to <= current) continue
    log.info("running migration", { sessionID, from: current, to: migration.to })

    const transaction = db.transaction(() => {
      migration.apply(db)
      // Bootstrap-time meta rows; only written if migration is applying v1.
      if (migration.to === 1) {
        writeMetaSessionId(db, sessionID)
      }
      writeMetaSchemaVersion(db, migration.to)
      writeUserVersion(db, migration.to)
    })

    try {
      transaction()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error("migration failed", {
        sessionID,
        from: current,
        to: migration.to,
        error: errorMsg,
      })
      await Bus.publish(SessionStorageEvent.MigrationFailed, {
        sessionID,
        stage: "tmp_write",
        error: `schema migration ${current} → ${migration.to} failed: ${errorMsg}`,
        timestamp: Date.now(),
      }).catch(() => {})
      throw new SchemaMigrationFailedError({
        sessionID,
        fromVersion: current,
        toVersion: migration.to,
        error: errorMsg,
        dbPath,
      })
    }
  }
}

/**
 * Test-only: roll back to a specific version. Production code never calls
 * this — INV-8 forbids live downgrades. Unit tests use it to exercise the
 * forward + rollback pair (R-5).
 */
export function rollbackTo(db: Database, target: number): void {
  const current = readUserVersion(db)
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const m = MIGRATIONS[i]
    if (m.to <= target || m.to > current) continue
    m.rollback(db)
  }
  writeUserVersion(db, target)
}
