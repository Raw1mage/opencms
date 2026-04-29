// Router — dual-track dispatcher.
//
// Spec: /specs/session-storage-db, tasks 3.1 / 3.2 / 3.3
// Cross-refs: DD-9 (signature compatibility), DD-13 (no silent fallback),
// INV-1 (single source of truth per moment), INV-4 (no legacy re-route on
// SqliteStore error).
//
// Per-call format detection. The mental model: the filesystem state at
// the moment of the call decides which Backend handles it.
//
//   <sid>.db       only       → SqliteStore (the migrated common case)
//   <sid>/messages only       → LegacyStore (legacy session, dreaming
//                                mode hasn't reached it yet)
//   neither                   → fresh session; SqliteStore creates on
//                                first write
//   both, no tmp              → SqliteStore wins (post-rename debris);
//                                schedule legacy directory delete on
//                                next idle (sequence.json P4 between
//                                MSG6 and MSG7)
//   both, tmp present         → migration in flight or crashed mid;
//                                LegacyStore is authoritative (DR-4)
//                                until startup cleanup deletes tmp
//
// DD-13: any error from SqliteStore propagates. The Router never
// catches and re-routes to LegacyStore on a SQLite-side failure.

import fs from "fs"
import fsp from "fs/promises"
import path from "path"

import { Bus } from "@/bus"
import { Log } from "@/util/log"

import { ConnectionPool } from "./pool"
import { LegacyStore } from "./legacy"
import { SqliteStore } from "./sqlite"
import { SessionStorageEvent } from "./events"
import type { MessageV2 } from "../message-v2"
import type { SessionStorage } from "./index"

const log = Log.create({ service: "session.storage.router" })

export type Format = "legacy" | "sqlite"

interface FormatVerdict {
  format: Format
  hasLegacyDebris: boolean
  hasMigrationTmp: boolean
}

/**
 * Resolve the legacy session directory path. Mirrors `Storage.sessionDirectory`
 * but synchronous — we only use it for existence checks.
 */
function legacySessionDir(sessionID: string): string {
  // Pool.resolveDbPath is `<root>/storage/session/<sid>.db`; the legacy
  // directory is the sibling `<sid>/` directory.
  const dbPath = ConnectionPool.resolveDbPath(sessionID)
  return path.join(path.dirname(dbPath), sessionID)
}

function legacyTmpPath(sessionID: string): string {
  return ConnectionPool.resolveDbPath(sessionID) + ".tmp"
}

/**
 * Detect which backend should serve the session at this moment.
 *
 * Filesystem-only check; no DB open. Cheap enough to run per call.
 * Caches are not used — the Router reflects the live filesystem so
 * post-migration debris cleanup and dreaming-mode atomic rename are
 * observed as soon as they land.
 */
export function detectFormat(sessionID: string): FormatVerdict {
  const dbPath = ConnectionPool.resolveDbPath(sessionID)
  const tmpPath = legacyTmpPath(sessionID)
  const legacyDir = legacySessionDir(sessionID)

  const hasDb = fs.existsSync(dbPath)
  const hasTmp = fs.existsSync(tmpPath)
  // Legacy is authoritative if its messages directory exists. The session
  // directory itself can exist without messages (info.json only) for a
  // fresh session in legacy days; we still treat that as legacy if no
  // .db file is around.
  const hasLegacyMessages = fs.existsSync(path.join(legacyDir, "messages"))
  const hasLegacyDir = hasLegacyMessages || fs.existsSync(legacyDir)

  // Debris path: both .db and legacy directory present without an
  // in-flight migration tmp. SqliteStore is authoritative — the migration
  // completed but the legacy delete didn't (DR-4 between MSG6 and MSG7).
  if (hasDb && hasLegacyDir && !hasTmp) {
    return { format: "sqlite", hasLegacyDebris: true, hasMigrationTmp: false }
  }

  // Migration in flight or crashed mid-migration. Legacy is authoritative
  // until DR-4 startup cleanup deletes tmp.
  if (hasTmp && hasLegacyDir) {
    return { format: "legacy", hasLegacyDebris: false, hasMigrationTmp: true }
  }

  // Common case: exactly one source of truth.
  if (hasDb) {
    return { format: "sqlite", hasLegacyDebris: false, hasMigrationTmp: false }
  }
  if (hasLegacyDir) {
    return { format: "legacy", hasLegacyDebris: false, hasMigrationTmp: false }
  }

  // Neither — fresh session. SqliteStore creates on first write.
  return { format: "sqlite", hasLegacyDebris: false, hasMigrationTmp: false }
}

// ── Debris scheduling ────────────────────────────────────────────────────

/**
 * Per-process queue of legacy session directories awaiting deletion after
 * post-migration debris detection. Drained by `drainLegacyDebris()` —
 * which the dreaming-mode worker is expected to call on each idle tick
 * (task 5.3). Until then, debris is logged + queued; never deleted
 * synchronously inside a hot read/write path.
 */
const debrisQueue = new Set<string>()

function noteLegacyDebris(sessionID: string): void {
  if (debrisQueue.has(sessionID)) return
  debrisQueue.add(sessionID)
  log.info("router.legacy_debris", { sessionID, scheduled_for_deletion: true })
}

export async function drainLegacyDebris(): Promise<{ deleted: string[] }> {
  const deleted: string[] = []
  for (const sessionID of [...debrisQueue]) {
    const legacyDir = legacySessionDir(sessionID)
    try {
      // Defensive: re-check that .db is still authoritative AND tmp is
      // still absent. If state changed between scheduling and draining,
      // skip — let the next router call re-evaluate.
      const verdict = detectFormat(sessionID)
      if (!(verdict.format === "sqlite" && verdict.hasLegacyDebris)) {
        debrisQueue.delete(sessionID)
        continue
      }
      await fsp.rm(legacyDir, { recursive: true, force: true })
      deleted.push(sessionID)
      debrisQueue.delete(sessionID)
      await Bus.publish(SessionStorageEvent.LegacyDebrisResolved, {
        sessionID,
        deletedAt: Date.now(),
      }).catch(() => {})
    } catch (err) {
      log.warn("router.debris_drain_failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
      // Keep in queue; retry next idle tick.
    }
  }
  return { deleted }
}

/**
 * Test/diag helper — peek the queue without draining.
 */
export function pendingDebris(): string[] {
  return [...debrisQueue]
}

// ── Backend ─────────────────────────────────────────────────────────────

/**
 * Pick the backend for this call and note any post-migration debris.
 *
 * No silent fallback (DD-13 / INV-4): if the chosen backend throws on
 * the actual call, the caller sees the throw. Router is only allowed to
 * decide *which* backend serves the call — never to retry on a different
 * one.
 */
function pick(sessionID: string): SessionStorage.Backend {
  const verdict = detectFormat(sessionID)
  if (verdict.hasLegacyDebris) {
    noteLegacyDebris(sessionID)
  }
  return verdict.format === "sqlite" ? SqliteStore : LegacyStore
}

export const Router: SessionStorage.Backend = {
  stream(sessionID: string): AsyncIterable<MessageV2.WithParts> {
    return pick(sessionID).stream(sessionID)
  },

  async get(input: { sessionID: string; messageID: string }): Promise<MessageV2.WithParts> {
    return pick(input.sessionID).get(input)
  },

  async parts(messageID: string, sessionID?: string): Promise<MessageV2.Part[]> {
    if (sessionID) {
      return pick(sessionID).parts(messageID, sessionID)
    }
    // Without sessionID we can only serve from LegacyStore (which keys
    // on messageID alone). DD-13 — we do NOT scan SQLite DBs guessing
    // ownership. Caller is expected to thread sessionID; this is the
    // explicit fall-through path for the (now narrow) legacy-only callers.
    return LegacyStore.parts(messageID)
  },

  async upsertMessage(info: MessageV2.Info): Promise<void> {
    return pick(info.sessionID).upsertMessage(info)
  },

  async upsertPart(part: MessageV2.Part): Promise<void> {
    return pick(part.sessionID).upsertPart(part)
  },

  async deleteSession(sessionID: string): Promise<void> {
    // Both formats may need clearing during dual-track. Run the chosen
    // format's deleteSession, then opportunistically clean up any
    // straggler from the other format. This is one of the few places
    // where touching both is correct — INV-1 holds (only one is the
    // source of truth at any given moment), but on DELETE we want the
    // floor swept.
    const verdict = detectFormat(sessionID)
    if (verdict.format === "sqlite") {
      await SqliteStore.deleteSession(sessionID)
      // Best-effort legacy cleanup if the directory is still around.
      const legacyDir = legacySessionDir(sessionID)
      await fsp.rm(legacyDir, { recursive: true, force: true }).catch(() => {})
    } else {
      await LegacyStore.deleteSession(sessionID)
      // Drop the .db tmp if a crashed migration left one behind.
      await fsp.rm(legacyTmpPath(sessionID), { force: true }).catch(() => {})
    }
    debrisQueue.delete(sessionID)
  },
}
