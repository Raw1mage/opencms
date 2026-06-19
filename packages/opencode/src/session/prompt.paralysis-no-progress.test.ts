import { describe, expect, it } from "bun:test"
import { detectNoProgressParalysis } from "./prompt"

// Detector E — tool-active-but-no-progress perseveration (preface-independent).
// Models the failure mode in
// issues/bug_20260619_coding_subagent_cwd_root_pathloss_unproductive_hang.md:
// a worker keeps firing tools every turn (looks "alive") but makes zero real
// progress — no file mutation, and each turn's outcome signature repeats.

describe("detectNoProgressParalysis", () => {
  it("fires when 3 tool-active turns all error with no file mutation (different error text)", () => {
    const r = detectNoProgressParalysis({
      toolActivePerTurn: [true, true, true],
      mutatedPerTurn: [false, false, false],
      // worker stuck guessing repo paths: each turn errors, but DIFFERENT
      // error text → different signatures. The "uniformly errored" branch
      // catches this where signature-equality cannot.
      erroredPerTurn: [true, true, true],
      outcomeSignaturePerTurn: ["glob#err:not found A", "find#err:timeout", "grep#err:no match"],
    })
    expect(r.paralyzed).toBe(true)
  })

  it("fires when 3 tool-active turns return the same useless output signature", () => {
    const r = detectNoProgressParalysis({
      toolActivePerTurn: [true, true, true],
      mutatedPerTurn: [false, false, false],
      erroredPerTurn: [false, false, false],
      outcomeSignaturePerTurn: ["bash#ok:abc123", "bash#ok:abc123", "bash#ok:abc123"],
    })
    expect(r.paralyzed).toBe(true)
  })

  it("does NOT fire when any windowed turn mutated a file (genuine progress)", () => {
    const r = detectNoProgressParalysis({
      toolActivePerTurn: [true, true, true],
      mutatedPerTurn: [false, true, false],
      erroredPerTurn: [false, false, false],
      outcomeSignaturePerTurn: ["edit#ok:x", "edit#ok:y", "edit#ok:z"],
    })
    expect(r.paralyzed).toBe(false)
  })

  it("does NOT fire when outcome signatures differ and not all errored", () => {
    const r = detectNoProgressParalysis({
      toolActivePerTurn: [true, true, true],
      mutatedPerTurn: [false, false, false],
      erroredPerTurn: [false, false, false],
      // mixed: distinct successful reads = real recon progress, not a spin.
      outcomeSignaturePerTurn: ["read#ok:aaa", "read#ok:bbb", "read#ok:ccc"],
    })
    expect(r.paralyzed).toBe(false)
  })

  it("needs at least 3 turns", () => {
    const r = detectNoProgressParalysis({
      toolActivePerTurn: [true, true],
      mutatedPerTurn: [false, false],
      erroredPerTurn: [true, true],
      outcomeSignaturePerTurn: ["glob#err:x", "glob#err:x"],
    })
    expect(r.paralyzed).toBe(false)
  })

  it("does NOT fire when a turn had no tool activity (not busy)", () => {
    const r = detectNoProgressParalysis({
      toolActivePerTurn: [true, false, true],
      mutatedPerTurn: [false, false, false],
      erroredPerTurn: [true, false, true],
      outcomeSignaturePerTurn: ["glob#err:x", "glob#err:x", "glob#err:x"],
    })
    expect(r.paralyzed).toBe(false)
  })

  it("does NOT fire on empty signatures even if uniform (and not all errored)", () => {
    const r = detectNoProgressParalysis({
      toolActivePerTurn: [true, true, true],
      mutatedPerTurn: [false, false, false],
      erroredPerTurn: [false, false, false],
      outcomeSignaturePerTurn: ["", "", ""],
    })
    expect(r.paralyzed).toBe(false)
  })
})
