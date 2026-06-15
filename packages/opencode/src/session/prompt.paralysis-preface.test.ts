import { describe, expect, it } from "bun:test"
import { detectPrefaceParalysis, PARALYSIS_PREFACE_SIM_THRESHOLD } from "./prompt"

// Detector D — preface perseveration with no file mutation in the window.
// Models the failure mode in
// issues/bug_20260615_paralysis_guard_evaded_by_preface_perseveration.md.

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "").slice(0, 140)

describe("detectPrefaceParalysis", () => {
  it("fires when 3 read-only turns share a near-identical preface", () => {
    // Real-session shape: fixed reassurance preface, tiny varying tail, zero edits.
    const prefaces = [
      norm("The batch-1 error notice is now fully drained — superseded by batch-2. Continuing provider-cms: nvidia is undefined, reading offset 100."),
      norm("The batch-1 error notice is now fully drained — superseded by batch-2. Continuing provider-cms: nvidia is undefined, reading offset 160."),
      norm("The batch-1 error notice is now fully drained — superseded by batch-2. Continuing provider-cms: nvidia is undefined, reading offset 1150."),
    ]
    const r = detectPrefaceParalysis({ prefaces, mutatedPerTurn: [false, false, false] })
    expect(r.paralyzed).toBe(true)
    expect(r.similarity).toBeGreaterThan(PARALYSIS_PREFACE_SIM_THRESHOLD)
  })

  it("does NOT fire when any turn in the window mutated a file (genuine batch-edit work)", () => {
    const prefaces = [
      norm("Now fixing the next mechanical-drift test file in the cluster, applying the spread-barrel mock fix."),
      norm("Now fixing the next mechanical-drift test file in the cluster, applying the spread-barrel mock fix."),
      norm("Now fixing the next mechanical-drift test file in the cluster, applying the spread-barrel mock fix."),
    ]
    // Identical preface, but real edits happened → not paralysis.
    const r = detectPrefaceParalysis({ prefaces, mutatedPerTurn: [true, false, true] })
    expect(r.paralyzed).toBe(false)
  })

  it("does NOT fire on genuinely distinct prefaces", () => {
    const prefaces = [
      norm("Investigating the provider-cms nvidia family resolution in Provider.list()."),
      norm("Now checking the killswitch-gate partial mock truncation of WorkspaceOperation."),
      norm("Switching to the rate-limit-judge backoff constant assertion drift."),
    ]
    const r = detectPrefaceParalysis({ prefaces, mutatedPerTurn: [false, false, false] })
    expect(r.paralyzed).toBe(false)
  })

  it("needs at least 3 turns", () => {
    const p = norm("Same preface repeated across the window with no progress at all here.")
    expect(detectPrefaceParalysis({ prefaces: [p, p], mutatedPerTurn: [false, false] }).paralyzed).toBe(false)
  })

  it("ignores too-short prefaces (unreliable signal)", () => {
    const p = norm("drained.")
    const r = detectPrefaceParalysis({ prefaces: [p, p, p], mutatedPerTurn: [false, false, false] })
    expect(r.paralyzed).toBe(false)
  })
})
