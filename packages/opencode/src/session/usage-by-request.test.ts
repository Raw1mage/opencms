import { describe, expect, it } from "bun:test"
import { Session } from "./index"

describe("Session.getUsage by-request cost posture", () => {
  it("keeps cost at zero for by-request providers even with large input context", () => {
    const model = {
      id: "gpt-4o",
      providerId: "github-copilot",
      api: { npm: "@ai-sdk/github-copilot" },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
    } as any

    const usage = Session.getUsage({
      model,
      usage: {
        inputTokens: 180000,
        outputTokens: 900,
        totalTokens: 180900,
      } as any,
    })

    expect(usage.tokens.input).toBe(180000)
    expect(usage.tokens.output).toBe(900)
    expect(usage.tokens.cache.read).toBe(0)
    expect(usage.cost).toBe(0)
  })
})
