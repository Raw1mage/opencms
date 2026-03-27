import { describe, expect, it } from "bun:test"
import { Session } from "./index"

describe("Session.getUsage cache reuse", () => {
  it("maps by-token provider cachedInputTokens into cache.read telemetry", () => {
    const model = {
      id: "gpt-5.4",
      providerId: "openai",
      api: { npm: "@ai-sdk/openai" },
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 1.5 },
      },
    } as any

    const usage = Session.getUsage({
      model,
      usage: {
        inputTokens: 160000,
        outputTokens: 800,
        totalTokens: 160800,
        cachedInputTokens: 120000,
      } as any,
    })

    expect(usage.tokens.cache.read).toBe(120000)
    expect(usage.tokens.cache.write).toBe(0)
    expect(usage.tokens.input).toBe(40000)
    expect(usage.tokens.total).toBe(160800)
  })
})
