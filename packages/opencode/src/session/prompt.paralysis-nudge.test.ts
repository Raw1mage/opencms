import { describe, expect, it } from "bun:test"
import { selectParalysisNudge, PARALYSIS_NOOP_META_TOOLS } from "./prompt"

// DD-2 — tool-aware 3-turn paralysis nudge.
// A no-op meta-tool loop (tool_loader) must get a directional escape, not the
// generic "try a different action" that empirically failed to break the loop in
// issues/bug_20260618_post_compaction_tool_loader_perseveration_noop_shim.md.

describe("selectParalysisNudge", () => {
  it("gives a directional escape when a no-op meta-tool is repeated (signature)", () => {
    const nudge = selectParalysisNudge({ detector: "signature", repeatedToolName: "tool_loader" })
    expect(nudge).toContain("tool_loader")
    expect(nudge).toContain("no-op")
    expect(nudge).toContain("直接呼叫")
    // Must NOT fall back to the vague generic line.
    expect(nudge).not.toContain("換一個動作")
  })

  it("keeps the generic signature nudge for a normal repeated tool", () => {
    const nudge = selectParalysisNudge({ detector: "signature", repeatedToolName: "bash" })
    expect(nudge).toContain("同一個 tool 加同樣參數")
    expect(nudge).not.toContain("no-op")
  })

  it("keeps the narrative nudge regardless of repeated tool", () => {
    const nudge = selectParalysisNudge({ detector: "narrative", repeatedToolName: "tool_loader" })
    expect(nudge).toContain("非常相似的計畫")
    expect(nudge).not.toContain("no-op")
  })

  it("does not misfire when repeated tool is unknown/undefined", () => {
    const nudge = selectParalysisNudge({ detector: "signature", repeatedToolName: undefined })
    expect(nudge).toContain("同一個 tool 加同樣參數")
  })

  it("tool_loader is in the no-op meta-tool set", () => {
    expect(PARALYSIS_NOOP_META_TOOLS.has("tool_loader")).toBe(true)
  })
})
