import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Config } from "@/config/config"
import { SharedContext } from "./shared-context"
import { Global } from "@/global"
import fs from "fs/promises"
import os from "os"
import path from "path"

const originalConfigGet = Config.get
const originalSharedContextSnapshot = SharedContext.snapshot
const originalGlobalPathState = Global.Path.state

afterEach(() => {
  ;(Config as any).get = originalConfigGet
  ;(SharedContext as any).snapshot = originalSharedContextSnapshot
  Global.Path.state = originalGlobalPathState
})

describe("SessionCompaction cooldown guard", () => {
  it("suppresses repeated overflow compaction within cooldown rounds for high-prefix sessions", async () => {
    ;(Config as any).get = mock(async () => ({
      compaction: {
        auto: true,
        cooldownRounds: 4,
        reserved: 20_000,
      },
    }))

    const model = {
      id: "gpt-5.4",
      providerId: "openai",
      limit: {
        context: 272_000,
        input: 272_000,
        output: 32_000,
      },
      cost: {
        input: 1,
      },
    } as any

    const tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 260_000,
    }

    const sessionID = `ses_compaction_cooldown_${Date.now()}`
    SessionCompaction.recordCompaction(sessionID, 1)

    await expect(
      SessionCompaction.isOverflow({
        tokens,
        model,
        sessionID,
        currentRound: 2,
      }),
    ).resolves.toBe(false)

    await expect(
      SessionCompaction.isOverflow({
        tokens,
        model,
        sessionID,
        currentRound: 5,
      }),
    ).resolves.toBe(true)
  })

  it("still triggers compaction at the emergency ceiling even during cooldown", async () => {
    ;(Config as any).get = mock(async () => ({
      compaction: {
        auto: true,
        cooldownRounds: 4,
        reserved: 20_000,
      },
    }))

    const model = {
      id: "gpt-5.4",
      providerId: "openai",
      limit: {
        context: 272_000,
        input: 272_000,
        output: 32_000,
      },
      cost: {
        input: 1,
      },
    } as any

    const tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 270_500,
    }

    const sessionID = `ses_compaction_emergency_${Date.now()}`
    SessionCompaction.recordCompaction(sessionID, 10)

    await expect(
      SessionCompaction.isOverflow({
        tokens,
        model,
        sessionID,
        currentRound: 11,
      }),
    ).resolves.toBe(true)
  })

  it("truncates compaction history for small-context models before overflowing the prompt window", () => {
    const model = {
      id: "small-model",
      providerId: "openai",
      limit: {
        context: 32_000,
        input: 32_000,
        output: 8_000,
      },
      cost: {
        input: 1,
      },
    } as any

    const messages = Array.from({ length: 20 }, (_, index) => ({
      info: {
        id: `msg_${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        providerId: "openai",
        modelID: "small-model",
      },
      parts: [
        {
          id: `part_${index}`,
          type: "text",
          text: `message-${index} ` + "x".repeat(10_000),
        },
      ],
    })) as any

    const result = SessionCompaction.truncateModelMessagesForSmallContext({
      messages,
      model,
      sessionID: "ses_small_context_test",
    })

    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result.messages).length).toBeLessThanOrEqual(result.safeCharBudget)
    expect(result.messages.length).toBeGreaterThan(0)
  })

  it("applies a safe rebind checkpoint only after a non-tool boundary", () => {
    const model = {
      id: "gpt-5.4",
      providerId: "openai",
    } as any

    const messages = [
      {
        info: {
          id: "msg_1",
          sessionID: "ses_rebind",
          role: "user",
          agent: "default",
          model: { providerId: "openai", modelID: "gpt-5.4" },
          time: { created: 1 },
        },
        parts: [{ id: "part_1", messageID: "msg_1", sessionID: "ses_rebind", type: "text", text: "hello" }],
      },
      {
        info: {
          id: "msg_2",
          sessionID: "ses_rebind",
          role: "assistant",
          parentID: "msg_1",
          mode: "default",
          agent: "default",
          modelID: "gpt-5.4",
          providerId: "openai",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2, completed: 2 },
        },
        parts: [{ id: "part_2", messageID: "msg_2", sessionID: "ses_rebind", type: "text", text: "answer" }],
      },
      {
        info: {
          id: "msg_3",
          sessionID: "ses_rebind",
          role: "user",
          agent: "default",
          model: { providerId: "openai", modelID: "gpt-5.4" },
          time: { created: 3 },
        },
        parts: [{ id: "part_3", messageID: "msg_3", sessionID: "ses_rebind", type: "text", text: "continue" }],
      },
    ] as any

    const applied = SessionCompaction.applyRebindCheckpoint({
      sessionID: "ses_rebind",
      checkpoint: {
        sessionID: "ses_rebind",
        timestamp: 10,
        snapshot: "checkpoint summary",
        lastMessageId: "msg_2",
      },
      messages,
      model,
    })

    expect(applied.applied).toBe(true)
    if (!applied.applied) throw new Error("expected checkpoint to apply")
    expect(applied.messages[0].info.role).toBe("assistant")
    expect((applied.messages[0].info as any).summary).toBe(true)
    expect((applied.messages[0].parts[0] as any).text).toContain("checkpoint summary")
    expect(applied.messages[1].info.id).toBe("msg_3")
  })

  it("persists rebind checkpoint metadata including lastMessageId", async () => {
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rebind-checkpoint-test-"))
    Global.Path.state = tmpdir
    ;(SharedContext as any).snapshot = mock(async () => "snapshot body")

    await SessionCompaction.saveRebindCheckpoint({
      sessionID: "ses_checkpoint",
      lastMessageId: "msg_last",
      currentRound: 4,
    })

    const checkpoint = await SessionCompaction.loadRebindCheckpoint("ses_checkpoint")
    expect(checkpoint?.snapshot).toBe("snapshot body")
    expect(checkpoint?.lastMessageId).toBe("msg_last")
    expect(typeof checkpoint?.timestamp).toBe("number")
  })

  it("prunes stale rebind checkpoints", async () => {
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rebind-checkpoint-prune-"))
    Global.Path.state = tmpdir
    const stalePath = path.join(tmpdir, "rebind-checkpoint-ses_stale.json")
    await fs.writeFile(
      stalePath,
      JSON.stringify({
        sessionID: "ses_stale",
        timestamp: 1,
        snapshot: "stale snapshot",
        lastMessageId: "msg_old",
      }),
    )
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.utimes(stalePath, staleTime, staleTime)

    await SessionCompaction.pruneStaleCheckpoints()

    await expect(fs.access(stalePath)).rejects.toBeDefined()
  })
})
