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
