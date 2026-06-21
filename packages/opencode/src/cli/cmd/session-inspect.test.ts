import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"

import type { MessageV2 } from "../../session/message-v2"
import { Storage } from "../../storage/storage"
import { Router } from "../../session/storage/router"
import { ConnectionPool } from "../../session/storage/pool"
import { SessionInspect } from "./session-inspect"

const SID_SQLITE = "ses_test_inspect_sqlite"
const SID_LEGACY = "ses_test_inspect_legacy"
const MID_USER = "msg_inspect_aaa"
const MID_ASSISTANT = "msg_inspect_bbb"
const PID_TEXT = "prt_inspect_aaa"

function legacyDir(sessionID: string): string {
  return path.join(path.dirname(ConnectionPool.resolveDbPath(sessionID)), sessionID)
}

function user(sessionID: string): MessageV2.User {
  return {
    id: MID_USER,
    sessionID,
    role: "user",
    time: { created: 1700000000000 },
    agent: "build",
    model: { providerId: "anthropic", modelID: "claude-opus-4-7" },
  }
}

function assistant(sessionID: string): MessageV2.Assistant {
  return {
    id: MID_ASSISTANT,
    sessionID,
    role: "assistant",
    time: { created: 1700000001000, completed: 1700000002000 },
    parentID: MID_USER,
    modelID: "claude-opus-4-7",
    providerId: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/repo", root: "/tmp/repo" },
    cost: 0,
    tokens: { total: 42, input: 20, output: 22, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

function textPart(sessionID: string): MessageV2.Part {
  return {
    id: PID_TEXT,
    sessionID,
    messageID: MID_ASSISTANT,
    type: "text",
    text: "hello from inspect",
    synthetic: false,
  } as MessageV2.Part
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
  await clean(SID_SQLITE)
  await clean(SID_LEGACY)
})

afterEach(async () => {
  ConnectionPool.closeAll()
  await clean(SID_SQLITE)
  await clean(SID_LEGACY)
})

describe("session-inspect", () => {
  it("lists SQLite messages as a stable table", async () => {
    await Router.upsertMessage(user(SID_SQLITE))
    await Router.upsertMessage(assistant(SID_SQLITE))

    const result = await SessionInspect.list(SID_SQLITE)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("id               role       time_created   finish  tokens_total")
    expect(result.stdout).toContain("msg_inspect_bbb  assistant  1700000001000  stop    42")
    expect(result.stdout).toContain("msg_inspect_aaa  user       1700000000000          0")
  })

  it("shows one SQLite message with ordered parts as JSON", async () => {
    await Router.upsertMessage(user(SID_SQLITE))
    await Router.upsertMessage(assistant(SID_SQLITE))
    await Router.upsertPart(textPart(SID_SQLITE))

    const result = await SessionInspect.show(SID_SQLITE, MID_ASSISTANT)
    const parsed = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(0)
    expect(parsed.info.id).toBe(MID_ASSISTANT)
    expect(parsed.info.tokens.total).toBe(42)
    expect(parsed.parts.map((part: MessageV2.Part) => part.id)).toEqual([PID_TEXT])
  })

  it("checks SQLite integrity", async () => {
    await Router.upsertMessage(user(SID_SQLITE))
    ConnectionPool.closeAll()

    const result = await SessionInspect.check(SID_SQLITE)

    expect(result).toEqual({ stdout: "ok\n", exitCode: 0 })
  })

  it("inspects a sqlite session end-to-end (list, show, check)", async () => {
    // Post-teardown there is no legacy format: every session is sqlite.
    // session-inspect operates uniformly through the Router/SqliteStore.
    await Storage.write(["session", SID_SQLITE], { id: SID_SQLITE, projectID: "proj_test" })
    await Router.upsertMessage(user(SID_SQLITE))
    await Router.upsertMessage(assistant(SID_SQLITE))
    await Router.upsertPart(textPart(SID_SQLITE))
    ConnectionPool.closeAll()

    const listed = await SessionInspect.list(SID_SQLITE)
    const shown = await SessionInspect.show(SID_SQLITE, MID_ASSISTANT)
    const checked = await SessionInspect.check(SID_SQLITE)

    expect(listed.stdout).toContain("msg_inspect_bbb  assistant  1700000001000  stop    42")
    expect(JSON.parse(shown.stdout).parts[0].id).toBe(PID_TEXT)
    expect(checked).toEqual({ stdout: "ok\n", exitCode: 0 })
    expect(
      await fs
        .stat(ConnectionPool.resolveDbPath(SID_SQLITE))
        .then(() => true)
        .catch(() => false),
    ).toBe(true)
  })
})
