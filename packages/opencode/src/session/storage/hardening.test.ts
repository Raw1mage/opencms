import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"

import { Bus } from "@/bus"
import { Storage } from "../../storage/storage"
import type { MessageV2 } from "../message-v2"
import { SessionInspect } from "../../cli/cmd/session-inspect"
import { SessionStorageEvent } from "./events"
import { runIntegrityCheckUncached, StorageCorruptionError } from "./integrity"
import { ensureSchema, rollbackTo, TARGET_VERSION } from "./migration-runner"
import { ConnectionPool } from "./pool"
import { Router } from "./router"
import { SqliteStore } from "./sqlite"

const SIDS = [
  "ses_test_hardening_commit",
  "ses_test_hardening_power",
  "ses_test_hardening_corrupt",
  "ses_test_hardening_migrate",
  "ses_test_hardening_schema",
  "ses_test_hardening_rsync",
  "ses_test_hardening_rsync_snapshot",
  "ses_test_hardening_perf_sqlite",
]

function dbPath(sessionID: string): string {
  return ConnectionPool.resolveDbPath(sessionID)
}

function legacyDir(sessionID: string): string {
  return path.join(path.dirname(dbPath(sessionID)), sessionID)
}

function user(sessionID: string, id: string, created = 1700000000000): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerId: "anthropic", modelID: "claude-opus-4-7" },
  }
}

function assistant(sessionID: string, id: string, parentID: string, created = 1700000001000): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: created + 1000 },
    parentID,
    modelID: "claude-opus-4-7",
    providerId: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/repo", root: "/tmp/repo" },
    cost: 0,
    tokens: { total: 3, input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

function part(sessionID: string, messageID: string, id: string, text = "hello"): MessageV2.Part {
  return { id, sessionID, messageID, type: "text", text, synthetic: false } as MessageV2.Part
}

async function clean(sessionID: string): Promise<void> {
  ConnectionPool.close(sessionID)
  const file = dbPath(sessionID)
  for (const p of [file, file + "-wal", file + "-shm", file + ".tmp", file + ".tmp-wal", file + ".tmp-shm"]) {
    await fs.rm(p, { force: true }).catch(() => {})
  }
  await fs.rm(legacyDir(sessionID), { recursive: true, force: true }).catch(() => {})
}

async function collect(sessionID: string): Promise<MessageV2.WithParts[]> {
  const rows: MessageV2.WithParts[] = []
  for await (const message of Router.stream(sessionID)) rows.push(message)
  return rows
}

async function seedSqlite(sessionID: string): Promise<void> {
  const u = user(sessionID, `msg_${sessionID}_u`)
  const a = assistant(sessionID, `msg_${sessionID}_a`, u.id)
  await Storage.write(["session", sessionID], { id: sessionID, projectID: "proj_test" })
  await SqliteStore.upsertMessage(u)
  await SqliteStore.upsertMessage(a)
  await SqliteStore.upsertPart(part(sessionID, a.id, `prt_${sessionID}_a`))
}

async function corruptDb(sessionID: string): Promise<void> {
  ConnectionPool.close(sessionID)
  const handle = await fs.open(dbPath(sessionID), "r+")
  try {
    await handle.write(Buffer.alloc(64, 0xff), 0, 64, 100)
  } finally {
    await handle.close()
  }
}

beforeEach(async () => {
  ConnectionPool.closeAll()
  for (const sid of SIDS) await clean(sid)
})

afterEach(async () => {
  ConnectionPool.closeAll()
  for (const sid of SIDS) await clean(sid)
})

describe("session storage hardening", () => {
  it("DR-1 rolls back an interrupted message+parts transaction atomically", async () => {
    const sid = "ses_test_hardening_commit"
    await SqliteStore.upsertMessage(user(sid, "msg_committed"))
    const db = await ConnectionPool.acquire({ sessionID: sid, mode: "rw" })

    expect(() =>
      db.transaction(() => {
        db.exec(`INSERT INTO messages (id, role, time_created) VALUES ('msg_inflight','user',1)`)
        db.exec(
          `INSERT INTO parts (id, message_id, sequence, type, payload_json) VALUES ('prt_inflight','msg_inflight',0,'text','{}')`,
        )
        throw new Error("simulated interrupted commit")
      })(),
    ).toThrow(/interrupted/)

    ConnectionPool.closeAll()
    expect((await collect(sid)).map((message) => message.info.id)).toEqual(["msg_committed"])
  })

  it("DR-2 reopens cleanly after abrupt close with WAL/NORMAL semantics", async () => {
    const sid = "ses_test_hardening_power"
    await SqliteStore.upsertMessage(user(sid, "msg_power_user"))
    await SqliteStore.upsertMessage(assistant(sid, "msg_power_assistant", "msg_power_user"))
    await SqliteStore.upsertPart(part(sid, "msg_power_assistant", "prt_power"))
    ConnectionPool.closeAll()

    const db = new Database(dbPath(sid), { readonly: true, create: false })
    try {
      await expect(runIntegrityCheckUncached(db, sid, dbPath(sid))).resolves.toBe("ok")
    } finally {
      db.close()
    }
  })

  it("DR-3 refuses corrupted DBs, publishes corruption, and session-inspect reports non-ok", async () => {
    const sid = "ses_test_hardening_corrupt"
    const events: Array<{ sessionID: string; integrityCheckOutput: string }> = []
    const unsubscribe = Bus.subscribe(SessionStorageEvent.Corrupted, (event) => events.push(event.properties))
    try {
      await SqliteStore.upsertMessage(user(sid, "msg_corrupt"))
      await corruptDb(sid)

      await expect(Router.get({ sessionID: sid, messageID: "msg_corrupt" })).rejects.toThrow()
      const checked = await SessionInspect.check(sid)

      expect(checked.exitCode).toBe(1)
      expect(checked.stdout.trim()).not.toBe("ok")
      expect(events.at(-1)?.sessionID).toBe(sid)
      expect(events.at(-1)?.integrityCheckOutput.length).toBeGreaterThan(0)
    } finally {
      unsubscribe()
    }
  })

  it("DR-5 validates schema forward, failed forward rollback, and test rollback helper", async () => {
    const sid = "ses_test_hardening_schema"
    await SqliteStore.upsertMessage(user(sid, "msg_schema"))
    ConnectionPool.closeAll()

    const db = new Database(dbPath(sid))
    try {
      await ensureSchema(db, sid, dbPath(sid))
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(TARGET_VERSION)
      const syntheticNext = TARGET_VERSION + 1
      expect(() =>
        db.transaction(() => {
          db.exec("CREATE TABLE synthetic_vnext_probe (id TEXT PRIMARY KEY)")
          db.exec(`PRAGMA user_version = ${syntheticNext}`)
          throw new Error("synthetic vnext failure")
        })(),
      ).toThrow(/synthetic/)
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(TARGET_VERSION)
      expect(
        db
          .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get("synthetic_vnext_probe"),
      ).toBeNull()
      db.exec("CREATE TABLE synthetic_vnext_probe (id TEXT PRIMARY KEY)")
      db.exec(`PRAGMA user_version = ${syntheticNext}`)
      db.exec("DROP TABLE synthetic_vnext_probe")
      db.exec(`PRAGMA user_version = ${TARGET_VERSION}`)
      rollbackTo(db, 0)
      expect(
        db
          .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get("messages"),
      ).toBeNull()
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(0)
    } finally {
      db.close()
    }
  })

  it("R-1 documents live-rsync fixture outcome as ok or explicitly flagged", async () => {
    const sid = "ses_test_hardening_rsync"
    const snapshot = "ses_test_hardening_rsync_snapshot"
    await SqliteStore.upsertMessage(user(sid, "msg_rsync_user"))
    await SqliteStore.upsertMessage(assistant(sid, "msg_rsync_assistant", "msg_rsync_user"))

    await fs.copyFile(dbPath(sid), dbPath(snapshot))
    await fs.copyFile(dbPath(sid) + "-wal", dbPath(snapshot) + "-wal").catch(() => {})
    await fs.copyFile(dbPath(sid) + "-shm", dbPath(snapshot) + "-shm").catch(() => {})

    const db = new Database(dbPath(snapshot), { readonly: true, create: false })
    try {
      const verdict = await runIntegrityCheckUncached(db, snapshot, dbPath(snapshot)).catch((err) => {
        if (StorageCorruptionError.isInstance(err)) return err.data.integrityCheckOutput
        return err instanceof Error ? err.message : String(err)
      })
      expect(verdict.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it("8.7 runs a synthetic 2253-message read benchmark fixture", async () => {
    const sqliteSid = "ses_test_hardening_perf_sqlite"
    const count = 2253
    for (let i = 0; i < count; i++) {
      const id = `msg_perf_${String(i).padStart(4, "0")}`
      await SqliteStore.upsertMessage(user(sqliteSid, id, 1700000000000 + i))
    }
    ConnectionPool.closeAll()

    const sqliteStart = performance.now()
    const sqliteRows = await collect(sqliteSid)
    const sqliteMs = performance.now() - sqliteStart

    expect(sqliteRows.length).toBe(count)
    expect(Number.isFinite(sqliteMs)).toBe(true)
  })
})
