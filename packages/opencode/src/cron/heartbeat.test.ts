import { describe, expect, it, mock, beforeEach } from "bun:test"
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
