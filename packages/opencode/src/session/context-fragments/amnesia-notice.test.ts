import { describe, expect, it } from "bun:test"
import { buildAmnesiaNoticeFragment, decideAmnesiaInjection } from "./amnesia-notice"

describe("buildAmnesiaNoticeFragment", () => {
  it("returns a user-role fragment with stable id and markers", () => {
    const frag = buildAmnesiaNoticeFragment()
    expect(frag.id).toBe("amnesia_notice")
    expect(frag.role).toBe("user")
    expect(frag.startMarker).toBe("<amnesia_notice>")
    expect(frag.endMarker).toBe("</amnesia_notice>")
    expect(frag.source).toBe("opencode-only")
  })

  it("body mentions TOOL_INDEX and recall affordance", () => {
    const frag = buildAmnesiaNoticeFragment()
    expect(frag.body).toContain("TOOL_INDEX")
    expect(frag.body).toContain("recall(tool_call_id)")
    expect(frag.body).toContain("COMPACTED")
    expect(frag.body).toContain("NARRATIVE")
  })

  it("body surfaces the actual compaction kind (hybrid_llm case)", () => {
    const frag = buildAmnesiaNoticeFragment({ anchorKind: "hybrid_llm" })
    expect(frag.body).toContain("HYBRID-LLM")
  })

  it("includes anchorId trace when provided", () => {
    const frag = buildAmnesiaNoticeFragment({ anchorId: "msg_xyz", anchorKind: "narrative" })
    expect(frag.body).toContain("msg_xyz")
    expect(frag.body).toContain("narrative")
  })
})

describe("decideAmnesiaInjection", () => {
  it("returns inject=false when recentEvents is undefined or empty", () => {
    expect(decideAmnesiaInjection(undefined).inject).toBe(false)
    expect(decideAmnesiaInjection([]).inject).toBe(false)
  })

  it("returns inject=true when most recent compaction was narrative", () => {
    const events = [
      { ts: 1000, kind: "compaction" as const, compaction: { observed: "rebind", kind: "narrative", success: true } },
    ]
    const d = decideAmnesiaInjection(events)
    expect(d.inject).toBe(true)
    expect(d.anchorKind).toBe("narrative")
    expect(d.ts).toBe(1000)
  })

  it("returns inject=true when most recent compaction was hybrid_llm (still client-side)", () => {
    const events = [
      { ts: 1000, kind: "compaction" as const, compaction: { observed: "rebind", kind: "narrative", success: true } },
      { ts: 2000, kind: "compaction" as const, compaction: { observed: "rebind", kind: "hybrid_llm", success: true } },
    ]
    const d = decideAmnesiaInjection(events)
    expect(d.inject).toBe(true)
    expect(d.anchorKind).toBe("hybrid_llm")
  })

  it("returns inject=false when most recent compaction was low-cost-server (server-side preserves chain)", () => {
    const events = [
      { ts: 1000, kind: "compaction" as const, compaction: { observed: "manual", kind: "low-cost-server", success: true } },
    ]
    expect(decideAmnesiaInjection(events).inject).toBe(false)
  })

  it("skips unsuccessful compactions when scanning", () => {
    const events = [
      { ts: 1000, kind: "compaction" as const, compaction: { observed: "rebind", kind: "narrative", success: true } },
      { ts: 2000, kind: "compaction" as const, compaction: { observed: "rebind", kind: "low-cost-server", success: false } },
    ]
    // The failed low-cost-server should be skipped; the active anchor is still the narrative one.
    const d = decideAmnesiaInjection(events)
    expect(d.inject).toBe(true)
    expect(d.anchorKind).toBe("narrative")
  })

  it("returns inject=true for replay-tail and llm-agent kinds (client-side)", () => {
    expect(
      decideAmnesiaInjection([
        { ts: 1, kind: "compaction" as const, compaction: { observed: "manual", kind: "replay-tail", success: true } },
      ]).inject,
    ).toBe(true)
    expect(
      decideAmnesiaInjection([
        { ts: 1, kind: "compaction" as const, compaction: { observed: "manual", kind: "llm-agent", success: true } },
      ]).inject,
    ).toBe(true)
  })

  it("ignores rotation events", () => {
    const events = [
      { ts: 1000, kind: "compaction" as const, compaction: { observed: "rebind", kind: "narrative", success: true } },
      { ts: 2000, kind: "rotation" as const },
    ]
    const d = decideAmnesiaInjection(events as any)
    expect(d.inject).toBe(true)
  })

  it("handles compaction event without compaction sub-object", () => {
    const events = [{ ts: 1000, kind: "compaction" as const }]
    expect(decideAmnesiaInjection(events as any).inject).toBe(false)
  })
})

describe("buildAmnesiaNoticeFragment — digest extension (M5)", () => {
  const sampleDigest = {
    entries: [
      {
        call_id: "call_p1",
        tool: "apply_patch",
        args_brief: "foo/bar.md",
        status: "completed" as const,
        output_summary: "✓ Success",
        completed_at: 1,
      },
      {
        call_id: "call_p2",
        tool: "edit",
        args_brief: "baz.ts",
        status: "completed" as const,
        output_summary: "wrote 42 bytes",
        completed_at: 2,
      },
    ],
    bodyCharCount: 200,
    capturedAt: 3,
    sourceMessageCount: 10,
  }

  it("without digest field — body retains original shape (backward compatible)", () => {
    const before = buildAmnesiaNoticeFragment({ anchorId: "msg_x" }).body
    const after = buildAmnesiaNoticeFragment({ anchorId: "msg_x", digest: undefined }).body
    expect(after).toBe(before)
  })

  it("with null digest — body retains original shape", () => {
    const before = buildAmnesiaNoticeFragment({ anchorId: "msg_x" }).body
    const after = buildAmnesiaNoticeFragment({ anchorId: "msg_x", digest: null }).body
    expect(after).toBe(before)
  })

  it("with empty-entries digest — body retains original shape", () => {
    const before = buildAmnesiaNoticeFragment().body
    const empty = {
      entries: [],
      bodyCharCount: 0,
      capturedAt: 1,
      sourceMessageCount: 0,
    }
    const after = buildAmnesiaNoticeFragment({ digest: empty }).body
    expect(after).toBe(before)
  })

  it("with populated digest — body contains 'Recent committed actions' section", () => {
    const frag = buildAmnesiaNoticeFragment({ digest: sampleDigest })
    expect(frag.body).toContain("Recent committed actions")
    expect(frag.body).toContain("call_p1")
    expect(frag.body).toContain("call_p2")
    expect(frag.body).toContain("foo/bar.md")
    expect(frag.body).toContain("baz.ts")
  })

  it("digest section appears AFTER the recall affordance block", () => {
    const frag = buildAmnesiaNoticeFragment({ digest: sampleDigest })
    const recallIndex = frag.body.indexOf("recall returns `unknown_call_id`")
    const digestIndex = frag.body.indexOf("Recent committed actions")
    expect(recallIndex).toBeGreaterThan(0)
    expect(digestIndex).toBeGreaterThan(recallIndex)
  })

  it("digest plus anchor id — both surfaces present", () => {
    const frag = buildAmnesiaNoticeFragment({
      anchorId: "msg_anchor",
      anchorKind: "narrative",
      digest: sampleDigest,
    })
    expect(frag.body).toContain("msg_anchor")
    expect(frag.body).toContain("call_p1")
  })

  it("preserves user role + markers when digest is added", () => {
    const frag = buildAmnesiaNoticeFragment({ digest: sampleDigest })
    expect(frag.role).toBe("user")
    expect(frag.startMarker).toBe("<amnesia_notice>")
    expect(frag.endMarker).toBe("</amnesia_notice>")
  })
})
