import { describe, expect, test } from "bun:test"
import path from "path"
import { SessionCompaction } from "../../src/session/compaction"
import { deriveObservedCondition, TRIGGER_INVENTORY } from "../../src/session/prompt"
import { Token } from "../../src/util/token"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerId: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

describe("session.compaction.isOverflow", () => {
  test("returns true when token count exceeds usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  }, 15_000)

  test("returns false when token count within usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("includes cache.read in token count", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("respects input limit for input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when input/output are within input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when output within limit with input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  test("BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        // We've used 198K tokens total. Only 2K under the input limit.
        // On the next turn, the full conversation (198K) becomes input,
        // plus the model needs room to generate output — this WILL overflow.
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 180K + 3K + 15K = 198K
        // usable = limit.input = 200K (no output subtracted!)
        // 198K > 200K = false → no compaction triggered

        // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
        // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

        // With 198K used and only 2K headroom, the next turn will overflow.
        // Compaction MUST trigger here.
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("BUG: without limit.input, same token count correctly triggers compaction", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Same model but without limit.input — uses context - output instead
        const model = createModel({ context: 200_000, output: 32_000 })

        // Same token usage as above
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K
        // usable = context - output = 200K - 32K = 168K
        // 198K > 168K = true → compaction correctly triggered

        const result = await SessionCompaction.isOverflow({ tokens, model })
        expect(result).toBe(true) // ← Correct: headroom is reserved
      },
    })
  })

  test("BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // 170K total tokens — well above context-output (168K) but below input limit (200K)
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = await SessionCompaction.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = await SessionCompaction.isOverflow({ tokens, model: withoutInputLimit })

        // Both models have identical real capacity — they should agree:
        expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
        expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
      },
    })
  })

  test("returns false when model context limit is 0", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("respects project-local compaction.auto in test environment", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            compaction: { auto: false },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        // test environment keeps project config enabled for coverage paths.
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })
})

describe("session.compaction.kindChainFor", () => {
  test("provider-switched keeps replay-tail as local fallback", () => {
    expect(SessionCompaction.kindChainFor("provider-switched")).toEqual(["narrative", "replay-tail"])
  })

  test("codex provider: server-side compaction first, regardless of context ratio / subscription flag", () => {
    // codex sub at high ctx → server first
    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "cache-aware",
        providerId: "codex",
        isSubscription: true,
        ctxRatio: 0.8,
      }),
    ).toEqual(["low-cost-server", "narrative", "replay-tail", "llm-agent"])

    // codex non-sub at high ctx → ALSO server first (sub flag no longer gates)
    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "cache-aware",
        providerId: "codex",
        isSubscription: false,
        ctxRatio: 0.8,
      }),
    ).toEqual(["low-cost-server", "narrative", "replay-tail", "llm-agent"])

    // codex at low ctx → still server first (no threshold gate anymore)
    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "cache-aware",
        providerId: "codex",
        ctxRatio: 0.3,
      }),
    ).toEqual(["low-cost-server", "narrative", "replay-tail", "llm-agent"])
  })

  test("non-codex provider: local-first chain unchanged regardless of subscription / context", () => {
    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "cache-aware",
        providerId: "openai",
        isSubscription: true,
        ctxRatio: 0.8,
      }),
    ).toEqual(["narrative", "replay-tail", "low-cost-server", "llm-agent"])

    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "manual",
        providerId: "anthropic",
      }),
    ).toEqual(["narrative", "low-cost-server", "llm-agent"])
  })

  test("codex chain handles observed events that don't normally include low-cost-server", () => {
    // For idle/rebind/etc the base chain has no `low-cost-server`. On
    // codex we still prepend it so the model can lean on the codex
    // server-side compactor when available; chain falls through to
    // local kinds if the server is unreachable / errors.
    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "idle",
        providerId: "codex",
      }),
    ).toEqual(["low-cost-server", "narrative", "replay-tail"])

    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "rebind",
        providerId: "codex",
      }),
    ).toEqual(["low-cost-server", "narrative", "replay-tail"])

    expect(
      SessionCompaction.__test__.resolveKindChain({
        observed: "empty-response",
        providerId: "codex",
      }),
    ).toEqual(["low-cost-server", "narrative", "replay-tail", "llm-agent"])
  })
})

describe("session.prompt trigger inventory", () => {
  test("declares compaction trigger precedence explicitly", () => {
    expect(TRIGGER_INVENTORY.map((trigger) => trigger.id)).toEqual([
      "cooldown",
      "manual",
      "auto-request",
      "continuation-invalidated",
      "provider-switched",
      "account-rebind",
      "overflow",
      "stall-recovery",
      "predicted-cache-miss",
      "quota-pressure",
      "cache-aware",
    ])
  })

  test("fires predicted cache miss only when high context and miss are explicit", async () => {
    const base = {
      sessionID: "ses_test",
      step: 1,
      msgs: [],
      lastFinished: {
        id: "msg_a",
        role: "assistant",
        sessionID: "ses_test",
        parentID: "msg_u",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 160_000, output: 1, reasoning: 0, cache: { read: 10_000, write: 0 } },
        modelID: "test-model",
        providerId: "test",
        time: { created: Date.now() },
        finish: "stop",
      } as any,
      pinnedProviderId: "test",
      pinnedAccountId: undefined,
      hasUnprocessedCompactionRequest: false,
      compactionRequestAuto: undefined,
      parentID: undefined,
      continuationInvalidatedAt: undefined,
      currentInputTokens: 160_000,
      modelContextWindow: 200_000,
      isOverflow: async () => false,
      isCacheAware: async () => false,
    }

    expect(await deriveObservedCondition({ ...base, predictedCacheMiss: "miss" })).toBe("cache-aware")
    expect(await deriveObservedCondition({ ...base, predictedCacheMiss: "unknown" })).toBeNull()
    expect(await deriveObservedCondition({ ...base, predictedCacheMiss: "miss", currentInputTokens: 80_000 })).toBeNull()
  })

  test("fires stall-recovery without Continue injection", async () => {
    const user = {
      info: { id: "msg_u", role: "user", sessionID: "ses_test", time: { created: 1 }, agent: "build", model: { providerId: "test", modelID: "test-model" } },
      parts: [{ type: "text", text: "continue" }],
    } as any
    const emptyAssistant = (id: string) =>
      ({
        info: {
          id,
          role: "assistant",
          sessionID: "ses_test",
          parentID: "msg_u",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 120_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test-model",
          providerId: "test",
          time: { created: 2 },
          finish: "unknown",
        },
        parts: [],
      }) as any

    const observed = await deriveObservedCondition({
      sessionID: "ses_test",
      step: 2,
      msgs: [user, emptyAssistant("msg_a1"), emptyAssistant("msg_a2")],
      lastFinished: emptyAssistant("msg_a2").info,
      pinnedProviderId: "test",
      pinnedAccountId: undefined,
      hasUnprocessedCompactionRequest: false,
      compactionRequestAuto: undefined,
      parentID: undefined,
      continuationInvalidatedAt: undefined,
      currentInputTokens: 120_000,
      modelContextWindow: 200_000,
      isOverflow: async () => false,
      isCacheAware: async () => false,
    })

    expect(observed).toBe("stall-recovery")
    expect(SessionCompaction.kindChainFor("stall-recovery")).toEqual(["narrative", "replay-tail", "low-cost-server", "llm-agent"])
    expect(SessionCompaction.__test__.INJECT_CONTINUE["stall-recovery"]).toBe(false)
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("session.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("does not subtract cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles reasoning tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: 100,
      },
    })

    expect(result.tokens.reasoning).toBe(100)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
        // These providers typically report total as input + output only,
        // excluding cache read/write.
        totalTokens: 1500,
        cachedInputTokens: 200,
      }
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = Session.getUsage({
          model,
          usage,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        expect(result.tokens.input).toBe(1000)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        expect(result.tokens.total).toBe(2000)
        return
      }

      const result = Session.getUsage({
        model,
        usage,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      expect(result.tokens.input).toBe(1000)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      expect(result.tokens.total).toBe(2000)
    },
  )
})
