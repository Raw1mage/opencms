// ConnectionPool — bounded LRU of SQLite handles keyed by sessionID.
//
// Spec: /specs/session-storage-db, task 2.2 (DD-10).
//
// Behavior contract:
//   - acquire(sessionID, mode) returns a Database connection. Cold acquires
//     open a fresh handle, apply pragmas (DD-3 / task 2.6), and run
//     IntegrityChecker on first use (DD-7 / DR-3 / INV-3).
//   - Warm acquires return the cached handle without re-pragmaing.
//   - Connections idle past CONNECTION_IDLE_MS get closed by the sweep timer.
//   - Pool capacity (default 32) bounds total open handles. Eviction is LRU.
//   - Read-only mode opens a separate connection; reader handles are not
//     pooled across calls (per DD-4: short-lived readers).

import { Database } from "bun:sqlite"
import { mkdirSync, existsSync } from "fs"
import path from "path"

import { Global } from "@/global"

const DEFAULT_CAPACITY = 32
const DEFAULT_IDLE_MS = 60_000

interface PoolEntry {
  sessionID: string
  db: Database
  lastUsedMs: number
}

export interface AcquireOptions {
  sessionID: string
  /** "rw" returns the cached writer handle; "ro" opens a fresh read-only connection (not pooled). */
  mode: "rw" | "ro"
  /** Hook invoked exactly once per cold acquire (used by SqliteStore to run IntegrityChecker + MigrationRunner). */
  onColdOpen?: (db: Database, dbPath: string) => Promise<void> | void
}

export interface PoolStats {
  size: number
  capacity: number
}

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
] as const

export namespace ConnectionPool {
  let capacity = DEFAULT_CAPACITY
  let idleMs = DEFAULT_IDLE_MS
  const entries = new Map<string, PoolEntry>()
  let sweepTimer: ReturnType<typeof setInterval> | null = null

  /** Resolve `<storage-root>/session/<sid>.db`. */
  export function resolveDbPath(sessionID: string): string {
    return path.join(Global.Path.data, "storage", "session", `${sessionID}.db`)
  }

  /** Apply the WAL pragmas to a freshly opened handle. Idempotent if called twice. */
  function applyPragmas(db: Database): void {
    for (const stmt of PRAGMAS) db.exec(stmt)
  }

  /**
   * Acquire a connection for a session. Read-only handles are returned
   * outside the pool (caller must close). Writer handles are cached.
   *
   * Cold-open ordering (DD-7 / INV-3):
   *   1. Open Database (creates file if missing — caller is expected to
   *      create only when intentional; SqliteStore guards this)
   *   2. Apply pragmas (WAL + synchronous + foreign_keys)
   *   3. Invoke onColdOpen (IntegrityChecker, MigrationRunner)
   *   4. Insert into pool (rw only)
   */
  export async function acquire(opts: AcquireOptions): Promise<Database> {
    const dbPath = resolveDbPath(opts.sessionID)

    if (opts.mode === "ro") {
      const db = new Database(dbPath, { readonly: true, create: false })
      applyPragmas(db)
      return db
    }

    const cached = entries.get(opts.sessionID)
    if (cached) {
      cached.lastUsedMs = Date.now()
      return cached.db
    }

    // Cold open. Ensure parent dir exists (storage/session/) on first write.
    const parentDir = path.dirname(dbPath)
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })

    const db = new Database(dbPath, { create: true })
    applyPragmas(db)
    if (opts.onColdOpen) await opts.onColdOpen(db, dbPath)

    entries.set(opts.sessionID, {
      sessionID: opts.sessionID,
      db,
      lastUsedMs: Date.now(),
    })
    enforceCapacity()
    ensureSweepRunning()
    return db
  }

  /** Force-close a session's handle (e.g. for tests, schema migration, deleteSession). */
  export function close(sessionID: string): void {
    const entry = entries.get(sessionID)
    if (!entry) return
    try {
      entry.db.close()
    } catch {
      // Already closed; ignore.
    }
    entries.delete(sessionID)
  }

  /** Close all pooled connections. Used by shutdown hooks and tests. */
  export function closeAll(): void {
    for (const sessionID of [...entries.keys()]) close(sessionID)
    if (sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }

  /** Capacity gate — evict LRU entries when over cap. */
  function enforceCapacity(): void {
    while (entries.size > capacity) {
      let oldestId: string | null = null
      let oldestMs = Number.POSITIVE_INFINITY
      for (const [sid, entry] of entries) {
        if (entry.lastUsedMs < oldestMs) {
          oldestMs = entry.lastUsedMs
          oldestId = sid
        }
      }
      if (oldestId === null) return
      close(oldestId)
    }
  }

  /** Idle sweep — close handles untouched past idleMs. */
  function ensureSweepRunning(): void {
    if (sweepTimer) return
    sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [sid, entry] of entries) {
        if (now - entry.lastUsedMs > idleMs) close(sid)
      }
      if (entries.size === 0 && sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
    }, Math.max(1_000, idleMs / 4))
    // Don't keep the process alive on this timer alone.
    if (typeof (sweepTimer as unknown as { unref?: () => void }).unref === "function") {
      ;(sweepTimer as unknown as { unref(): void }).unref()
    }
  }

  /** Test / tunables hook. */
  export function configure(options: { capacity?: number; idleMs?: number }): void {
    if (typeof options.capacity === "number" && options.capacity > 0) capacity = options.capacity
    if (typeof options.idleMs === "number" && options.idleMs > 0) idleMs = options.idleMs
  }

  export function stats(): PoolStats {
    return { size: entries.size, capacity }
  }
}
