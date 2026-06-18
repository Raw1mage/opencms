import { describe, expect, it } from "bun:test"
import {
  getParalysisState,
  resetParalysisState,
  paralysisStateSizeForTest,
  PARALYSIS_STATE_MAX_SESSIONS,
} from "./prompt"

// DD-3/DD-5 — session-scoped paralysis escalation state.
// The C2 bug (bug_20260618): recoveryCount was a runloop-local `let`, so a
// finish=error turn or user interjection re-entering the runloop reset it to 0
// and the hard-halt after a failed recovery was never reachable. The state now
// lives in a session-keyed module Map and survives re-entry.

describe("getParalysisState (session-scoped escalation)", () => {
  it("survives 'runloop re-entry' — mutation persists across lookups", () => {
    const sid = "ses_persist_A"
    resetParalysisState(sid)
    const first = getParalysisState(sid)
    first.recoveryCount = 1 // simulate: first paralysis injected a nudge
    // Simulate a runloop re-entry (error turn / user "繼續") — a fresh lookup.
    const afterReentry = getParalysisState(sid)
    expect(afterReentry).toBe(first) // same object by reference
    expect(afterReentry.recoveryCount).toBe(1) // escalation ladder did NOT reset
    resetParalysisState(sid)
  })

  it("keeps sessions independent", () => {
    resetParalysisState("ses_ind_B")
    resetParalysisState("ses_ind_C")
    getParalysisState("ses_ind_B").recoveryCount = 5
    expect(getParalysisState("ses_ind_C").recoveryCount).toBe(0)
    resetParalysisState("ses_ind_B")
    resetParalysisState("ses_ind_C")
  })

  it("resetParalysisState clears a session's escalation", () => {
    const sid = "ses_reset_D"
    getParalysisState(sid).recoveryCount = 3
    resetParalysisState(sid)
    expect(getParalysisState(sid).recoveryCount).toBe(0)
    resetParalysisState(sid)
  })

  it("bounds the map by FIFO eviction (cannot grow unbounded)", () => {
    // Insert well over the cap; size must stay bounded (DD-5 / risk R2).
    for (let i = 0; i < PARALYSIS_STATE_MAX_SESSIONS + 50; i++) {
      getParalysisState(`ses_flood_${i}`)
    }
    expect(paralysisStateSizeForTest()).toBeLessThanOrEqual(PARALYSIS_STATE_MAX_SESSIONS)
  })
})
