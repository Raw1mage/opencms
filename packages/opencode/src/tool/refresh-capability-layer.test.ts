import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import {
  RefreshCapabilityLayerTool,
  REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT,
  __resetRefreshCapabilityLayerCounters,
} from "./refresh-capability-layer"
import { RebindEpoch } from "@/session/rebind-epoch"
import {
  CapabilityLayer,
  setCapabilityLayerLoader,
  type CapabilityLayerLoader,
  type LayerBundle,
} from "@/session/capability-layer"

function stubBundle(): LayerBundle {
  return {
    agents_md: { text: "stub", sources: [] },
    skill_content: { pinnedSkills: ["plan-builder"], renderedText: "", missingSkills: [] },
  }
}

class StubLoader implements CapabilityLayerLoader {
  async load(): Promise<LayerBundle> {
    return stubBundle()
  }
}

function fakeCtx(sessionID: string, messageID: string) {
  return {
    sessionID,
    messageID,
    agent: "main",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => undefined,
    ask: async () => undefined,
  } as any
}

afterEach(() => {
  RebindEpoch.reset()
  CapabilityLayer.reset()
  setCapabilityLayerLoader(null)
  __resetRefreshCapabilityLayerCounters()
})

beforeEach(() => {
  setCapabilityLayerLoader(new StubLoader())
})

async function initTool() {
  const info = RefreshCapabilityLayerTool
  const instance = await info.init()
  return instance
}

describe("RefreshCapabilityLayerTool — happy path", () => {
  it("bumps epoch + returns refreshed metadata + summary output", async () => {
    const tool = await initTool()
    const result = await tool.execute(
      { reason: "test happy path" } as any,
      fakeCtx("ses_happy", "msg_happy"),
    )
    expect(result.metadata.status).toBe("refreshed")
    expect(result.metadata.previousEpoch).toBe(0)
    expect(result.metadata.currentEpoch).toBe(1)
    expect(result.metadata.pinnedSkills).toEqual(["plan-builder"])
    expect(result.output).toContain("status: refreshed")
    expect(result.output).toContain("epoch: 0 -> 1")
  })

  it("reason is required — schema validation blocks empty string", async () => {
    const tool = await initTool()
    await expect(
      tool.execute({ reason: "" } as any, fakeCtx("ses_empty", "msg_empty")),
    ).rejects.toThrow(/invalid arguments/i)
  })
})

describe("RefreshCapabilityLayerTool — per-turn rate limit (DD-6)", () => {
  it(`allows up to ${REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT} calls per (session, messageID); blocks at N+1`, async () => {
    const tool = await initTool()
    const ctx = fakeCtx("ses_limit", "msg_limit")
    for (let i = 0; i < REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT; i++) {
      const result = await tool.execute({ reason: `call ${i + 1}` } as any, ctx)
      expect(result.metadata.rateLimited).not.toBe(true)
    }
    // N+1-th call — rate limited
    const rejected = await tool.execute({ reason: "over limit" } as any, ctx)
    expect(rejected.metadata.rateLimited).toBe(true)
    expect(rejected.metadata.turnCount).toBeGreaterThan(REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT)
    expect(rejected.output).toContain("refresh limit exceeded")
    // Epoch NOT incremented by the rejected call
    expect(RebindEpoch.current("ses_limit")).toBe(REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT)
  })

  it("per-turn counter is scoped to (sessionID, messageID) — new message resets counter", async () => {
    const tool = await initTool()
    const ctxA = fakeCtx("ses_scope", "msg_a")
    const ctxB = fakeCtx("ses_scope", "msg_b")
    for (let i = 0; i < REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT; i++) {
      await tool.execute({ reason: `msg_a-${i}` } as any, ctxA)
    }
    // Same session, new messageID — fresh quota
    const fresh = await tool.execute({ reason: "msg_b first" } as any, ctxB)
    expect(fresh.metadata.rateLimited).not.toBe(true)
  })

  it("different sessions share no per-turn counter", async () => {
    const tool = await initTool()
    for (let i = 0; i < REFRESH_CAPABILITY_LAYER_PER_TURN_LIMIT; i++) {
      await tool.execute({ reason: `a-${i}` } as any, fakeCtx("ses_a", "msg_same"))
    }
    // Different session even though messageID is same — should not be throttled
    const other = await tool.execute({ reason: "ses_b first" } as any, fakeCtx("ses_b", "msg_same"))
    expect(other.metadata.rateLimited).not.toBe(true)
  })
})
