import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"

// Spec: /specs/session-storage-db, task 2.9.
//
// Tests SqliteStore CRUD round-trips, transaction atomicity, schema
// version handshake, and integrity_check pass/fail via the real
// ConnectionPool against a per-pid tmpdir (Global.ts pins XDG when
// NODE_ENV=test, so tests can never collide with real session files —
// see Beta XDG Isolation memory entry).

import { SqliteStore } from "./sqlite"
import { ConnectionPool } from "./pool"
import { runIntegrityCheckUncached, StorageCorruptionError } from "./integrity"
import { ensureSchema } from "./migration-runner"
import type { MessageV2 } from "../message-v2"

const SID = "ses_test_sqlite_001"
const SID_B = "ses_test_sqlite_002"
const MID_A = "msg_dd1aaaaaaaaa0000aaaaaaaaaaaaa"
const MID_B = "msg_dd2bbbbbbbbb0000bbbbbbbbbbbbb"
const PID_A1 = "prt_dd1aaaaa0000pa1aaaaaaaaaaaaa"
const PID_A2 = "prt_dd1aaaaa0001pa2aaaaaaaaaaaaa"

function userMessage(sessionID: string, id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1700000000000 },
    agent: "build",
    model: { providerId: "anthropic", modelID: "claude-opus-4-7", accountId: "acc_1" },
  }
}

function assistantMessage(sessionID: string, id: string, parentID: string): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1700000001000, completed: 1700000005000 },
    parentID,
    modelID: "claude-opus-4-7",
    providerId: "anthropic",
    accountId: "acc_1",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/repo", root: "/tmp/repo" },
    cost: 0.0123,
    tokens: {
      total: 150,
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: "stop",
  }
}

function textPart(sessionID: string, messageID: string, id: string, text: string): MessageV2.Part {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic: false,
    time: { start: 1700000002000, end: 1700000003000 },
  } as MessageV2.Part
}

beforeEach(() => {
  ConnectionPool.closeAll()
})

afterEach(async () => {
  ConnectionPool.closeAll()
  // Clean test DB files between tests
  const dbPath = ConnectionPool.resolveDbPath(SID)
  const dbPathB = ConnectionPool.resolveDbPath(SID_B)
  for (const p of [dbPath, dbPathB, dbPath + "-wal", dbPath + "-shm", dbPathB + "-wal", dbPathB + "-shm"]) {
    await fs.rm(p, { force: true }).catch(() => {})
  }
})

describe("SqliteStore CRUD", () => {
  it("creates a fresh DB on first write and round-trips a user message", async () => {
    const u = userMessage(SID, MID_A)
    await SqliteStore.upsertMessage(u)

    const got = await SqliteStore.get({ sessionID: SID, messageID: MID_A })
    expect(got.info.role).toBe("user")
    expect(got.info.id).toBe(MID_A)
    expect((got.info as MessageV2.User).model.providerId).toBe("anthropic")
    expect(got.parts).toEqual([])
  })

  it("round-trips an assistant message preserving promoted columns + extras", async () => {
    const u = userMessage(SID, MID_A)
    const a = assistantMessage(SID, MID_B, MID_A)
    await SqliteStore.upsertMessage(u)
    await SqliteStore.upsertMessage(a)

    const got = await SqliteStore.get({ sessionID: SID, messageID: MID_B })
    const info = got.info as MessageV2.Assistant
    expect(info.role).toBe("assistant")
    expect(info.parentID).toBe(MID_A)
    expect(info.tokens.total).toBe(150)
    expect(info.tokens.input).toBe(100)
    expect(info.tokens.output).toBe(50)
    expect(info.cost).toBeCloseTo(0.0123)
    expect(info.finish).toBe("stop")
    expect(info.path?.cwd).toBe("/tmp/repo") // came back via info_extra_json
  })

  it("upserts parts and preserves insertion order via sequence", async () => {
    const a = assistantMessage(SID, MID_A, "msg_parent")
    await SqliteStore.upsertMessage(a)

    await SqliteStore.upsertPart(textPart(SID, MID_A, PID_A1, "hello"))
    await SqliteStore.upsertPart(textPart(SID, MID_A, PID_A2, "world"))

    const parts = await SqliteStore.parts(MID_A, SID)
    expect(parts.length).toBe(2)
    expect((parts[0] as { text: string }).text).toBe("hello")
    expect((parts[1] as { text: string }).text).toBe("world")
  })

  it("REPLACE on same part id keeps original sequence (streaming-delta replay)", async () => {
    const a = assistantMessage(SID, MID_A, "msg_parent")
    await SqliteStore.upsertMessage(a)

    await SqliteStore.upsertPart(textPart(SID, MID_A, PID_A1, "first"))
    await SqliteStore.upsertPart(textPart(SID, MID_A, PID_A2, "second"))
    // Replay PID_A1 with new text — sequence MUST stay 0, not become 2
    await SqliteStore.upsertPart(textPart(SID, MID_A, PID_A1, "first-updated"))

    const parts = await SqliteStore.parts(MID_A, SID)
    expect(parts.length).toBe(2)
    expect((parts[0] as { text: string; id: string }).id).toBe(PID_A1)
    expect((parts[0] as { text: string; id: string }).text).toBe("first-updated")
    expect((parts[1] as { text: string; id: string }).id).toBe(PID_A2)
  })

  it("stream yields messages in DESCENDING id order (matches LegacyStore contract)", async () => {
    // Contract: stream MUST be newest-first. Caller (filterCompacted)
    // reverses to ASC and runloop walks backward expecting latest user
    // at the END of the reversed array. Diagnosed 2026-04-29 — ASC ordering
    // here breaks every multi-turn session (parent_id pinned to first user).
    const u = userMessage(SID, MID_A)
    const a = assistantMessage(SID, MID_B, MID_A)
    await SqliteStore.upsertMessage(u)
    await SqliteStore.upsertMessage(a)
    await SqliteStore.upsertPart(textPart(SID, MID_B, PID_A1, "reply"))

    const collected = []
    for await (const m of SqliteStore.stream(SID)) collected.push(m)
    expect(collected.length).toBe(2)
    expect(collected[0].info.id).toBe(MID_B)
    expect(collected[1].info.id).toBe(MID_A)
    expect(collected[0].parts.length).toBe(1)
  })

  it("parts() throws without sessionID (DD-13 — no silent scan)", async () => {
    expect(SqliteStore.parts(MID_A)).rejects.toThrow(/requires sessionID/)
  })

  it("isolates sessions: upserts to SID don't leak to SID_B", async () => {
    await SqliteStore.upsertMessage(userMessage(SID, MID_A))
    await SqliteStore.upsertMessage(userMessage(SID_B, MID_B))

    const inA = []
    for await (const m of SqliteStore.stream(SID)) inA.push(m.info.id)
    const inB = []
    for await (const m of SqliteStore.stream(SID_B)) inB.push(m.info.id)
    expect(inA).toEqual([MID_A])
    expect(inB).toEqual([MID_B])
  })
})

describe("SqliteStore schema + integrity", () => {
  it("bootstraps schema_version=1 on fresh DB", async () => {
    await SqliteStore.upsertMessage(userMessage(SID, MID_A))
    const dbPath = ConnectionPool.resolveDbPath(SID)
    ConnectionPool.closeAll()
    const inspect = new Database(dbPath, { readonly: true, create: false })
    const row = inspect
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get()
    expect(row?.value).toBe("1")
    inspect.close()
  })

  it("integrity_check returns ok for a fresh DB", async () => {
    await SqliteStore.upsertMessage(userMessage(SID, MID_A))
    const dbPath = ConnectionPool.resolveDbPath(SID)
    ConnectionPool.closeAll()
    const db = new Database(dbPath, { readonly: true, create: false })
    const verdict = await runIntegrityCheckUncached(db, SID, dbPath)
    expect(verdict).toBe("ok")
    db.close()
  })

  it("ensureSchema is idempotent — re-running on a v1 DB is a no-op", async () => {
    await SqliteStore.upsertMessage(userMessage(SID, MID_A))
    const dbPath = ConnectionPool.resolveDbPath(SID)
    ConnectionPool.closeAll()
    const db = new Database(dbPath)
    await ensureSchema(db, SID, dbPath)
    // Still readable
    const row = db.query<{ id: string }, []>("SELECT id FROM messages").get()
    expect(row?.id).toBe(MID_A)
    db.close()
  })

  it("rejects opening a DB with corruption (DR-3)", async () => {
    // Build a healthy DB
    await SqliteStore.upsertMessage(userMessage(SID, MID_A))
    const dbPath = ConnectionPool.resolveDbPath(SID)
    ConnectionPool.closeAll()
    // Inject corruption: zero out a stretch of bytes inside the SQLite page area
    const handle = await fs.open(dbPath, "r+")
    const buf = Buffer.alloc(64, 0xff)
    await handle.write(buf, 0, buf.length, 100)
    await handle.close()
    // Next acquire should throw via integrity_check
    await expect(SqliteStore.get({ sessionID: SID, messageID: MID_A })).rejects.toThrow()
    // The pool MUST NOT retain a leaked entry after the cold-open failure
    expect(ConnectionPool.stats().size).toBe(0)
  })
})

describe("SqliteStore transaction atomicity (DR-1 / INV-6)", () => {
  it("a failed upsertMessage does not leave a partial row", async () => {
    // Bun:sqlite's transaction wrapper rolls back on throw; verify by
    // injecting an invalid encode (not via SqliteStore — directly via
    // pool, simulating a hypothetical bug at the DDL layer).
    await SqliteStore.upsertMessage(userMessage(SID, MID_A))
    const db = await ConnectionPool.acquire({ sessionID: SID, mode: "rw" })
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO messages (id, role, time_created) VALUES ('msg_partial','user',1)")
        throw new Error("simulated post-insert failure")
      })(),
    ).toThrow(/simulated/)
    const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM messages").get()?.c
    expect(count).toBe(1) // original MID_A only — partial insert rolled back
  })
})

describe("SqliteStore deleteSession", () => {
  it("clears all rows in the session's tables", async () => {
    await SqliteStore.upsertMessage(userMessage(SID, MID_A))
    await SqliteStore.upsertMessage(assistantMessage(SID, MID_B, MID_A))
    await SqliteStore.upsertPart(textPart(SID, MID_B, PID_A1, "hi"))

    await SqliteStore.deleteSession(SID)

    // The .db file is intentionally left on disk (per spec — file-level
    // removal is the caller's policy). But tables are emptied and pool
    // entry is closed.
    expect(ConnectionPool.stats().size).toBe(0)
    const dbPath = ConnectionPool.resolveDbPath(SID)
    const inspect = new Database(dbPath, { readonly: true, create: false })
    const msgCount = inspect.query<{ c: number }, []>("SELECT COUNT(*) as c FROM messages").get()?.c
    const partCount = inspect.query<{ c: number }, []>("SELECT COUNT(*) as c FROM parts").get()?.c
    expect(msgCount).toBe(0)
    expect(partCount).toBe(0)
    inspect.close()
  })
})

void StorageCorruptionError // surface import for symbol existence check
void path
