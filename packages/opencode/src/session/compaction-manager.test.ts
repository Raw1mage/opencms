import { describe, it, expect, beforeEach } from "bun:test"
import { CompactionManager } from "./compaction-manager"

// compaction/central-manager S1 — the structural fix for the verified
// double-trim amnesia (event_2026-06-10_rca-re-verified-with-hard-data-…).
// Enrichment now funnels through one intake, deduped per anchor id.
describe("CompactionManager — enrichment dedup (S1)", () => {
  beforeEach(() => {
    CompactionManager.__test__.reset()
  })

  it("TV-1: two enrich requests for the SAME anchor → executor runs exactly once", () => {
    const calls: Array<{ sid: string; origin: string }> = []
    CompactionManager.setEnrichExecutor((sid) => calls.push({ sid, origin: "" }))

    // The two legacy call sites (writeAnchorFromBody:795 + run():2678) firing
    // for the same just-written anchor — the exact double-schedule that
    // double-trimmed 23,706 → 6,102 → 2,441 tokens before the manager existed.
    CompactionManager.requestEnrich({
      sessionID: "ses_a",
      anchorId: "anchor_1",
      observed: "cache-aware",
      model: undefined,
      origin: "writeAnchorFromBody",
    })
    CompactionManager.requestEnrich({
      sessionID: "ses_a",
      anchorId: "anchor_1",
      observed: "cache-aware",
      model: undefined,
      origin: "run-postchain",
    })

    expect(calls).toHaveLength(1)
  })

  it("a later compaction's NEW anchor still gets enriched (dedup is per anchor, not per session)", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((_sid, obs) => calls.push(obs))

    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "run-postchain" })
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "writeAnchorFromBody" }) // dup
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_2", observed: "overflow", model: undefined, origin: "run-postchain" }) // fresh anchor

    expect(calls).toHaveLength(2)
    expect(CompactionManager.__test__.peekLastEnriched("ses_a")).toBe("anchor_2")
  })

  it("different sessions do not collide on the same anchor id", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((sid) => calls.push(sid))
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    CompactionManager.requestEnrich({ sessionID: "ses_b", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    expect(calls).toHaveLength(2)
  })

  it("forget() clears per-session dedup state so a re-created session can re-enrich", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((sid) => calls.push(sid))
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    CompactionManager.forget("ses_a")
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    expect(calls).toHaveLength(2)
  })
})
