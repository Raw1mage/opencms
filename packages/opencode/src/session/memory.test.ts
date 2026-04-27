import { afterEach, describe, expect, it, mock } from "bun:test"
import { Memory } from "./memory"
import { SharedContext } from "./shared-context"
import { Storage } from "@/storage/storage"
import { Global } from "@/global"
import fs from "fs/promises"
import os from "os"
import path from "path"

const originalSharedGet = SharedContext.get
const originalStorageRead = Storage.read
const originalStorageWrite = Storage.write
const originalStatePath = Global.Path.state

afterEach(() => {
  ;(SharedContext as any).get = originalSharedGet
  ;(Storage as any).read = originalStorageRead
  ;(Storage as any).write = originalStorageWrite
  Global.Path.state = originalStatePath
})

describe("Memory", () => {
  it("read returns empty SessionMemory when no new path and no legacy data", async () => {
    ;(Storage as any).read = mock(async () => undefined)
    ;(Storage as any).write = mock(async () => {})
    ;(SharedContext as any).get = mock(async () => undefined)
    Global.Path.state = await fs.mkdtemp(path.join(os.tmpdir(), "memory-empty-"))

    const sid = "ses_memory_empty_test"
    const mem = await Memory.read(sid)

    expect(mem.sessionID).toBe(sid)
    expect(mem.version).toBe(0)
    expect(mem.turnSummaries).toEqual([])
    expect(mem.fileIndex).toEqual([])
    expect(mem.actionLog).toEqual([])
    expect(mem.lastCompactedAt).toBeNull()
    expect(mem.rawTailBudget).toBe(5)
  })

  it("read prefers new path when present", async () => {
    const sid = "ses_memory_new_path_test"
    const stored: Memory.SessionMemory = {
      sessionID: sid,
      version: 7,
      updatedAt: 1700000000000,
      turnSummaries: [
        {
          turnIndex: 0,
          userMessageId: "msg_u1",
          endedAt: 1700000000000,
          text: "did stuff",
          modelID: "gpt-5.5",
          providerId: "codex",
        },
      ],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: { round: 3, timestamp: 1700000000000 },
      rawTailBudget: 5,
    }
    ;(Storage as any).read = mock(async () => stored)
    ;(Storage as any).write = mock(async () => {})
    ;(SharedContext as any).get = mock(async () => {
      throw new Error("legacy SharedContext should not be touched when new path has data")
    })

    const mem = await Memory.read(sid)
    expect(mem.version).toBe(7)
    expect(mem.turnSummaries).toHaveLength(1)
    expect(mem.turnSummaries[0].text).toBe("did stuff")
    expect(mem.lastCompactedAt?.round).toBe(3)
  })

  it("read falls back to legacy SharedContext and projects shape correctly", async () => {
    const sid = "ses_memory_legacy_shared_test"
    ;(Storage as any).read = mock(async () => undefined)
    let writtenPayload: Memory.SessionMemory | undefined
    ;(Storage as any).write = mock(async (_key: string[], value: Memory.SessionMemory) => {
      writtenPayload = value
    })
    ;(SharedContext as any).get = mock(async () => ({
      sessionID: sid,
      version: 4,
      updatedAt: 1700000000000,
      budget: 8192,
      goal: "Build the auth flow",
      files: [
        { path: "/src/auth.ts", operation: "edit", lines: 200, updatedAt: 1700000000000 },
        { path: "/src/auth.test.ts", operation: "read", updatedAt: 1700000000100 },
      ],
      discoveries: ["found token format issue"],
      actions: [{ tool: "bash", summary: "Bash: bun test...", turn: 2, addedAt: 1700000000000 }],
      currentState: "tests passing",
    }))
    Global.Path.state = await fs.mkdtemp(path.join(os.tmpdir(), "memory-legacy-shared-"))

    const mem = await Memory.read(sid)

    // fileIndex preserves legacy SharedContext.files shape
    expect(mem.fileIndex).toHaveLength(2)
    expect(mem.fileIndex[0].path).toBe("/src/auth.ts")
    expect(mem.fileIndex[0].operation).toBe("edit")
    expect(mem.fileIndex[0].lines).toBe(200)

    // actionLog preserves SharedContext.actions
    expect(mem.actionLog).toHaveLength(1)
    expect(mem.actionLog[0].summary).toBe("Bash: bun test...")

    // legacy goal/discoveries/currentState synthesized into one bridge TurnSummary
    expect(mem.turnSummaries).toHaveLength(1)
    expect(mem.turnSummaries[0].userMessageId).toBe("<legacy-bridge-shared-context>")
    expect(mem.turnSummaries[0].text).toContain("Build the auth flow")
    expect(mem.turnSummaries[0].text).toContain("found token format issue")
    expect(mem.turnSummaries[0].text).toContain("tests passing")

    // lazy migration write happened
    expect(writtenPayload).toBeDefined()
    expect(writtenPayload?.sessionID).toBe(sid)
    expect(writtenPayload?.fileIndex).toHaveLength(2)
  })

  it("read falls back to legacy rebind-checkpoint disk file", async () => {
    const sid = "ses_memory_legacy_checkpoint_test"
    ;(Storage as any).read = mock(async () => undefined)
    ;(Storage as any).write = mock(async () => {})
    ;(SharedContext as any).get = mock(async () => undefined)

    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-legacy-checkpoint-"))
    Global.Path.state = tmpdir
    await fs.writeFile(
      path.join(tmpdir, `rebind-checkpoint-${sid}.json`),
      JSON.stringify({
        sessionID: sid,
        timestamp: 1700000000000,
        source: "shared-context",
        snapshot: "<shared_context>...legacy snapshot text...</shared_context>",
        lastMessageId: "msg_x",
      }),
    )

    const mem = await Memory.read(sid)

    expect(mem.turnSummaries).toHaveLength(1)
    expect(mem.turnSummaries[0].userMessageId).toBe("msg_x")
    expect(mem.turnSummaries[0].text).toContain("legacy snapshot text")
    expect(mem.turnSummaries[0].endedAt).toBe(1700000000000)
  })

  it("read merges both legacy sources when both present", async () => {
    const sid = "ses_memory_legacy_both_test"
    ;(Storage as any).read = mock(async () => undefined)
    ;(Storage as any).write = mock(async () => {})
    ;(SharedContext as any).get = mock(async () => ({
      sessionID: sid,
      version: 1,
      updatedAt: 1700000000000,
      budget: 8192,
      goal: "from shared context",
      files: [],
      discoveries: [],
      actions: [],
      currentState: "",
    }))

    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-legacy-both-"))
    Global.Path.state = tmpdir
    await fs.writeFile(
      path.join(tmpdir, `rebind-checkpoint-${sid}.json`),
      JSON.stringify({ sessionID: sid, snapshot: "from checkpoint", lastMessageId: "msg_y" }),
    )

    const mem = await Memory.read(sid)

    expect(mem.turnSummaries).toHaveLength(2)
    expect(mem.turnSummaries[0].text).toContain("from shared context")
    expect(mem.turnSummaries[1].text).toContain("from checkpoint")
  })

  it("write persists to the new Storage path with sessionID guard", async () => {
    const sid = "ses_memory_write_test"
    let writtenKey: string[] | undefined
    let writtenValue: Memory.SessionMemory | undefined
    ;(Storage as any).write = mock(async (key: string[], value: Memory.SessionMemory) => {
      writtenKey = key
      writtenValue = value
    })

    const mem: Memory.SessionMemory = {
      sessionID: sid,
      version: 1,
      updatedAt: 1,
      turnSummaries: [],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }
    await Memory.write(sid, mem)

    expect(writtenKey).toEqual(["session_memory", sid])
    expect(writtenValue?.sessionID).toBe(sid)

    // sessionID mismatch must throw
    await expect(Memory.write(sid, { ...mem, sessionID: "ses_other" })).rejects.toThrow(/mismatch/)
  })

  it("appendTurnSummary appends + bumps version + persists", async () => {
    const sid = "ses_memory_append_test"
    let stored: Memory.SessionMemory | undefined
    ;(Storage as any).read = mock(async () => stored)
    ;(Storage as any).write = mock(async (_k: string[], v: Memory.SessionMemory) => {
      stored = v
    })
    ;(SharedContext as any).get = mock(async () => undefined)

    const ts: Memory.TurnSummary = {
      turnIndex: 0,
      userMessageId: "msg_u1",
      endedAt: 100,
      text: "did stuff",
      modelID: "gpt-5.5",
      providerId: "codex",
    }
    await Memory.appendTurnSummary(sid, ts)

    expect(stored).toBeDefined()
    expect(stored?.turnSummaries).toHaveLength(1)
    expect(stored?.turnSummaries[0].text).toBe("did stuff")
    expect(stored?.version).toBe(1)

    // second append accumulates
    const ts2: Memory.TurnSummary = { ...ts, turnIndex: 1, userMessageId: "msg_u2", text: "more" }
    await Memory.appendTurnSummary(sid, ts2)
    expect(stored?.turnSummaries).toHaveLength(2)
    expect(stored?.version).toBe(2)
  })

  it("markCompacted writes lastCompactedAt", async () => {
    const sid = "ses_memory_mark_test"
    let stored: Memory.SessionMemory | undefined
    ;(Storage as any).read = mock(async () => stored)
    ;(Storage as any).write = mock(async (_k: string[], v: Memory.SessionMemory) => {
      stored = v
    })
    ;(SharedContext as any).get = mock(async () => undefined)

    await Memory.markCompacted(sid, { round: 7, timestamp: 1700000000000 })
    expect(stored?.lastCompactedAt).toEqual({ round: 7, timestamp: 1700000000000 })
    expect(stored?.version).toBe(1)

    // overwrite
    await Memory.markCompacted(sid, { round: 11 })
    expect(stored?.lastCompactedAt?.round).toBe(11)
    expect(stored?.version).toBe(2)
    expect(stored?.lastCompactedAt?.timestamp).toBeGreaterThan(0)
  })

  it("read normalizes shape for forward compatibility (missing newer fields)", async () => {
    const sid = "ses_memory_normalize_test"
    ;(Storage as any).read = mock(async () => ({
      sessionID: sid,
      version: 3,
      updatedAt: 1,
      turnSummaries: [],
      fileIndex: [],
      actionLog: [],
      // lastCompactedAt + rawTailBudget intentionally missing
    }))

    const mem = await Memory.read(sid)
    expect(mem.lastCompactedAt).toBeNull()
    expect(mem.rawTailBudget).toBe(5)
  })
})
