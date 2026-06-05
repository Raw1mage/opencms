import { afterEach, describe, expect, it, mock } from "bun:test"
import { deriveObservedCondition, estimateTransportItemCount, findMostRecentAnchor } from "./prompt"
import { SessionCompaction } from "./compaction"
import { Memory } from "./memory"
import type { MessageV2 } from "./message-v2"

const originalCooldown = SessionCompaction.Cooldown.shouldThrottle
const originalMemoryRead = Memory.read

afterEach(() => {
  ;(SessionCompaction.Cooldown as any).shouldThrottle = originalCooldown
  ;(Memory as any).read = originalMemoryRead
})

function makeAnchor(providerId: string, modelID: string, accountId: string | undefined): MessageV2.WithParts {
  return {
    info: {
      id: "msg_anchor",
      role: "assistant",
      sessionID: "ses_test",
      parentID: "msg_u1",
      mode: "compaction",
      agent: "compaction",
      summary: true,
      modelID,
      providerId,
      accountId,
      time: { created: 1, completed: 1 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: "/tmp", root: "/tmp" },
    } as MessageV2.Assistant,
    parts: [],
  }
}

function makeUserText(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "user",
      sessionID: "ses_test",
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
      time: { created: 1 },
    } as MessageV2.User,
    parts: [
      {
        id: `${id}_p`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text,
      } as any,
    ],
  }
}

function makeAssistantFinished(
  id: string,
  totalTokens: number,
  providerId = "codex",
  accountId: string | undefined = "acc-A",
): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "ses_test",
      parentID: "msg_u1",
      mode: "default",
      agent: "default",
      modelID: "gpt-5.5",
      providerId,
      accountId,
      finish: "stop",
      time: { created: 1, completed: 2 },
      cost: 0,
      tokens: { input: totalTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: totalTokens },
      path: { cwd: "/tmp", root: "/tmp" },
    } as MessageV2.Assistant,
    parts: [],
  }
}

describe("findMostRecentAnchor", () => {
  it("returns null when no anchor present", () => {
    const msgs = [makeUserText("msg_u1", "hi"), makeAssistantFinished("msg_a1", 100)]
    expect(findMostRecentAnchor(msgs)).toBeNull()
  })

  it("returns most recent anchor's identity", () => {
    const msgs = [
      makeAnchor("codex", "gpt-5.5", "acc-A"),
      makeUserText("msg_u2", "hi"),
      makeAnchor("claude", "claude-4.6", "acc-B"),
      makeUserText("msg_u3", "hello"),
    ]
    const anchor = findMostRecentAnchor(msgs)
    expect(anchor?.providerId).toBe("claude")
    expect(anchor?.accountId).toBe("acc-B")
  })

  it("ignores non-summary assistant messages", () => {
    const msgs = [makeAnchor("codex", "gpt-5.5", "acc-A"), makeAssistantFinished("msg_a2", 100, "claude", "acc-B")]
    const anchor = findMostRecentAnchor(msgs)
    expect(anchor?.providerId).toBe("codex") // not the regular assistant
  })
})

describe("estimateTransportItemCount", () => {
  it("matches the runloop transport item accounting", () => {
    const assistantWithTextAndTool = makeAssistantFinished("msg_a_tool", 100)
    assistantWithTextAndTool.parts = [
      { id: "msg_a_tool_text", type: "text", text: "done" } as any,
      {
        id: "msg_a_tool_part",
        type: "tool",
        state: { status: "completed", input: { q: "x" }, output: "ok" },
      } as any,
    ]
    expect(estimateTransportItemCount([makeUserText("msg_u1", "hi"), assistantWithTextAndTool])).toBe(4)
  })
})

describe("deriveObservedCondition (DD-1 state-driven)", () => {
  function commonInput(overrides: Partial<Parameters<typeof deriveObservedCondition>[0]> = {}) {
    return {
      sessionID: "ses_test",
      step: 5,
      msgs: [],
      lastFinished: undefined,
      pinnedProviderId: "codex",
      pinnedAccountId: "acc-A",
      hasUnprocessedCompactionRequest: false,
      compactionRequestAuto: undefined,
      parentID: undefined,
      continuationInvalidatedAt: undefined,
      isOverflow: async () => false,
      isCacheAware: async () => false,
      ...overrides,
    }
  }

  it("returns null when no condition is observed", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    expect(await deriveObservedCondition(commonInput())).toBeNull()
  })

  it("DD-12: subagent account drift stays chain-reset only (no compaction)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        parentID: "ses_parent",
        pinnedAccountId: "acc-B",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
      }),
    )
    expect(result).toBeNull()
  })

  it("DD-12: subagent does NOT trigger manual even with compaction-request part", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        parentID: "ses_parent",
        hasUnprocessedCompactionRequest: true,
      }),
    )
    expect(result).toBeNull()
  })

  it("DD-11: continuation-invalidated fires when timestamp newer than last anchor", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const anchorTime = 1700000000000
    // Anchor with createdAt = anchorTime; signal at anchorTime + 1000 (newer)
    const msgs = [makeAnchor("codex", "gpt-5.5", "acc-A")]
    msgs[0].info.time = { created: anchorTime, completed: anchorTime } as any
    const result = await deriveObservedCondition(
      commonInput({
        msgs,
        continuationInvalidatedAt: anchorTime + 1000,
      }),
    )
    expect(result).toBe("continuation-invalidated")
  })

  it("DD-11: continuation-invalidated naturally goes stale once anchor advances past timestamp", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const signalTime = 1700000000000
    const newerAnchorTime = signalTime + 5000
    const msgs = [makeAnchor("codex", "gpt-5.5", "acc-A")]
    msgs[0].info.time = { created: newerAnchorTime, completed: newerAnchorTime } as any
    const result = await deriveObservedCondition(
      commonInput({
        msgs,
        continuationInvalidatedAt: signalTime,
      }),
    )
    // Anchor is newer than signal → signal is stale → no fire (state-driven cooldown)
    expect(result).toBeNull()
  })

  it("DD-11: continuation-invalidated takes priority over identity drift", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const anchorTime = 1700000000000
    const msgs = [makeAnchor("codex", "gpt-5.5", "acc-A")]
    msgs[0].info.time = { created: anchorTime, completed: anchorTime } as any
    const result = await deriveObservedCondition(
      commonInput({
        msgs,
        pinnedAccountId: "acc-B", // would otherwise be rebind
        continuationInvalidatedAt: anchorTime + 1000,
      }),
    )
    expect(result).toBe("continuation-invalidated")
  })

  it("DD-11: continuation-invalidated set without any anchor → fires (first turn after restart)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        msgs: [makeUserText("msg_u1", "hi")],
        continuationInvalidatedAt: 1700000000000,
      }),
    )
    expect(result).toBe("continuation-invalidated")
  })

  it("returns null when cooldown blocks", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => true)
    expect(await deriveObservedCondition(commonInput({ hasUnprocessedCompactionRequest: true }))).toBeNull()
  })

  it("manual takes priority over all other observed conditions", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        hasUnprocessedCompactionRequest: true,
        msgs: [makeAnchor("claude", "claude-4.6", "acc-X")], // would otherwise be provider-switched
        lastFinished: makeAssistantFinished("msg_a1", 999_999).info as MessageV2.Assistant,
        isOverflow: async () => true,
      }),
    )
    expect(result).toBe("manual")
  })

  it("provider-switched when pinned providerId differs from last anchor", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedProviderId: "claude",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
      }),
    )
    expect(result).toBe("provider-switched")
  })

  it("account drift resets continuation only and returns null (same provider)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedProviderId: "codex",
        pinnedAccountId: "acc-B",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
      }),
    )
    expect(result).toBeNull()
  })

  it("provider-switched takes priority over rebind when both differ", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedProviderId: "claude",
        pinnedAccountId: "acc-B",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
      }),
    )
    expect(result).toBe("provider-switched")
  })

  it("no rebind detection when no anchor exists", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        msgs: [makeUserText("msg_u1", "hi"), makeAssistantFinished("msg_a1", 100)],
      }),
    )
    expect(result).toBeNull()
  })

  it("P2: paralysis item threshold fires overflow before continuation / rebind", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        msgs: Array.from({ length: 251 }, (_, i) => makeUserText(`msg_u${i}`, "hi")),
        continuationInvalidatedAt: 1700000000000,
        paralysisItemThreshold: 250,
      }),
    )
    expect(result).toBe("overflow")
  })

  it("P2: rebind preemptive gate fires before generic item overflow", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const msgs = Array.from({ length: 400 }, (_, i) => makeUserText(`msg_rebind_${i}`, "hi"))
    expect(await deriveObservedCondition(commonInput({ msgs, rebindPreemptive: true }))).toBe("rebind")
  })

  it("overflow when lastFinished present and isOverflow predicate returns true", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        lastFinished: makeAssistantFinished("msg_a1", 999_999).info as MessageV2.Assistant,
        isOverflow: async () => true,
      }),
    )
    expect(result).toBe("overflow")
  })

  it("cache-aware when overflow false but cache-aware predicate returns true", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        lastFinished: makeAssistantFinished("msg_a1", 200_000).info as MessageV2.Assistant,
        isOverflow: async () => false,
        isCacheAware: async () => true,
      }),
    )
    expect(result).toBe("cache-aware")
  })

  it("account drift chain reset takes priority over token pressure", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      commonInput({
        pinnedAccountId: "acc-B",
        msgs: [makeAnchor("codex", "gpt-5.5", "acc-A")],
        lastFinished: makeAssistantFinished("msg_a1", 999_999).info as MessageV2.Assistant,
        isOverflow: async () => true,
      }),
    )
    expect(result).toBeNull()
  })

  it("compaction shrinkage resets continuation only and returns null when currentInputTokens < prev.cacheRead", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const sid = "ses_compaction_shrinkage_test"

    // 1. First round: simulate a high cache read turn (200k cache read)
    const firstFin = makeAssistantFinished("msg_a1", 210_000)
    firstFin.info.tokens.cache.read = 200_000
    firstFin.info.tokens.input = 10_000

    await deriveObservedCondition(
      commonInput({
        sessionID: sid,
        lastFinished: firstFin.info as MessageV2.Assistant,
      }),
    )

    // 2. Second round: cache read drops to 60k, but prompt tokens shrink to 130k (< 200k)
    const secondFin = makeAssistantFinished("msg_a2", 130_000)
    secondFin.info.tokens.cache.read = 60_000
    secondFin.info.tokens.input = 70_000

    const result = await deriveObservedCondition(
      commonInput({
        sessionID: sid,
        lastFinished: secondFin.info as MessageV2.Assistant,
        currentInputTokens: 130_000,
      }),
    )

    // Compaction shrinkage drop should be safely bypassed (returns null)
    expect(result).toBeNull()
  })
})

describe("claude cold-cache size-gate (DD-13/14/16/18)", () => {
  // lastFinished with explicit token split so we can drive promptTotal and the
  // cache-read fraction independently. promptTotal = input + cache.read + write.
  function finished(opts: {
    input: number
    read?: number
    write?: number
    provider?: string
    /** ms ago the turn completed; default 0 (just now = active session, cache warm-able). */
    staleMs?: number
  }): MessageV2.Assistant {
    const read = opts.read ?? 0
    const write = opts.write ?? 0
    const completedAt = Date.now() - (opts.staleMs ?? 0)
    return {
      id: "msg_fin",
      role: "assistant",
      sessionID: "ses_gate",
      parentID: "msg_u1",
      mode: "default",
      agent: "default",
      modelID: "claude-opus-4-8",
      providerId: opts.provider ?? "claude-cli",
      accountId: "acc-A",
      finish: "stop",
      time: { created: completedAt, completed: completedAt },
      cost: 0,
      tokens: { input: opts.input, output: 0, reasoning: 0, cache: { read, write }, total: opts.input + read + write },
      path: { cwd: "/tmp", root: "/tmp" },
    } as any
  }

  let n = 0
  function gateInput(over: Partial<Parameters<typeof deriveObservedCondition>[0]> = {}) {
    return {
      sessionID: `ses_gate_${n++}`,
      step: 5,
      msgs: [],
      lastFinished: undefined,
      pinnedProviderId: "claude-cli",
      pinnedAccountId: "acc-A",
      hasUnprocessedCompactionRequest: false,
      compactionRequestAuto: undefined,
      parentID: undefined,
      continuationInvalidatedAt: undefined,
      isOverflow: async () => false,
      isCacheAware: async () => false,
      ...over,
    }
  }

  // B threshold = claude-cli default bCompactTokens = 200K (DD-23 tweak config).
  it("claude cold (cache served <50%) AND >200K → cache-aware", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(gateInput({ lastFinished: finished({ input: 250_000 }) }))
    expect(result).toBe("cache-aware")
  })

  it("claude WARM (cache served >50%) at >200K → no gate (null, raw resend stays cheap)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      gateInput({ lastFinished: finished({ input: 10_000, read: 250_000 }) }),
    )
    expect(result).toBeNull()
  })

  it("claude cold but SMALL (<200K) → no gate (null, anchor not worth it)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(gateInput({ lastFinished: finished({ input: 120_000 }) }))
    expect(result).toBeNull()
  })

  it("SESSION RESUME (DD-16): warm last turn but idle > cache TTL → fires anyway (idle-gap)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    // last turn was WARM (high cache_read fraction) but completed 90 min ago → the
    // ephemeral cache is dead → this resume is a guaranteed cold full-prefill → must
    // bound, even though the *recorded* fraction looks warm. This is the gap the
    // stale-fraction-only gate missed. (>200K so the outer size condition holds.)
    const result = await deriveObservedCondition(
      gateInput({ lastFinished: finished({ input: 10_000, read: 250_000, staleMs: 90 * 60 * 1000 }) }),
    )
    expect(result).toBe("cache-aware")
  })

  it("active warm + RECENT (idle < cache TTL) → no gate (resume signal off, cache still alive)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      gateInput({ lastFinished: finished({ input: 10_000, read: 250_000, staleMs: 60 * 1000 }) }), // 1 min < 5 min
    )
    expect(result).toBeNull()
  })

  it("SESSION RESUME but SMALL (<200K) → still no gate (size gate is the outer condition)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      gateInput({ lastFinished: finished({ input: 120_000, staleMs: 10 * 60 * 1000 }) }),
    )
    expect(result).toBeNull()
  })

  it("cold-recreate cache (high write, low read) at >200K still fires (write is the cold cost)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    // cache expired → prefix re-written this turn: read≈0, write large → frac<0.5.
    const result = await deriveObservedCondition(
      gateInput({ lastFinished: finished({ input: 5_000, read: 2_000, write: 230_000 }) }),
    )
    expect(result).toBe("cache-aware")
  })

  it("INV-0: codex cold+large does NOT hit the claude gate (not cache-aware)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      gateInput({ pinnedProviderId: "codex", lastFinished: finished({ input: 200_000, provider: "codex" }) }),
    )
    expect(result).not.toBe("cache-aware")
  })

  it("INV-0: another SL provider (gemini-cli) cold+large does NOT hit the claude gate", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const result = await deriveObservedCondition(
      gateInput({ pinnedProviderId: "gemini-cli", lastFinished: finished({ input: 200_000, provider: "gemini-cli" }) }),
    )
    expect(result).not.toBe("cache-aware")
  })

  // ---- F2 / DD-5: post-compaction recent-anchor cooldown (loop-B defense) ----
  // The active-session cold gate must NOT re-fire on the first cold turn that is
  // merely the echo of a just-written compaction anchor (the rewritten prefix is
  // not cached server-side yet). The top-of-fn 30s Cooldown covers the within-30s
  // window; this catches the first cold turn after it expires. Mirrors the SS
  // branch's `recent_compaction` planned-source classifier.
  it("F2: cold >200K but an anchor written AFTER last observation → SKIP (null)", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const sid = "ses_f2_echo"
    // Call 1 (no anchor): fires cache-aware AND seeds lastCacheReadState.ts = now.
    expect(
      await deriveObservedCondition(gateInput({ sessionID: sid, lastFinished: finished({ input: 250_000 }) })),
    ).toBe("cache-aware")
    // Call 2: an anchor created AFTER call-1's observation → post-compaction echo.
    const anchor = makeAnchor("claude-cli", "claude-opus-4-8", "acc-A")
    ;(anchor.info as any).time = { created: Date.now() + 1_000_000, completed: Date.now() + 1_000_000 }
    expect(
      await deriveObservedCondition(
        gateInput({ sessionID: sid, msgs: [anchor], lastFinished: finished({ input: 250_000 }) }),
      ),
    ).toBeNull()
  })

  it("F2: cold >200K with an OLD anchor (createdAt < last observation) → still cache-aware", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const sid = "ses_f2_old"
    expect(
      await deriveObservedCondition(gateInput({ sessionID: sid, lastFinished: finished({ input: 250_000 }) })),
    ).toBe("cache-aware")
    const anchor = makeAnchor("claude-cli", "claude-opus-4-8", "acc-A")
    ;(anchor.info as any).time = { created: 1, completed: 1 } // ancient → not a recent compaction
    expect(
      await deriveObservedCondition(
        gateInput({ sessionID: sid, msgs: [anchor], lastFinished: finished({ input: 250_000 }) }),
      ),
    ).toBe("cache-aware")
  })

  it("F2: idle cold-resume (>TTL) is NEVER suppressed, even with a recent anchor", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const sid = "ses_f2_idle"
    expect(
      await deriveObservedCondition(gateInput({ sessionID: sid, lastFinished: finished({ input: 250_000 }) })),
    ).toBe("cache-aware")
    const anchor = makeAnchor("claude-cli", "claude-opus-4-8", "acc-A")
    ;(anchor.info as any).time = { created: Date.now() + 1_000_000, completed: Date.now() + 1_000_000 }
    // warm-looking split but idle 90 min (> CLAUDE_CACHE_TTL_MS = 1h) → ephemeral
    // cache is dead → guaranteed cold prefill → must still fire despite recent anchor.
    expect(
      await deriveObservedCondition(
        gateInput({
          sessionID: sid,
          msgs: [anchor],
          lastFinished: finished({ input: 10_000, read: 250_000, staleMs: 90 * 60 * 1000 }),
        }),
      ),
    ).toBe("cache-aware")
  })

  it("F2/INV-0: codex with a recent anchor never enters the claude cooldown branch", async () => {
    ;(SessionCompaction.Cooldown as any).shouldThrottle = mock(async () => false)
    const anchor = makeAnchor("codex", "gpt-5.5", "acc-A")
    ;(anchor.info as any).time = { created: Date.now() + 1_000_000, completed: Date.now() + 1_000_000 }
    const result = await deriveObservedCondition(
      gateInput({
        sessionID: "ses_f2_codex",
        pinnedProviderId: "codex",
        msgs: [anchor],
        lastFinished: finished({ input: 250_000, provider: "codex" }),
      }),
    )
    expect(result).not.toBe("cache-aware")
  })
})
