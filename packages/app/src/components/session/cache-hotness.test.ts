import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { cacheHotnessGlyph, computeCacheHotness } from "./cache-hotness"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  opts: { created?: number; providerID?: string; accountId?: string; summary?: boolean } = {},
) =>
  ({
    id,
    role: "assistant",
    providerID: opts.providerID ?? "openai",
    accountId: opts.accountId ?? "acct-1",
    modelID: "gpt-4.1",
    cost: 0,
    summary: opts.summary,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.read, write: tokens.write },
    },
    time: { created: opts.created ?? 1, completed: opts.created ?? 1 },
  }) as unknown as Message

// prev round establishes a 1000-token context (input=1000), cur reads it back.
const prev = (read = 0, write = 0, providerID?: string, accountId?: string) =>
  assistant("prev", { input: 1000 - read - write, output: 50, reasoning: 0, read, write }, {
    created: 1,
    providerID,
    accountId,
  })
const cur = (read: number, opts: { created?: number; providerID?: string; accountId?: string; summary?: boolean } = {}) =>
  assistant("cur", { input: 100, output: 20, reasoning: 0, read, write: 0 }, { created: 2, ...opts })

describe("computeCacheHotness", () => {
  test("undefined when no model round exists", () => {
    expect(computeCacheHotness([])).toBeUndefined()
    expect(computeCacheHotness([{ id: "u", role: "user", time: { created: 1 } } as unknown as Message])).toBeUndefined()
  })

  test("first round is seed (nothing to carry over)", () => {
    expect(computeCacheHotness([prev()])?.state).toBe("seed")
  })

  test("hot when ≥70% of last round's context is read back", () => {
    const h = computeCacheHotness([prev(), cur(900)])
    expect(h?.state).toBe("hot")
    expect(h?.carryRatio).toBeCloseTo(0.9, 5)
    expect(h?.prevContext).toBe(1000)
    expect(h?.currentRead).toBe(900)
  })

  test("warm in the 30–70% band", () => {
    expect(computeCacheHotness([prev(), cur(500)])?.state).toBe("warm")
  })

  test("cold when the context is effectively zeroed (cliff)", () => {
    const h = computeCacheHotness([prev(), cur(100)])
    expect(h?.state).toBe("cold")
    expect(h?.carryRatio).toBeCloseTo(0.1, 5)
  })

  test("provider switch is a planned reset, not cold", () => {
    expect(computeCacheHotness([prev(0, 0, "openai", "acct-1"), cur(0, { providerID: "anthropic" })])?.state).toBe(
      "reset",
    )
  })

  test("account switch is a planned reset", () => {
    expect(computeCacheHotness([prev(), cur(0, { accountId: "acct-2" })])?.state).toBe("reset")
  })

  test("compaction anchor (summary) is a planned reset", () => {
    expect(computeCacheHotness([prev(), cur(0, { summary: true })])?.state).toBe("reset")
  })

  test("ignores rounds that never hit the model (zero tokens)", () => {
    const empty = assistant("a0", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, { created: 0 })
    // empty round is skipped, so [empty, prev] still reads as a single real round → seed
    expect(computeCacheHotness([empty, prev()])?.state).toBe("seed")
  })

  test("orders by completion time, not array position", () => {
    // cur supplied before prev in the array; timestamps decide the latest round.
    expect(computeCacheHotness([cur(900), prev()])?.state).toBe("hot")
  })
})

describe("cacheHotnessGlyph", () => {
  test("maps each state to a thermal glyph", () => {
    expect(cacheHotnessGlyph("hot")).toBe("🔥")
    expect(cacheHotnessGlyph("warm")).toBe("🌡️")
    expect(cacheHotnessGlyph("cold")).toBe("❄️")
    expect(cacheHotnessGlyph("reset")).toBe("♻️")
    expect(cacheHotnessGlyph("seed")).toBe("·")
  })
})
