import { describe, it, expect } from "bun:test"
import { MessageV2 } from "./message-v2"

describe("MessageV2.CompactionPart.metadata.skillSnapshot (DD-9)", () => {
  const baseCompaction = {
    id: "prt_compaction_01",
    sessionID: "ses_01",
    messageID: "msg_anchor_01",
    type: "compaction" as const,
    auto: false,
  }

  it("accepts compaction part without metadata (backwards compat with Phase A anchors)", () => {
    const parsed = MessageV2.CompactionPart.parse(baseCompaction)
    expect(parsed.metadata).toBeUndefined()
  })

  it("accepts metadata.skillSnapshot with full shape", () => {
    const parsed = MessageV2.CompactionPart.parse({
      ...baseCompaction,
      metadata: {
        skillSnapshot: {
          active: ["bash-toolkit", "frontend-design"],
          summarized: ["legacy-helper"],
          pinned: ["bash-toolkit"],
        },
        pinnedByAnchor: ["bash-toolkit"],
      },
    })
    expect(parsed.metadata?.skillSnapshot?.active).toEqual(["bash-toolkit", "frontend-design"])
    expect(parsed.metadata?.skillSnapshot?.pinned).toEqual(["bash-toolkit"])
    expect(parsed.metadata?.pinnedByAnchor).toEqual(["bash-toolkit"])
  })

  it("accepts empty arrays inside skillSnapshot", () => {
    const parsed = MessageV2.CompactionPart.parse({
      ...baseCompaction,
      metadata: {
        skillSnapshot: { active: [], summarized: [], pinned: [] },
        pinnedByAnchor: [],
      },
    })
    expect(parsed.metadata?.skillSnapshot?.active).toEqual([])
  })

  it("accepts metadata with only some optional fields populated", () => {
    const parsed = MessageV2.CompactionPart.parse({
      ...baseCompaction,
      metadata: { pinnedByAnchor: ["foo"] },
    })
    expect(parsed.metadata?.skillSnapshot).toBeUndefined()
    expect(parsed.metadata?.pinnedByAnchor).toEqual(["foo"])
  })

  it("rejects non-string entries in skillSnapshot arrays", () => {
    expect(() =>
      MessageV2.CompactionPart.parse({
        ...baseCompaction,
        metadata: { skillSnapshot: { active: [123], summarized: [], pinned: [] } as any },
      }),
    ).toThrow()
  })

  it("serialization roundtrip preserves nested metadata", () => {
    const original = {
      ...baseCompaction,
      metadata: {
        skillSnapshot: { active: ["X"], summarized: ["Y"], pinned: [] },
        pinnedByAnchor: ["X"],
      },
    }
    const serialized = JSON.stringify(MessageV2.CompactionPart.parse(original))
    const reparsed = MessageV2.CompactionPart.parse(JSON.parse(serialized))
    expect(reparsed.metadata).toEqual(original.metadata)
  })

  it("compaction-request part also accepts the optional metadata", () => {
    const parsed = MessageV2.CompactionPart.parse({
      ...baseCompaction,
      type: "compaction-request",
      metadata: { skillSnapshot: { active: ["X"], summarized: [], pinned: [] } },
    })
    expect(parsed.type).toBe("compaction-request")
    expect(parsed.metadata?.skillSnapshot?.active).toEqual(["X"])
  })
})
