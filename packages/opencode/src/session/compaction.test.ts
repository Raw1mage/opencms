import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Config } from "@/config/config"

const originalConfigGet = Config.get

afterEach(() => {
  ;(Config as any).get = originalConfigGet
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
})
