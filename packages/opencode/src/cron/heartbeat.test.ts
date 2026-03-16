import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test"
import { Heartbeat } from "./heartbeat"
import { CronStore } from "./store"
import { ActiveHours } from "./active-hours"
import { SystemEvents } from "./system-events"
import type { CronJob } from "./types"

// --- Pure helper tests ---

describe("Heartbeat helpers", () => {
  describe("isHeartbeatOk", () => {
    it("detects HEARTBEAT_OK token", () => {
      expect(Heartbeat.isHeartbeatOk("HEARTBEAT_OK")).toBe(true)
      expect(Heartbeat.isHeartbeatOk("  HEARTBEAT_OK  ")).toBe(true)
    })

    it("rejects non-token text", () => {
      expect(Heartbeat.isHeartbeatOk("some content")).toBe(false)
      expect(Heartbeat.isHeartbeatOk("HEARTBEAT_OK and more")).toBe(false)
      expect(Heartbeat.isHeartbeatOk("")).toBe(false)
    })
  })

  describe("stripHeartbeatToken", () => {
    it("strips token from text", () => {
      expect(Heartbeat.stripHeartbeatToken("HEARTBEAT_OK")).toBe("")
      expect(Heartbeat.stripHeartbeatToken("prefix HEARTBEAT_OK suffix")).toBe("prefix  suffix")
    })

    it("preserves text without token", () => {
      expect(Heartbeat.stripHeartbeatToken("just some text")).toBe("just some text")
    })
  })
})

// --- Integration tests (real imports, mocked store/events) ---

function makeJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "job-hb-test",
    name: "heartbeat-test",
    enabled: true,
    createdAtMs: 1710000000000,
    updatedAtMs: 1710000000000,
    schedule: { kind: "every", everyMs: 1800_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "check system" },
    state: { nextRunAtMs: 1710000000000 - 1 },
    ...overrides,
  }
}

describe("Heartbeat.tick integration", () => {
  const originalListEnabled = CronStore.listEnabled
  const originalUpdateState = CronStore.updateState
  const originalDrain = SystemEvents.drain

  beforeEach(() => {
    // restore originals in case previous test failed
    ;(CronStore as any).listEnabled = originalListEnabled
    ;(CronStore as any).updateState = originalUpdateState
    ;(SystemEvents as any).drain = originalDrain
  })

  it("skips jobs that are not yet due", async () => {
    const futureJob = makeJob({ state: { nextRunAtMs: Date.now() + 999_999 } })
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([futureJob]))
    const updateCalls: any[] = []
    ;(CronStore as any).updateState = mock((...args: any[]) => {
      updateCalls.push(args)
      return Promise.resolve()
    })
    ;(SystemEvents as any).drain = mock(() => [])

    await Heartbeat.tick()
    // Job was not due — no state update expected
    expect(updateCalls.length).toBe(0)

    ;(CronStore as any).listEnabled = originalListEnabled
    ;(CronStore as any).updateState = originalUpdateState
    ;(SystemEvents as any).drain = originalDrain
  })

  it("evaluates due job and updates state", async () => {
    const dueJob = makeJob({ state: { nextRunAtMs: Date.now() - 1000 } })
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([dueJob]))
    const updateCalls: any[] = []
    ;(CronStore as any).updateState = mock((...args: any[]) => {
      updateCalls.push(args)
      return Promise.resolve()
    })
    ;(SystemEvents as any).drain = mock(() => [])

    await Heartbeat.tick()
    // Due job should trigger evaluation — at least one state update
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    expect(updateCalls[0][0]).toBe("job-hb-test")

    ;(CronStore as any).listEnabled = originalListEnabled
    ;(CronStore as any).updateState = originalUpdateState
    ;(SystemEvents as any).drain = originalDrain
  })

  it("respects active hours gate", async () => {
    const dueJob = makeJob({ state: { nextRunAtMs: Date.now() - 1000 } })
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([dueJob]))
    const updateCalls: any[] = []
    ;(CronStore as any).updateState = mock((...args: any[]) => {
      updateCalls.push(args)
      return Promise.resolve()
    })
    ;(SystemEvents as any).drain = mock(() => [])

    // Force outside_hours by providing an activeHours config that excludes current time
    await Heartbeat.tick({
      activeHours: { startHour: 99, endHour: 99, tz: "UTC" },
    })

    // Should have updated nextRunAtMs but not executed
    if (updateCalls.length > 0) {
      const stateUpdate = updateCalls[0][1]
      expect(stateUpdate.nextRunAtMs).toBeDefined()
      // Should NOT have lastRunStatus since job wasn't executed
      expect(stateUpdate.lastRunStatus).toBeUndefined()
    }

    ;(CronStore as any).listEnabled = originalListEnabled
    ;(CronStore as any).updateState = originalUpdateState
    ;(SystemEvents as any).drain = originalDrain
  })
})

// --- Boot recovery tests (Phase 1) ---

describe("Heartbeat.recoverSchedules", () => {
  const originalListEnabled = CronStore.listEnabled
  const originalUpdateState = CronStore.updateState
  const originalUpdate = CronStore.update

  let updateStateCalls: any[]
  let updateCalls: any[]

  beforeEach(() => {
    updateStateCalls = []
    updateCalls = []
    ;(CronStore as any).updateState = mock((...args: any[]) => {
      updateStateCalls.push(args)
      return Promise.resolve()
    })
    ;(CronStore as any).update = mock((...args: any[]) => {
      updateCalls.push(args)
      return Promise.resolve()
    })
  })

  afterEach(() => {
    ;(CronStore as any).listEnabled = originalListEnabled
    ;(CronStore as any).updateState = originalUpdateState
    ;(CronStore as any).update = originalUpdate
  })

  it("clean boot: preserves future nextRunAtMs", async () => {
    const futureJob = makeJob({
      state: { nextRunAtMs: Date.now() + 30 * 60_000 },
    })
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([futureJob]))

    const result = await Heartbeat.recoverSchedules()

    expect(result.total).toBe(1)
    expect(result.clean).toBe(1)
    expect(result.skippedToNext).toBe(0)
    expect(result.disabledExpired).toBe(0)
    expect(updateStateCalls.length).toBe(0)
    expect(updateCalls.length).toBe(0)
  })

  it("stale recurring job: skips to next future fire time", async () => {
    const now = Date.now()
    const staleRecurring = makeJob({
      id: "stale-recurring",
      schedule: { kind: "every", everyMs: 30 * 60_000 },
      state: { nextRunAtMs: now - 2 * 60 * 60_000 }, // 2 hours stale
    })
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([staleRecurring]))

    const result = await Heartbeat.recoverSchedules()

    expect(result.total).toBe(1)
    expect(result.skippedToNext).toBe(1)
    expect(result.disabledExpired).toBe(0)
    // Should have called updateState with a future nextRunAtMs
    expect(updateStateCalls.length).toBe(1)
    expect(updateStateCalls[0][0]).toBe("stale-recurring")
    expect(updateStateCalls[0][1].nextRunAtMs).toBeGreaterThan(now)
  })

  it("stale one-shot job: disabled with expired_on_boot", async () => {
    const now = Date.now()
    const staleOneShot = makeJob({
      id: "stale-oneshot",
      schedule: { kind: "at", at: "2026-03-16T00:00:00Z" },
      state: { nextRunAtMs: now - 24 * 60 * 60_000 }, // 1 day stale
    })
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([staleOneShot]))

    const result = await Heartbeat.recoverSchedules()

    expect(result.total).toBe(1)
    expect(result.disabledExpired).toBe(1)
    expect(result.skippedToNext).toBe(0)
    // Should have called update (not updateState) to disable the job
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0][0]).toBe("stale-oneshot")
    expect(updateCalls[0][1].enabled).toBe(false)
  })

  it("stale recurring with consecutiveErrors: backoff respected", async () => {
    const now = Date.now()
    const staleWithErrors = makeJob({
      id: "stale-errors",
      schedule: { kind: "every", everyMs: 30 * 60_000 },
      state: {
        nextRunAtMs: now - 2 * 60 * 60_000,
        consecutiveErrors: 3,
      },
    })
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([staleWithErrors]))

    const result = await Heartbeat.recoverSchedules()

    expect(result.total).toBe(1)
    expect(result.skippedToNext).toBe(1)
    expect(result.backoffApplied).toBe(1)
    // nextRunAtMs should be at least now + backoffMs(3) = now + 5min
    expect(updateStateCalls.length).toBe(1)
    const recoveredNext = updateStateCalls[0][1].nextRunAtMs
    expect(recoveredNext).toBeGreaterThanOrEqual(now + 5 * 60_000)
  })

  it("empty store: no crash, returns zero counts", async () => {
    ;(CronStore as any).listEnabled = mock(() => Promise.resolve([]))

    const result = await Heartbeat.recoverSchedules()

    expect(result.total).toBe(0)
    expect(result.clean).toBe(0)
    expect(result.skippedToNext).toBe(0)
    expect(result.disabledExpired).toBe(0)
    expect(result.backoffApplied).toBe(0)
  })
})
