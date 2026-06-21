import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"

// Spec: /specs/session-storage-db, DD-1.
// Post-teardown the Router is a thin pass-through to SqliteStore (Phase 4
// removed legacy format detection, dual-track dispatch, and debris
// scheduling). These tests verify the retained Backend surface still
// delegates correctly and that errors propagate (DD-13 / INV-4).
// Real disk under per-pid tmpdir per Global.ts NODE_ENV=test guard.

import { Router } from "./router"
import { SqliteStore } from "./sqlite"
import { ConnectionPool } from "./pool"
import type { MessageV2 } from "../message-v2"

const SID_FRESH = "ses_test_router_fresh"
const SID_SQLITE = "ses_test_router_sqlite"
const REF_A = "att_ref_router_001"

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

function attachmentBlob(sessionID: string) {
  return {
    refID: REF_A,
    sessionID,
    messageID: "msg_a",
    partID: "prt_a",
    mime: "text/plain",
    filename: "large.txt",
    byteSize: 5,
    estTokens: 2,
    createdAt: 1700000006000,
    content: new Uint8Array([104, 101, 108, 108, 111]),
  }
}

beforeEach(() => {
  ConnectionPool.closeAll()
})

afterEach(async () => {
  ConnectionPool.closeAll()
  for (const sid of [SID_FRESH, SID_SQLITE]) {
    const dbPath = ConnectionPool.resolveDbPath(sid)
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm", dbPath + ".tmp"]) {
      await fs.rm(p, { force: true }).catch(() => {})
    }
  }
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

  it("streams messages back through SqliteStore", async () => {
    await Router.upsertMessage(user(SID_SQLITE, "msg_a"))
    const collected: MessageV2.WithParts[] = []
    for await (const m of Router.stream(SID_SQLITE)) collected.push(m)
    expect(collected.map((m) => m.info.id)).toEqual(["msg_a"])
  })

  it("deleteSession clears the session's rows via SqliteStore", async () => {
    // SqliteStore.deleteSession clears rows and closes the pool but leaves
    // the .db file on disk by design (file-level removal is the caller's
    // policy, not a storage primitive). Verify the rows are gone.
    await Router.upsertMessage(user(SID_SQLITE, "msg_a"))
    await Router.deleteSession(SID_SQLITE)
    const collected: MessageV2.WithParts[] = []
    for await (const m of Router.stream(SID_SQLITE)) collected.push(m)
    expect(collected).toEqual([])
  })

  it("forwards attachment blob methods to SqliteStore", async () => {
    await Router.upsertMessage(user(SID_FRESH, "msg_a"))
    await Router.upsertAttachmentBlob(attachmentBlob(SID_FRESH))

    const got = await Router.getAttachmentBlob({ sessionID: SID_FRESH, refID: REF_A })
    expect([...got.content]).toEqual([104, 101, 108, 108, 111])
    expect(await Router.listAttachmentBlobs(SID_FRESH)).toEqual([
      expect.objectContaining({ refID: REF_A, sessionID: SID_FRESH }),
    ])

    await Router.removeAttachmentBlob({ sessionID: SID_FRESH, refID: REF_A })
    expect(await Router.listAttachmentBlobs(SID_FRESH)).toEqual([])
  })

  it("does not silently swallow SqliteStore read errors (DD-13 / INV-4)", async () => {
    // Build a healthy SQLite session, then corrupt it. The Router must let
    // the resulting integrity_check throw propagate — there is no second
    // backend to fall back to post-teardown.
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
})

describe("Router parts(messageID) requires sessionID post-teardown", () => {
  it("throws when sessionID omitted (no legacy fall-through)", async () => {
    // The legacy messageID-only fall-through is gone. SqliteStore needs to
    // know which DB to open, so the Router surfaces its throw (DD-13).
    await expect(Router.parts("msg_unknown_router_test")).rejects.toThrow(/requires sessionID/)
  })

  it("returns parts when sessionID is threaded through", async () => {
    await Router.upsertMessage(user(SID_SQLITE, "msg_a"))
    const parts = await Router.parts("msg_a", SID_SQLITE)
    expect(parts).toEqual([])
  })
})
