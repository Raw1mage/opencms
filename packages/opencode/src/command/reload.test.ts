import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { Command } from "./index"
import { RebindEpoch } from "@/session/rebind-epoch"
import {
  CapabilityLayer,
  setCapabilityLayerLoader,
  type CapabilityLayerLoader,
  type LayerBundle,
} from "@/session/capability-layer"

class StubLoader implements CapabilityLayerLoader {
  async load(): Promise<LayerBundle> {
    return {
      agents_md: { text: "stub agents", sources: [] },
      skill_content: {
        pinnedSkills: ["plan-builder"],
        renderedText: "",
        missingSkills: [],
      },
    }
  }
}

class MissingLoader implements CapabilityLayerLoader {
  async load(): Promise<LayerBundle> {
    return {
      agents_md: { text: "agents", sources: [] },
      skill_content: {
        pinnedSkills: ["plan-builder"],
        renderedText: "",
        missingSkills: ["ghost-skill"],
      },
    }
  }
}

class FailingLoader implements CapabilityLayerLoader {
  async load(): Promise<LayerBundle> {
    throw new Error("simulated loader failure")
  }
}

afterEach(() => {
  RebindEpoch.reset()
  CapabilityLayer.reset()
  setCapabilityLayerLoader(null)
})

describe("Command.reloadHandler", () => {
  beforeEach(() => {
    setCapabilityLayerLoader(new StubLoader())
  })

  it("returns no_session message when ctx missing", async () => {
    const out = await Command.reloadHandler()
    expect(out.output).toContain("no active session")
    expect(out.title).toBe("Reload — No Session")
  })

  it("bumps epoch + reinjects capability layer on happy path", async () => {
    const out = await Command.reloadHandler({ sessionID: "ses_reload_happy" })
    expect(out.output).toMatch(/Capability layer refreshed \(0 → 1\)/)
    expect(out.output).toContain("plan-builder")
    expect(RebindEpoch.current("ses_reload_happy")).toBe(1)
    expect(CapabilityLayer.peek("ses_reload_happy", 1)).toBeDefined()
  })

  it("surfaces missing skills in the ack message", async () => {
    setCapabilityLayerLoader(new MissingLoader())
    const out = await Command.reloadHandler({ sessionID: "ses_reload_missing" })
    expect(out.output).toContain("plan-builder")
    expect(out.output).toContain("missing: ghost-skill")
  })

  it("reports partial refresh when loader fails after epoch bump", async () => {
    setCapabilityLayerLoader(new FailingLoader())
    const out = await Command.reloadHandler({ sessionID: "ses_reload_fail" })
    expect(out.title).toBe("Reload — Partial")
    expect(out.output).toContain("partial refresh")
    expect(out.output).toContain("agents_md:simulated loader failure")
    // Epoch still bumped (bump is independent of reinject success)
    expect(RebindEpoch.current("ses_reload_fail")).toBe(1)
  })

  it("rate-limit message when session rebind rate limit is hit", async () => {
    // Fill the session's rebind window
    for (let i = 0; i < 5; i++) {
      await RebindEpoch.bumpEpoch({ sessionID: "ses_reload_rate", trigger: "slash_reload" })
    }
    const out = await Command.reloadHandler({ sessionID: "ses_reload_rate" })
    expect(out.title).toBe("Reload — Rate Limited")
    expect(out.output).toContain("rate limit")
  })
})
