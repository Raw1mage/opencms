import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"

// Spec: /specs/session-storage-db, task 3.4.
// Tests the Router's per-call format detection matrix, debris queue,
// debris drain, and no-silent-fallback contract (DD-13 / INV-4).
// Real disk under per-pid tmpdir per Global.ts NODE_ENV=test guard.

import { Router, detectFormat, drainLegacyDebris, pendingDebris } from "./router"
import { SqliteStore } from "./sqlite"
import { ConnectionPool } from "./pool"
import type { MessageV2 } from "../message-v2"

const SID_FRESH = "ses_test_router_fresh"
const SID_SQLITE = "ses_test_router_sqlite"
const SID_LEGACY = "ses_test_router_legacy"
const SID_DEBRIS = "ses_test_router_debris"
const SID_TMP_INFLIGHT = "ses_test_router_tmp"

function user(sessionID: string, id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1700000000000 },
    agent: "build",
    model: { providerId: "anthropic", modelID: "claude-opus-4-7" },
  }
}

function legacySessionDir(sessionID: string): string {
  const dbPath = ConnectionPool.resolveDbPath(sessionID)
  return path.join(path.dirname(dbPath), sessionID)
}

async function makeLegacyDir(sessionID: string): Promise<void> {
  const dir = legacySessionDir(sessionID)
  await fs.mkdir(path.join(dir, "messages"), { recursive: true })
}

async function makeTmpFile(sessionID: string): Promise<void> {
  const dbPath = ConnectionPool.resolveDbPath(sessionID)
  const dir = path.dirname(dbPath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(dbPath + ".tmp", "fake migration in flight")
}

beforeEach(() => {
  ConnectionPool.closeAll()
})

afterEach(async () => {
  ConnectionPool.closeAll()
  for (const sid of [SID_FRESH, SID_SQLITE, SID_LEGACY, SID_DEBRIS, SID_TMP_INFLIGHT]) {
    const dbPath = ConnectionPool.resolveDbPath(sid)
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm", dbPath + ".tmp"]) {
      await fs.rm(p, { force: true }).catch(() => {})
    }
    await fs.rm(legacySessionDir(sid), { recursive: true, force: true }).catch(() => {})
  }
  // Drain debris queue between tests.
  await drainLegacyDebris()
})

describe("Router format detection", () => {
  it("fresh session (neither format) → sqlite", () => {
    const v = detectFormat(SID_FRESH)
    expect(v.format).toBe("sqlite")
    expect(v.hasLegacyDebris).toBe(false)
    expect(v.hasMigrationTmp).toBe(false)
  })

  it("only .db present → sqlite", async () => {
    await SqliteStore.upsertMessage(user(SID_SQLITE, "msg_a"))
    ConnectionPool.closeAll()
    const v = detectFormat(SID_SQLITE)
    expect(v.format).toBe("sqlite")
    expect(v.hasLegacyDebris).toBe(false)
  })

  it("only legacy directory present → legacy", async () => {
    await makeLegacyDir(SID_LEGACY)
    const v = detectFormat(SID_LEGACY)
    expect(v.format).toBe("legacy")
    expect(v.hasLegacyDebris).toBe(false)
  })

  it("both .db AND legacy dir present without tmp → sqlite + debris flag", async () => {
    await SqliteStore.upsertMessage(user(SID_DEBRIS, "msg_a"))
    ConnectionPool.closeAll()
    await makeLegacyDir(SID_DEBRIS)
    const v = detectFormat(SID_DEBRIS)
    expect(v.format).toBe("sqlite")
    expect(v.hasLegacyDebris).toBe(true)
  })

  it("legacy dir + tmp present (mid-migration crash) → legacy authoritative", async () => {
    await makeLegacyDir(SID_TMP_INFLIGHT)
    await makeTmpFile(SID_TMP_INFLIGHT)
    const v = detectFormat(SID_TMP_INFLIGHT)
    expect(v.format).toBe("legacy")
    expect(v.hasMigrationTmp).toBe(true)
  })
})

describe("Router dispatch", () => {
  it("dispatches reads to SqliteStore for sqlite-format sessions", async () => {
    await Router.upsertMessage(user(SID_SQLITE, "msg_a"))
    const got = await Router.get({ sessionID: SID_SQLITE, messageID: "msg_a" })
    expect(got.info.id).toBe("msg_a")
  })

  it("dispatches writes to SqliteStore for fresh sessions (creates .db)", async () => {
    await Router.upsertMessage(user(SID_FRESH, "msg_a"))
    const dbPath = ConnectionPool.resolveDbPath(SID_FRESH)
    expect(await fs.stat(dbPath).then(() => true).catch(() => false)).toBe(true)
  })

  it("does not silently fall back from SqliteStore on read error (DD-13 / INV-4)", async () => {
    // Build a healthy SQLite session, then corrupt it. Router should
    // still dispatch to SqliteStore (because the .db file is there) and
    // the resulting integrity_check throw must propagate — NOT switch
    // to LegacyStore even if a legacy dir happens to exist (it doesn't
    // here, but the contract is the same).
    await Router.upsertMessage(user(SID_SQLITE, "msg_a"))
    ConnectionPool.closeAll()
    const dbPath = ConnectionPool.resolveDbPath(SID_SQLITE)
    const handle = await fs.open(dbPath, "r+")
    const buf = Buffer.alloc(64, 0xff)
    await handle.write(buf, 0, buf.length, 100)
    await handle.close()
    await expect(Router.get({ sessionID: SID_SQLITE, messageID: "msg_a" })).rejects.toThrow()
    expect(ConnectionPool.stats().size).toBe(0)
  })

  it("dispatches reads to LegacyStore for legacy-format sessions", async () => {
    // Set up a minimal legacy session that LegacyStore can read.
    // We don't write a real info.json here — just verify the dispatch
    // side: stream() against a legacy session goes through LegacyStore,
    // which yields nothing because no messages exist.
    await makeLegacyDir(SID_LEGACY)
    const collected = []
    for await (const m of Router.stream(SID_LEGACY)) collected.push(m)
    expect(collected.length).toBe(0) // empty legacy dir → empty stream
  })
})

describe("Router debris queue", () => {
  it("schedules legacy directory delete when both formats present", async () => {
    await SqliteStore.upsertMessage(user(SID_DEBRIS, "msg_a"))
    ConnectionPool.closeAll()
    await makeLegacyDir(SID_DEBRIS)
    // Trigger format detection by issuing a read through Router.
    await Router.get({ sessionID: SID_DEBRIS, messageID: "msg_a" })
    expect(pendingDebris()).toContain(SID_DEBRIS)
  })

  it("drainLegacyDebris removes the legacy directory and clears the queue", async () => {
    await SqliteStore.upsertMessage(user(SID_DEBRIS, "msg_a"))
    ConnectionPool.closeAll()
    await makeLegacyDir(SID_DEBRIS)
    await Router.get({ sessionID: SID_DEBRIS, messageID: "msg_a" }) // schedules
    expect(pendingDebris()).toContain(SID_DEBRIS)

    const result = await drainLegacyDebris()
    expect(result.deleted).toContain(SID_DEBRIS)
    expect(pendingDebris()).not.toContain(SID_DEBRIS)
    expect(await fs.stat(legacySessionDir(SID_DEBRIS)).then(() => true).catch(() => false)).toBe(false)
  })

  it("drainLegacyDebris is a no-op for sessions whose state changed since scheduling", async () => {
    // Schedule debris, then manually delete legacy before drain.
    await SqliteStore.upsertMessage(user(SID_DEBRIS, "msg_a"))
    ConnectionPool.closeAll()
    await makeLegacyDir(SID_DEBRIS)
    await Router.get({ sessionID: SID_DEBRIS, messageID: "msg_a" })
    await fs.rm(legacySessionDir(SID_DEBRIS), { recursive: true, force: true })
    const result = await drainLegacyDebris()
    expect(result.deleted).not.toContain(SID_DEBRIS)
    expect(pendingDebris()).not.toContain(SID_DEBRIS)
  })
})

describe("Router parts(messageID) without sessionID falls through to LegacyStore", () => {
  it("returns whatever LegacyStore yields when sessionID omitted", async () => {
    // No legacy data exists, but the call should NOT touch SqliteStore.
    // Router has no way to map messageID → sessionID without help, so
    // legacy is the only honest answer. We just verify it doesn't throw.
    const parts = await Router.parts("msg_unknown_router_test")
    expect(parts).toEqual([])
  })
})
