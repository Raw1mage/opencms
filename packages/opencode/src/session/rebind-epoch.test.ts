import { describe, it, expect, afterEach, mock } from "bun:test"
import { RebindEpoch, REBIND_RATE_LIMIT, type BumpEpochOutcome } from "./rebind-epoch"

// Suppress RuntimeEventService I/O during these tests — we only assert the
// pure state transitions + returned BumpEpochOutcome.
// If append fails, appendEventSafe swallows with a warn; we don't assert on it here.

afterEach(() => {
  RebindEpoch.reset()
})

describe("RebindEpoch — lazy init + current()", () => {
  it("returns 0 for an unknown sessionID (no side effect)", () => {
    expect(RebindEpoch.current("ses_unknown")).toBe(0)
    expect(RebindEpoch.stats().entries).toHaveLength(0)
  })

  it("first bumpEpoch lifts 0 → 1 (DD-8 lazy init)", async () => {
    const outcome = await RebindEpoch.bumpEpoch({
      sessionID: "ses_tv1",
      trigger: "daemon_start",
    })
    expect(outcome.status).toBe("bumped")
    expect(outcome.previousEpoch).toBe(0)
    expect(outcome.currentEpoch).toBe(1)
    expect(RebindEpoch.current("ses_tv1")).toBe(1)
  })
})

describe("RebindEpoch — bump sequence (monotonic per session)", () => {
  it("bumps N → N+1 on every call, preserving trigger", async () => {
    const s = "ses_sequence"
    const a = await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "daemon_start" })
    expect(a.currentEpoch).toBe(1)
    const b = await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "slash_reload" })
    expect(b.previousEpoch).toBe(1)
    expect(b.currentEpoch).toBe(2)
    const c = await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "tool_call", reason: "testing" })
    expect(c.previousEpoch).toBe(2)
    expect(c.currentEpoch).toBe(3)
    const snapshot = RebindEpoch.stats().entries.find((e) => e.sessionID === s)
    expect(snapshot?.epoch).toBe(3)
    expect(snapshot?.lastTrigger).toBe("tool_call")
  })

  it("different sessions track independent epochs (DD-1 per-session isolation)", async () => {
    const a = await RebindEpoch.bumpEpoch({ sessionID: "ses_a", trigger: "daemon_start" })
    const b = await RebindEpoch.bumpEpoch({ sessionID: "ses_b", trigger: "daemon_start" })
    const a2 = await RebindEpoch.bumpEpoch({ sessionID: "ses_a", trigger: "slash_reload" })
    expect(a.currentEpoch).toBe(1)
    expect(b.currentEpoch).toBe(1)
    expect(a2.currentEpoch).toBe(2)
    expect(RebindEpoch.current("ses_a")).toBe(2)
    expect(RebindEpoch.current("ses_b")).toBe(1)
  })
})

describe("RebindEpoch — rate limit (DD-11)", () => {
  it(`allows ${REBIND_RATE_LIMIT.maxPerWindow} bumps within ${REBIND_RATE_LIMIT.windowMs}ms then rejects`, async () => {
    const s = "ses_storm"
    const outcomes: BumpEpochOutcome[] = []
    for (let i = 0; i < REBIND_RATE_LIMIT.maxPerWindow; i++) {
      outcomes.push(await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "slash_reload" }))
    }
    // Every bump within the window succeeds
    for (const o of outcomes) expect(o.status).toBe("bumped")
    expect(RebindEpoch.current(s)).toBe(REBIND_RATE_LIMIT.maxPerWindow)

    // One more within the same window — rate limited
    const rejected = await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "slash_reload" })
    expect(rejected.status).toBe("rate_limited")
    expect(rejected.previousEpoch).toBe(REBIND_RATE_LIMIT.maxPerWindow)
    expect(rejected.currentEpoch).toBe(REBIND_RATE_LIMIT.maxPerWindow) // unchanged
    expect(rejected.rateLimitReason).toContain("rate_limit:")
    // Current stays pinned at pre-reject value
    expect(RebindEpoch.current(s)).toBe(REBIND_RATE_LIMIT.maxPerWindow)
  })

  it("window slides: after cooldown, new bumps succeed again", async () => {
    const s = "ses_cooldown"
    // Fill the window
    for (let i = 0; i < REBIND_RATE_LIMIT.maxPerWindow; i++) {
      await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "slash_reload" })
    }
    // Simulate cooldown by pushing time forward — need to manipulate
    // Date.now. Simpler: wait the window duration.
    await new Promise((r) => setTimeout(r, REBIND_RATE_LIMIT.windowMs + 50))
    const resumed = await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "slash_reload" })
    expect(resumed.status).toBe("bumped")
    expect(resumed.currentEpoch).toBe(REBIND_RATE_LIMIT.maxPerWindow + 1)
  }, 10_000)

  it("rate limit is per-session (one session's storm doesn't block another)", async () => {
    for (let i = 0; i < REBIND_RATE_LIMIT.maxPerWindow; i++) {
      await RebindEpoch.bumpEpoch({ sessionID: "ses_busy", trigger: "slash_reload" })
    }
    const rejected = await RebindEpoch.bumpEpoch({ sessionID: "ses_busy", trigger: "slash_reload" })
    expect(rejected.status).toBe("rate_limited")

    // Different session — still ok
    const fresh = await RebindEpoch.bumpEpoch({ sessionID: "ses_quiet", trigger: "daemon_start" })
    expect(fresh.status).toBe("bumped")
    expect(fresh.currentEpoch).toBe(1)
  })
})

describe("RebindEpoch — session cleanup", () => {
  it("clearSession drops the entry (DD-13 isolation + memory GC)", async () => {
    const s = "ses_cleanup"
    await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "daemon_start" })
    expect(RebindEpoch.current(s)).toBe(1)
    RebindEpoch.clearSession(s)
    expect(RebindEpoch.current(s)).toBe(0) // back to sentinel
    expect(RebindEpoch.stats().entries.find((e) => e.sessionID === s)).toBeUndefined()
  })

  it("cleared session can restart from epoch 1 on next bump", async () => {
    const s = "ses_reset"
    await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "daemon_start" })
    await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "slash_reload" })
    expect(RebindEpoch.current(s)).toBe(2)
    RebindEpoch.clearSession(s)
    const restarted = await RebindEpoch.bumpEpoch({ sessionID: s, trigger: "daemon_start" })
    expect(restarted.previousEpoch).toBe(0)
    expect(restarted.currentEpoch).toBe(1)
  })
})

describe("RebindEpoch — stats telemetry", () => {
  it("exposes all active session epochs with lastBumpAt + lastTrigger", async () => {
    await RebindEpoch.bumpEpoch({ sessionID: "ses_a", trigger: "daemon_start" })
    await RebindEpoch.bumpEpoch({ sessionID: "ses_b", trigger: "slash_reload", reason: "test" })
    const s = RebindEpoch.stats()
    expect(s.asOf).toBeGreaterThan(0)
    expect(s.entries).toHaveLength(2)
    const a = s.entries.find((e) => e.sessionID === "ses_a")
    const b = s.entries.find((e) => e.sessionID === "ses_b")
    expect(a?.epoch).toBe(1)
    expect(a?.lastTrigger).toBe("daemon_start")
    expect(b?.epoch).toBe(1)
    expect(b?.lastTrigger).toBe("slash_reload")
  })
})
