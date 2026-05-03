import { describe, it, expect, afterEach } from "bun:test"
import {
  CapabilityLayer,
  CrossAccountRebindError,
  setCapabilityLayerLoader,
  type CapabilityLayerLoader,
  type LayerBundle,
} from "./capability-layer"

function stubBundle(): LayerBundle {
  return {
    agents_md: { text: "stub", sources: ["/tmp/AGENTS.md"] },
    driver: { text: "stub", providerId: "anthropic", modelID: "claude-sonnet-4-6" },
    skill_content: { pinnedSkills: [], renderedText: "", missingSkills: [] },
    enablement: { text: "{}", version: "stub" },
  }
}

class StubLoader implements CapabilityLayerLoader {
  failNext = false
  failMessage = "synthetic-loader-failure"
  async load(): Promise<LayerBundle> {
    if (this.failNext) {
      this.failNext = false
      throw new Error(this.failMessage)
    }
    return stubBundle()
  }
}

afterEach(() => {
  CapabilityLayer.reset()
  setCapabilityLayerLoader(null)
})

describe("CapabilityLayer cross-account hard-fail (DD-8)", () => {
  it("throws CrossAccountRebindError when fallback entry's account differs from requested", async () => {
    const loader = new StubLoader()
    setCapabilityLayerLoader(loader)

    // Seed epoch=1 with accountId=A1
    await CapabilityLayer.get("ses_x", 1, "A1")

    // Bump epoch=2 with accountId=A2; loader fails → fallback to epoch=1 (A1)
    loader.failNext = true
    await expect(CapabilityLayer.get("ses_x", 2, "A2")).rejects.toBeInstanceOf(CrossAccountRebindError)
  })

  it("returns same-account fallback with WARN (no throw) on transient loader failure", async () => {
    const loader = new StubLoader()
    setCapabilityLayerLoader(loader)

    await CapabilityLayer.get("ses_y", 1, "A1")

    loader.failNext = true
    const fallback = await CapabilityLayer.get("ses_y", 2, "A1")
    expect(fallback.epoch).toBe(1)
    expect(fallback.accountId).toBe("A1")
  })

  it("falls back silently (legacy behavior) when caller does not supply accountId", async () => {
    const loader = new StubLoader()
    setCapabilityLayerLoader(loader)

    // Seed epoch=1 without accountId
    await CapabilityLayer.get("ses_z", 1)

    loader.failNext = true
    const fallback = await CapabilityLayer.get("ses_z", 2)
    expect(fallback.epoch).toBe(1)
  })

  it("CrossAccountRebindError carries from / to / failures", async () => {
    const loader = new StubLoader()
    loader.failMessage = "agents-md-read-failed"
    setCapabilityLayerLoader(loader)

    await CapabilityLayer.get("ses_q", 1, "A1")
    loader.failNext = true

    try {
      await CapabilityLayer.get("ses_q", 2, "A2")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(CrossAccountRebindError)
      const cae = err as CrossAccountRebindError
      expect(cae.code).toBe("CROSS_ACCOUNT_REBIND_FAILED")
      expect(cae.from).toBe("A1")
      expect(cae.to).toBe("A2")
      expect(cae.failures.length).toBeGreaterThan(0)
      expect(cae.failures[0]?.error).toContain("agents-md-read-failed")
    }
  })

  it("throws generic Error (not CrossAccountRebindError) when no fallback exists at all", async () => {
    const loader = new StubLoader()
    setCapabilityLayerLoader(loader)

    loader.failNext = true
    await expect(CapabilityLayer.get("ses_fresh", 1, "A1")).rejects.toThrow(
      /no cache and no fallback/,
    )
  })
})
