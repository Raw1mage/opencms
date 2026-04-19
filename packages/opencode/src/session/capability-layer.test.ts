import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import {
  CapabilityLayer,
  CAPABILITY_LAYER_INTERNAL,
  setCapabilityLayerLoader,
  type CapabilityLayerLoader,
  type LayerBundle,
} from "./capability-layer"

function stubBundle(input?: Partial<LayerBundle>): LayerBundle {
  return {
    agents_md: { text: "stub agents", sources: ["/tmp/AGENTS.md"] },
    driver: { text: "stub driver", providerId: "anthropic", modelID: "claude-sonnet-4-6" },
    skill_content: {
      pinnedSkills: ["plan-builder"],
      renderedText: "<skill_layer>stub</skill_layer>",
      missingSkills: [],
    },
    enablement: { text: "{}", version: "stub" },
    ...input,
  }
}

class CountingLoader implements CapabilityLayerLoader {
  calls: Array<{ sessionID: string; epoch: number }> = []
  fail?: boolean
  stub?: LayerBundle
  failureMessage = "synthetic-failure"

  async load(input: { sessionID: string; epoch: number }): Promise<LayerBundle> {
    this.calls.push({ sessionID: input.sessionID, epoch: input.epoch })
    if (this.fail) throw new Error(this.failureMessage)
    return this.stub ?? stubBundle()
  }
}

afterEach(() => {
  CapabilityLayer.reset()
  setCapabilityLayerLoader(null)
})

describe("CapabilityLayer — cache miss triggers reinject", () => {
  it("first get() calls the loader and caches the result (TV10-style)", async () => {
    const loader = new CountingLoader()
    setCapabilityLayerLoader(loader)
    const entry = await CapabilityLayer.get("ses_a", 1)
    expect(entry.epoch).toBe(1)
    expect(entry.layers.skill_content.pinnedSkills).toEqual(["plan-builder"])
    expect(loader.calls).toHaveLength(1)
  })

  it("second get() at same epoch hits cache (no extra loader call)", async () => {
    const loader = new CountingLoader()
    setCapabilityLayerLoader(loader)
    await CapabilityLayer.get("ses_a", 1)
    await CapabilityLayer.get("ses_a", 1)
    await CapabilityLayer.get("ses_a", 1)
    expect(loader.calls).toHaveLength(1)
  })

  it("bump to new epoch causes fresh loader call (TV3-style invalidation)", async () => {
    const loader = new CountingLoader()
    setCapabilityLayerLoader(loader)
    await CapabilityLayer.get("ses_a", 1)
    await CapabilityLayer.get("ses_a", 2)
    await CapabilityLayer.get("ses_a", 3)
    expect(loader.calls).toHaveLength(3)
    expect(loader.calls.map((c) => c.epoch)).toEqual([1, 2, 3])
  })
})

describe("CapabilityLayer — peek & listForSession", () => {
  it("peek returns undefined for uncached (sessionID, epoch)", () => {
    expect(CapabilityLayer.peek("ses_unknown", 7)).toBeUndefined()
  })

  it("peek returns the entry after cache fill", async () => {
    setCapabilityLayerLoader(new CountingLoader())
    await CapabilityLayer.get("ses_a", 2)
    const entry = CapabilityLayer.peek("ses_a", 2)
    expect(entry?.epoch).toBe(2)
    expect(entry?.layers.agents_md.text).toBe("stub agents")
  })

  it("listForSession returns entries sorted by epoch", async () => {
    setCapabilityLayerLoader(new CountingLoader())
    await CapabilityLayer.get("ses_a", 1)
    await CapabilityLayer.get("ses_a", 2)
    const list = CapabilityLayer.listForSession("ses_a")
    expect(list.map((e) => e.epoch)).toEqual([1, 2])
  })
})

describe("CapabilityLayer — MAX_ENTRIES_PER_SESSION pruning", () => {
  it(`keeps at most ${CAPABILITY_LAYER_INTERNAL.MAX_ENTRIES_PER_SESSION} entries per session`, async () => {
    setCapabilityLayerLoader(new CountingLoader())
    // Push 5 epochs; only the last MAX_ENTRIES_PER_SESSION (2) should remain.
    for (let e = 1; e <= 5; e++) {
      await CapabilityLayer.get("ses_a", e)
    }
    const list = CapabilityLayer.listForSession("ses_a")
    expect(list).toHaveLength(CAPABILITY_LAYER_INTERNAL.MAX_ENTRIES_PER_SESSION)
    expect(list.map((e) => e.epoch)).toEqual([4, 5])
  })
})

describe("CapabilityLayer — reinject failure keeps previous cache (R3 TV14)", () => {
  it("failed reinject at epoch N+1 returns fallback from epoch N", async () => {
    const loader = new CountingLoader()
    setCapabilityLayerLoader(loader)
    // Populate epoch 1 successfully
    await CapabilityLayer.get("ses_fb", 1)
    expect(CapabilityLayer.peek("ses_fb", 1)).toBeDefined()

    // Now fail loader; ask for epoch 2 — should fallback to epoch 1
    loader.fail = true
    const fallback = await CapabilityLayer.get("ses_fb", 2)
    expect(fallback.epoch).toBe(1) // fallback to previous
    expect(CapabilityLayer.peek("ses_fb", 2)).toBeUndefined() // no new entry written

    // Previous cache still intact
    const keep = CapabilityLayer.peek("ses_fb", 1)
    expect(keep?.epoch).toBe(1)
    expect(keep?.layers.skill_content.pinnedSkills).toEqual(["plan-builder"])
  })

  it("reinject failure with no previous cache throws explicit error", async () => {
    const loader = new CountingLoader()
    loader.fail = true
    setCapabilityLayerLoader(loader)
    await expect(CapabilityLayer.get("ses_no_fallback", 1)).rejects.toThrow(
      /no cache and no fallback available/,
    )
  })

  it("failed reinject returns ReinjectOutcome with failures populated", async () => {
    const loader = new CountingLoader()
    loader.fail = true
    loader.failureMessage = "simulated"
    setCapabilityLayerLoader(loader)
    const outcome = await CapabilityLayer.reinject("ses_rj", 5)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0].error).toBe("simulated")
    expect(CapabilityLayer.peek("ses_rj", 5)).toBeUndefined()
  })
})

describe("CapabilityLayer — no-loader safety rail", () => {
  it("returns explicit failure outcome when no loader is registered", async () => {
    setCapabilityLayerLoader(null)
    const outcome = await CapabilityLayer.reinject("ses_unset", 1)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0].error).toMatch(/no loader registered/)
  })
})

describe("CapabilityLayer — clearForSession", () => {
  it("drops all entries for the given session only", async () => {
    setCapabilityLayerLoader(new CountingLoader())
    await CapabilityLayer.get("ses_a", 1)
    await CapabilityLayer.get("ses_b", 1)
    CapabilityLayer.clearForSession("ses_a")
    expect(CapabilityLayer.listForSession("ses_a")).toHaveLength(0)
    expect(CapabilityLayer.listForSession("ses_b")).toHaveLength(1)
  })
})

describe("CapabilityLayer — partial skill_content bundle", () => {
  it("propagates missingSkills + pinnedSkills into refreshed event payload", async () => {
    const loader = new CountingLoader()
    loader.stub = {
      agents_md: { text: "a", sources: [] },
      skill_content: {
        pinnedSkills: ["a-skill"],
        renderedText: "",
        missingSkills: ["absent-skill"],
      },
    }
    setCapabilityLayerLoader(loader)
    const outcome = await CapabilityLayer.reinject("ses_partial", 1)
    expect(outcome.pinnedSkills).toEqual(["a-skill"])
    expect(outcome.missingSkills).toEqual(["absent-skill"])
    expect(outcome.layers).toContain("agents_md")
    expect(outcome.layers).toContain("skill_content")
    expect(outcome.layers).not.toContain("driver")
  })
})
