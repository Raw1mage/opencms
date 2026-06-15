import { describe, expect, test } from "bun:test"
import path from "path"
import { SessionCompaction } from "../../src/session/compaction"
import { deriveObservedCondition } from "../../src/session/prompt"
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
        // Context must stay > FreerunResolver.SMALL_WINDOW_TOKENS (128K) or
        // isOverflow short-circuits via the freerun bypass. usable = 200K - 32K
        // output cap = 168K; count 165K + 5K = 170K crosses it.
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 165_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
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
        // Context > 128K to avoid the freerun bypass. usable = 200K - 32K = 168K;
        // count = input 120K + output 10K + cache.read 50K = 180K crosses it,
        // and cache.read participates in the count.
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 120_000, output: 10_000, reasoning: 0, cache: { read: 50_000, write: 0 } }
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

describe("session.prompt trigger inventory", () => {
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
    expect(SessionCompaction.__test__.INJECT_CONTINUE["stall-recovery"]).toBe(false)
  })
})

describe("session.compaction.shouldCompactOnPredictedCacheLoss", () => {
  // Central decision authority shared by deriveObservedCondition's
  // predicted-cache-miss trigger and processor.ts's rotation cold-send guard.
  // Defaults: cacheLossFloor=0.5, minUncachedTokens=40_000.

  test("codex rotation cold send (cacheRead=0, large high-context prompt) → compact", () => {
    // 190k cache cliff on a 272k codex window: ratio 0.70 > 0.5, uncached 190k >= 40k.
    expect(
      SessionCompaction.shouldCompactOnPredictedCacheLoss({
        currentInputTokens: 190_000,
        cacheRead: 0,
        window: 272_000,
      }),
    ).toBe(true)
  })

  test("small context → full send (no compaction)", () => {
    // 50k on 272k window: ratio 0.18 ≤ 0.5. This is the post-compaction state,
    // so a subsequent rotation will NOT re-trigger → no cascade.
    expect(
      SessionCompaction.shouldCompactOnPredictedCacheLoss({
        currentInputTokens: 50_000,
        cacheRead: 0,
        window: 272_000,
      }),
    ).toBe(false)
  })

  test("high ratio but mostly cached (small uncached payload) → full send", () => {
    // ratio 0.73 > 0.5 but uncached = 200k-190k = 10k < 40k.
    expect(
      SessionCompaction.shouldCompactOnPredictedCacheLoss({
        currentInputTokens: 200_000,
        cacheRead: 190_000,
        window: 272_000,
      }),
    ).toBe(false)
  })

  test("ratio exactly at floor is not above it → full send", () => {
    // 50k / 100k = 0.5, strict `> cacheLossFloor` → false.
    expect(
      SessionCompaction.shouldCompactOnPredictedCacheLoss({
        currentInputTokens: 50_000,
        cacheRead: 0,
        window: 100_000,
      }),
    ).toBe(false)
  })

  test("unknown window (0) → full send", () => {
    expect(
      SessionCompaction.shouldCompactOnPredictedCacheLoss({
        currentInputTokens: 190_000,
        cacheRead: 0,
        window: 0,
      }),
    ).toBe(false)
  })
})

describe("session.prompt cache-cliff classification", () => {
  // Helper: small assistant frame with controllable cache.read.
  const finished = (sessionID: string, cacheRead: number) =>
    ({
      id: `msg_${sessionID}_${cacheRead}`,
      role: "assistant",
      sessionID,
      parentID: "msg_u",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 1000, output: 1, reasoning: 0, cache: { read: cacheRead, write: 0 } },
      modelID: "test-model",
      providerId: "test",
      time: { created: Date.now() },
      finish: "stop",
    }) as any

  const baseInput = (sessionID: string, accountId: string | undefined = "acct-A") => ({
    sessionID,
    step: 1,
    msgs: [],
    pinnedProviderId: "test",
    pinnedAccountId: accountId,
    hasUnprocessedCompactionRequest: false,
    compactionRequestAuto: undefined,
    parentID: undefined,
    continuationInvalidatedAt: undefined,
    // Must stay >= the warm-up cache read (100K) so the cliff predicate's
    // `compaction_shrinkage` planned-source (currentInputTokens < prev.cacheRead)
    // does not fire and mis-classify an unplanned cliff as planned.
    currentInputTokens: 150_000,
    modelContextWindow: 200_000,
    // Force unplanned-cliff path to short-circuit (return null), planned
    // path to fall through to overflow → return "overflow". This is how
    // we distinguish the two branches without intercepting side effects.
    isOverflow: async () => true,
    isCacheAware: async () => false,
  })

  test("unplanned cliff (no signals): invalidates and returns null even with isOverflow=true", async () => {
    const sid = "ses_cliff_unplanned"
    // Warm-up turn: 100K cache, no drop.
    await deriveObservedCondition({ ...baseInput(sid), lastFinished: finished(sid, 100_000) })
    // Next turn: cache crashes to 10K, same account, no anchor, no event.
    const observed = await deriveObservedCondition({ ...baseInput(sid), lastFinished: finished(sid, 10_000) })
    expect(observed).toBeNull()
  })

  test("planned cliff via account_switch: falls through to overflow", async () => {
    const sid = "ses_cliff_acct_switch"
    await deriveObservedCondition({ ...baseInput(sid, "acct-A"), lastFinished: finished(sid, 100_000) })
    const observed = await deriveObservedCondition({
      ...baseInput(sid, "acct-B"),
      lastFinished: finished(sid, 10_000),
    })
    expect(observed).toBe("overflow")
  })

  test("planned cliff via continuation_invalidated_event: falls through to downstream handler", async () => {
    const sid = "ses_cliff_cont_invalidated"
    await deriveObservedCondition({ ...baseInput(sid), lastFinished: finished(sid, 100_000) })
    const observed = await deriveObservedCondition({
      ...baseInput(sid),
      lastFinished: finished(sid, 10_000),
      continuationInvalidatedAt: Date.now(),
    })
    // Cliff predicate classifies this as planned (continuation-invalidated event
    // already fired), so it does NOT short-circuit with null. The downstream
    // continuation-invalidated handler then picks up the signal — exactly the
    // intended hand-off.
    expect(observed).toBe("continuation-invalidated")
  })

  test("no cliff (drop ≤ 50%): does not invalidate, falls through to overflow", async () => {
    const sid = "ses_no_cliff"
    await deriveObservedCondition({ ...baseInput(sid), lastFinished: finished(sid, 100_000) })
    // 100K → 60K is a 40% drop, predicate stays dormant.
    const observed = await deriveObservedCondition({ ...baseInput(sid), lastFinished: finished(sid, 60_000) })
    expect(observed).toBe("overflow")
  })

  test("no cliff (prev below 50K floor): does not invalidate even on >50% drop", async () => {
    const sid = "ses_low_prev"
    await deriveObservedCondition({ ...baseInput(sid), lastFinished: finished(sid, 40_000) })
    const observed = await deriveObservedCondition({ ...baseInput(sid), lastFinished: finished(sid, 1_000) })
    expect(observed).toBe("overflow")
  })

  // SL (stateless prompt-cache) providers bill cache as read + write. A turn
  // that re-writes the prefix shows low read + high write while input≈0 — the
  // prompt is still fully cached, NOT a cliff. The cache_read-only predicate
  // used to fire here (false positive). SL must NOT take the SS invalidate path.
  const slFinished = (sessionID: string, input: number, read: number, write: number) =>
    ({
      id: `msg_${sessionID}_${input}_${read}_${write}`,
      role: "assistant",
      sessionID,
      parentID: "msg_u",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input, output: 1, reasoning: 0, cache: { read, write } },
      modelID: "test-model",
      providerId: "claude-cli",
      time: { created: Date.now() },
      finish: "stop",
    }) as any

  test("SL re-cache turn (input≈0, read drop, write absorbs it): no cliff, falls through", async () => {
    const sid = "ses_sl_recache"
    const slBase = { ...baseInput(sid), pinnedProviderId: "claude-cli" }
    // Warm-up: 100K read.
    await deriveObservedCondition({ ...slBase, lastFinished: slFinished(sid, 0, 100_000, 0) })
    // read collapses 100K→5K but 95K is written → prompt still fully cached, input 0.
    const observed = await deriveObservedCondition({ ...slBase, lastFinished: slFinished(sid, 0, 5_000, 95_000) })
    // Must NOT be null — null is the SS invalidate path; SL is telemetry-only.
    expect(observed).toBe("overflow")
  })

  test("SS provider with the same read drop still cliffs → returns null", async () => {
    const sid = "ses_ss_contrast"
    const ssBase = { ...baseInput(sid), pinnedProviderId: "codex" }
    await deriveObservedCondition({ ...ssBase, lastFinished: finished(sid, 100_000) })
    const observed = await deriveObservedCondition({ ...ssBase, lastFinished: finished(sid, 10_000) })
    expect(observed).toBeNull()
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
