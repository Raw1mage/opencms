import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"

import type { MessageV2 } from "../message-v2"
import { Storage } from "../../storage/storage"
import { DreamingWorker } from "./dreaming"
import { LegacyStore } from "./legacy"
import { ConnectionPool } from "./pool"
import { detectFormat, drainLegacyDebris, Router } from "./router"

const SIDS = [
  "ses_test_dreaming_happy",
  "ses_test_dreaming_before_rename",
  "ses_test_dreaming_after_rename",
  "ses_test_dreaming_row_count",
  "ses_test_dreaming_integrity",
  "ses_test_dreaming_no_preempt",
  "ses_test_dreaming_old",
  "ses_test_dreaming_new",
  "ses_test_dreaming_nested_diff",
]

function legacyDir(sessionID: string): string {
  return path.join(path.dirname(ConnectionPool.resolveDbPath(sessionID)), sessionID)
}

function tmpPath(sessionID: string): string {
  return ConnectionPool.resolveDbPath(sessionID) + ".tmp"
}

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

function assistant(sessionID: string, id: string, parentID: string): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1700000001000, completed: 1700000002000 },
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

function textPart(sessionID: string, messageID: string, id: string, text: string): MessageV2.Part {
  return { id, sessionID, messageID, type: "text", text, synthetic: false } as MessageV2.Part
}

async function seedLegacy(sessionID: string): Promise<void> {
  const u = user(sessionID, "msg_aaa" + sessionID.replace(/[^a-z0-9]/g, "").slice(-8))
  const a = assistant(sessionID, "msg_bbb" + sessionID.replace(/[^a-z0-9]/g, "").slice(-8), u.id)
  await Storage.write(["session", sessionID], { id: sessionID, projectID: "proj_test" })
  await LegacyStore.upsertMessage(u)
  await LegacyStore.upsertMessage(a)
  await LegacyStore.upsertPart(
    textPart(sessionID, a.id, "prt_aaa" + sessionID.replace(/[^a-z0-9]/g, "").slice(-8), "hello"),
  )
}

async function clean(sessionID: string): Promise<void> {
  ConnectionPool.close(sessionID)
  const db = ConnectionPool.resolveDbPath(sessionID)
  for (const p of [db, db + "-wal", db + "-shm", db + ".tmp", db + ".tmp-wal", db + ".tmp-shm"]) {
    await fs.rm(p, { force: true }).catch(() => {})
  }
  await fs.rm(legacyDir(sessionID), { recursive: true, force: true }).catch(() => {})
}

beforeEach(async () => {
  ConnectionPool.closeAll()
  for (const sid of SIDS) await clean(sid)
})

afterEach(async () => {
  ConnectionPool.closeAll()
  for (const sid of SIDS) await clean(sid)
})

describe("DreamingWorker migration", () => {
  it("migrates one legacy session into SQLite and deletes legacy directory", async () => {
    const sid = "ses_test_dreaming_happy"
    await seedLegacy(sid)

    await DreamingWorker.migrateSession(sid)

    expect(
      await fs
        .stat(ConnectionPool.resolveDbPath(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
    expect(
      await fs
        .stat(legacyDir(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    const db = new Database(ConnectionPool.resolveDbPath(sid), { readonly: true, create: false })
    try {
      expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()?.c).toBe(2)
      expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM parts").get()?.c).toBe(1)
      expect(
        db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'legacy_message_count'").get()?.value,
      ).toBe("2")
    } finally {
      db.close()
    }
  })

  it("startup cleanup deletes orphaned tmp before rename while preserving legacy", async () => {
    const sid = "ses_test_dreaming_before_rename"
    await seedLegacy(sid)

    await expect(
      DreamingWorker.migrateSession(sid, {
        hooks: {
          beforeRename: () => {
            throw new Error("simulated crash before rename")
          },
        },
      }),
    ).rejects.toThrow(/simulated crash/)

    expect(
      await fs
        .stat(tmpPath(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
    expect(
      await fs
        .stat(legacyDir(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
    const result = await DreamingWorker.cleanupStartup()
    expect(result.deletedTmp).toContain(sid)
    expect(
      await fs
        .stat(tmpPath(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    expect(detectFormat(sid).format).toBe("legacy")
  })

  it("post-rename crash leaves debris; router prefers SQLite and idle drain removes legacy", async () => {
    const sid = "ses_test_dreaming_after_rename"
    await seedLegacy(sid)

    await expect(
      DreamingWorker.migrateSession(sid, {
        hooks: {
          afterRename: () => {
            throw new Error("simulated crash after rename")
          },
        },
      }),
    ).rejects.toThrow(/simulated crash/)

    expect(detectFormat(sid)).toMatchObject({ format: "sqlite", hasLegacyDebris: true })
    await Router.get({ sessionID: sid, messageID: "msg_bbb" + sid.replace(/[^a-z0-9]/g, "").slice(-8) })
    const drained = await drainLegacyDebris()
    expect(drained.deleted).toContain(sid)
    expect(
      await fs
        .stat(legacyDir(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })

  it("row count mismatch deletes tmp and keeps legacy authoritative", async () => {
    const sid = "ses_test_dreaming_row_count"
    await seedLegacy(sid)

    await expect(DreamingWorker.migrateSession(sid, { hooks: { overrideSqliteRowCount: () => 99 } })).rejects.toThrow(
      /row count/,
    )

    expect(
      await fs
        .stat(tmpPath(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    expect(detectFormat(sid).format).toBe("legacy")
  })

  it("integrity check failure deletes tmp and keeps legacy authoritative", async () => {
    const sid = "ses_test_dreaming_integrity"
    await seedLegacy(sid)

    await expect(
      DreamingWorker.migrateSession(sid, {
        hooks: {
          beforeIntegrityCheck: async (_sessionID, dbPath) => {
            const handle = await fs.open(dbPath, "r+")
            try {
              await handle.write(Buffer.alloc(64, 0xff), 0, 64, 100)
            } finally {
              await handle.close()
            }
          },
        },
      }),
    ).rejects.toThrow()

    expect(
      await fs
        .stat(tmpPath(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    expect(detectFormat(sid).format).toBe("legacy")
  })

  it("legacy reads do not trigger immediate migration", async () => {
    const sid = "ses_test_dreaming_no_preempt"
    await seedLegacy(sid)

    const messages: MessageV2.WithParts[] = []
    for await (const message of Router.stream(sid)) messages.push(message)

    expect(messages.length).toBe(2)
    expect(
      await fs
        .stat(ConnectionPool.resolveDbPath(sid))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    expect(detectFormat(sid).format).toBe("legacy")
  })

  it("prunes oversized tool diffs stored under state.metadata during migration", async () => {
    const sid = "ses_test_dreaming_nested_diff"
    await seedLegacy(sid)
    const suffix = sid.replace(/[^a-z0-9]/g, "").slice(-8)
    const nestedDiffPartID = "prt_nested" + suffix
    await LegacyStore.upsertPart({
      id: nestedDiffPartID,
      sessionID: sid,
      messageID: "msg_bbb" + suffix,
      type: "tool",
      callID: "call_nested_diff",
      tool: "apply_patch",
      state: {
        status: "completed",
        input: { patchText: "*** Begin Patch\n*** Delete File: script/test-bin\n*** End Patch" },
        output: "Success. Updated the following files:\nD script/test-bin",
        title: "Success. Updated the following files:\nD script/test-bin",
        metadata: {
          diff: "x".repeat(300_000),
          files: [
            {
              filePath: "/tmp/script/test-bin",
              relativePath: "script/test-bin",
              type: "delete",
              diff: "y".repeat(300_000),
              before: "z".repeat(300_000),
              after: "",
              additions: 0,
              deletions: 1,
            },
          ],
        },
        time: { start: 1700000001000, end: 1700000002000 },
      },
      metadata: { openai: { itemId: "item_nested_diff" } },
    } as MessageV2.Part)

    await DreamingWorker.migrateSession(sid)

    const db = new Database(ConnectionPool.resolveDbPath(sid), { readonly: true, create: false })
    try {
      const row = db
        .query<{ payload_json: string }, [string]>("SELECT payload_json FROM parts WHERE id = ?")
        .get(nestedDiffPartID)
      expect(row).toBeTruthy()
      const payload = JSON.parse(row!.payload_json) as {
        state: {
          metadata: {
            diff: string
            dreamPruned?: boolean
            files: Array<{ diff: string; before: string; dreamPruned?: boolean }>
          }
        }
      }
      expect(payload.state.metadata.diff).toContain("dream-pruned: dropped 300,000 bytes of diff")
      expect(payload.state.metadata.dreamPruned).toBe(true)
      expect(payload.state.metadata.files[0].diff).toContain("dream-pruned: dropped 300,000 bytes of file diff")
      expect(payload.state.metadata.files[0].before).toContain(
        "dream-pruned: dropped 300,000 bytes of file before snapshot",
      )
      expect(payload.state.metadata.files[0].dreamPruned).toBe(true)
      expect(row!.payload_json.length).toBeLessThan(10_000)
    } finally {
      db.close()
    }
  })

  it("idle tick migrates exactly one oldest legacy session", async () => {
    await seedLegacy("ses_test_dreaming_old")
    await seedLegacy("ses_test_dreaming_new")
    const oldMessages = path.join(legacyDir("ses_test_dreaming_old"), "messages")
    const newMessages = path.join(legacyDir("ses_test_dreaming_new"), "messages")
    const oldDate = new Date(1700000000000)
    const newDate = new Date(1700000100000)
    await fs.utimes(oldMessages, oldDate, oldDate)
    await fs.utimes(newMessages, newDate, newDate)

    let now = 10_000
    const worker = new DreamingWorker({ idleThresholdMs: 5_000, now: () => now })
    now = 20_000
    const result = await worker.tick()

    expect(result.migrated).toBe("ses_test_dreaming_old")
    expect(
      await fs
        .stat(ConnectionPool.resolveDbPath("ses_test_dreaming_old"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
    expect(
      await fs
        .stat(ConnectionPool.resolveDbPath("ses_test_dreaming_new"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })
})
