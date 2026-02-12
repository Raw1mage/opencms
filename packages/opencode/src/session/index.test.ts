import { describe, expect, it } from "bun:test"
import { Session } from "./index"

describe("Session.getUsage reasoning pricing", () => {
  const baseModel = {
    api: { npm: "@ai-sdk/openai" },
    cost: {
      input: 1,
      output: 2,
      cache: { read: 0, write: 0 },
    },
  } as any

  it("uses dedicated reasoning rate when provided", () => {
    const model = {
      ...baseModel,
      cost: {
        ...baseModel.cost,
        reasoning: 5,
      },
    }

    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        reasoningTokens: 1_000_000,
        cachedInputTokens: 0,
        totalTokens: 2_000_000,
      } as any,
    })

    expect(result.cost).toBe(6)
  })

  it("falls back to output rate when reasoning rate is absent", () => {
    const result = Session.getUsage({
      model: baseModel,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 1_000_000,
        cachedInputTokens: 0,
        totalTokens: 1_000_000,
      } as any,
    })

    expect(result.cost).toBe(2)
  })

  it("uses over-200k pricing tier for reasoning when threshold exceeded", () => {
    const model = {
      ...baseModel,
      cost: {
        ...baseModel.cost,
        reasoning: 1,
        experimentalOver200K: {
          input: 1,
          output: 1,
          reasoning: 9,
          cache: { read: 0, write: 0 },
        },
      },
    }

    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 210_000,
        outputTokens: 0,
        reasoningTokens: 1_000_000,
        cachedInputTokens: 0,
        totalTokens: 1_210_000,
      } as any,
    })

    // input: 0.21 + reasoning: 9 = 9.21
    expect(result.cost).toBe(9.21)
  })
})
