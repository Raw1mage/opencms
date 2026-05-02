import { describe, it, expect, afterEach } from "bun:test"
import { SkillLayerRegistry } from "./skill-layer-registry"

afterEach(() => {
  SkillLayerRegistry.reset()
})

describe("SkillLayerRegistry pinForAnchor / unpinByAnchor (DD-9)", () => {
  function load(sid: string, name: string) {
    SkillLayerRegistry.recordLoaded(sid, name, { content: `${name}-body` })
  }

  it("pinForAnchor pins a skill and tracks the anchorId", () => {
    const sid = "ses1"
    load(sid, "bash-toolkit")
    SkillLayerRegistry.pinForAnchor(sid, "bash-toolkit", "anchor-1")
    const e = SkillLayerRegistry.peek(sid, "bash-toolkit")
    expect(e?.pinned).toBe(true)
    expect(e?.runtimeState).toBe("sticky")
    expect(e?.pinnedByAnchors?.has("anchor-1")).toBe(true)
  })

  it("multiple anchors can pin the same skill independently", () => {
    const sid = "ses2"
    load(sid, "X")
    SkillLayerRegistry.pinForAnchor(sid, "X", "a-1")
    SkillLayerRegistry.pinForAnchor(sid, "X", "a-2")
    const e = SkillLayerRegistry.peek(sid, "X")
    expect(e?.pinnedByAnchors?.size).toBe(2)
    expect(e?.pinned).toBe(true)
  })

  it("unpinByAnchor releases the skill when last anchor unpinned", () => {
    const sid = "ses3"
    load(sid, "X")
    SkillLayerRegistry.pinForAnchor(sid, "X", "a-1")
    const released = SkillLayerRegistry.unpinByAnchor(sid, "a-1")
    expect(released).toEqual(["X"])
    expect(SkillLayerRegistry.peek(sid, "X")?.pinned).toBe(false)
  })

  it("unpinByAnchor keeps skill pinned if other anchors still hold it", () => {
    const sid = "ses4"
    load(sid, "Y")
    SkillLayerRegistry.pinForAnchor(sid, "Y", "a-1")
    SkillLayerRegistry.pinForAnchor(sid, "Y", "a-2")
    const released = SkillLayerRegistry.unpinByAnchor(sid, "a-1")
    expect(released).toEqual([])
    const e = SkillLayerRegistry.peek(sid, "Y")
    expect(e?.pinned).toBe(true)
    expect(e?.pinnedByAnchors?.size).toBe(1)
    expect(e?.pinnedByAnchors?.has("a-2")).toBe(true)
  })

  it("unpinByAnchor for unknown anchor is a no-op", () => {
    const sid = "ses5"
    load(sid, "Z")
    expect(SkillLayerRegistry.unpinByAnchor(sid, "ghost")).toEqual([])
    expect(SkillLayerRegistry.peek(sid, "Z")?.pinned).toBe(false)
  })
})

describe("SkillLayerRegistry.scanReferences (DD-9)", () => {
  it("matches a known skill name by word boundary", () => {
    expect(
      SkillLayerRegistry.scanReferences("Used the bash-toolkit skill to inspect logs.", [
        "bash-toolkit",
        "frontend-design",
      ]),
    ).toEqual(["bash-toolkit"])
  })

  it("does not match substring inside a longer token", () => {
    // "bash-toolkit-extra" should NOT match "bash-toolkit"
    expect(
      SkillLayerRegistry.scanReferences("Loaded bash-toolkit-extra for the job.", ["bash-toolkit"]),
    ).toEqual([])
  })

  it("matches multiple references", () => {
    expect(
      SkillLayerRegistry.scanReferences("Used bash-toolkit then planner to draft.", [
        "bash-toolkit",
        "planner",
        "frontend-design",
      ]),
    ).toEqual(["bash-toolkit", "planner"])
  })

  it("is case-insensitive", () => {
    expect(SkillLayerRegistry.scanReferences("Used BASH-TOOLKIT", ["bash-toolkit"])).toEqual([
      "bash-toolkit",
    ])
  })

  it("empty / no-known-names returns empty", () => {
    expect(SkillLayerRegistry.scanReferences("", ["X"])).toEqual([])
    expect(SkillLayerRegistry.scanReferences("Used X", [])).toEqual([])
  })

  it("escapes regex metacharacters in skill names", () => {
    // ".dotted-skill" was the closest hostile name; ensure it doesn't blow up
    // and only matches exact form.
    expect(SkillLayerRegistry.scanReferences("Used dotted.skill in flow.", ["dotted.skill"])).toEqual([
      "dotted.skill",
    ])
    expect(SkillLayerRegistry.scanReferences("Used dottedXskill", ["dotted.skill"])).toEqual([])
  })
})
