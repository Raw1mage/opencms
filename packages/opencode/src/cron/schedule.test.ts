import { describe, expect, it } from "bun:test"
import { Schedule } from "./schedule"
import type { CronSchedule } from "./types"

describe("Schedule", () => {
  describe("computeNextRunAtMs", () => {
    describe("at schedule", () => {
      it("returns future timestamp", () => {
        const future = Date.now() + 60_000
        const result = Schedule.computeNextRunAtMs(
          { kind: "at", at: new Date(future).toISOString() },
          Date.now(),
        )
        expect(result).toBe(future)
      })

      it("returns undefined for past timestamp", () => {
        const past = Date.now() - 60_000
        const result = Schedule.computeNextRunAtMs(
          { kind: "at", at: new Date(past).toISOString() },
          Date.now(),
        )
        expect(result).toBeUndefined()
      })

      it("returns undefined for invalid date", () => {
        const result = Schedule.computeNextRunAtMs({ kind: "at", at: "not-a-date" })
        expect(result).toBeUndefined()
      })
    })

    describe("every schedule", () => {
      it("computes next interval boundary", () => {
        const now = 1000000
        const result = Schedule.computeNextRunAtMs(
          { kind: "every", everyMs: 60000 },
          now,
        )
        // First fire is 60s from now (anchor = now)
        expect(result).toBe(now + 60000)
      })

      it("respects anchor time", () => {
        const anchor = 1000000
        const now = anchor + 150000 // 2.5 intervals past anchor
        const result = Schedule.computeNextRunAtMs(
          { kind: "every", everyMs: 60000, anchorMs: anchor },
          now,
        )
        // Next fire is at anchor + 3 * 60000
        expect(result).toBe(anchor + 180000)
      })

      it("returns anchor if anchor is in future", () => {
        const now = 1000000
        const anchor = now + 30000
        const result = Schedule.computeNextRunAtMs(
          { kind: "every", everyMs: 60000, anchorMs: anchor },
          now,
        )
        expect(result).toBe(anchor)
      })

      it("returns undefined for zero interval", () => {
        const result = Schedule.computeNextRunAtMs({ kind: "every", everyMs: 0 })
        expect(result).toBeUndefined()
      })
    })

    describe("cron schedule", () => {
      it("computes next run for every-minute expression", () => {
        const now = Date.now()
        const result = Schedule.computeNextRunAtMs(
          { kind: "cron", expr: "* * * * *" },
          now,
        )
        expect(result).toBeDefined()
        expect(result!).toBeGreaterThan(now)
        // Should be within 60 seconds
        expect(result! - now).toBeLessThanOrEqual(60_000)
      })

      it("applies stagger offset", () => {
        const now = Date.now()
        const withoutStagger = Schedule.computeNextRunAtMs(
          { kind: "cron", expr: "* * * * *" },
          now,
        )
        const withStagger = Schedule.computeNextRunAtMs(
          { kind: "cron", expr: "* * * * *", staggerMs: 5000 },
          now,
        )
        expect(withStagger).toBeDefined()
        expect(withoutStagger).toBeDefined()
        expect(withStagger! - withoutStagger!).toBe(5000)
      })

      it("returns undefined for invalid expression", () => {
        const result = Schedule.computeNextRunAtMs(
          { kind: "cron", expr: "invalid" },
        )
        expect(result).toBeUndefined()
      })
    })
  })

  describe("isExpired", () => {
    it("returns true for past at schedule", () => {
      const past = Date.now() - 60_000
      expect(Schedule.isExpired({ kind: "at", at: new Date(past).toISOString() })).toBe(true)
    })

    it("returns false for recurring schedule", () => {
      expect(Schedule.isExpired({ kind: "every", everyMs: 60000 })).toBe(false)
    })
  })

  describe("computeStaggerMs", () => {
    it("returns 0 for exact mode", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" }
      expect(Schedule.computeStaggerMs(schedule, "job-1", { exact: true })).toBe(0)
    })

    it("returns 0 for non-cron schedules", () => {
      const schedule: CronSchedule = { kind: "every", everyMs: 60000 }
      expect(Schedule.computeStaggerMs(schedule, "job-1")).toBe(0)
    })

    it("returns 0 for non-top-of-hour expressions", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "30 * * * *" }
      expect(Schedule.computeStaggerMs(schedule, "job-1")).toBe(0)
    })

    it("returns deterministic stagger for top-of-hour", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" }
      const s1 = Schedule.computeStaggerMs(schedule, "job-1")
      const s2 = Schedule.computeStaggerMs(schedule, "job-1")
      expect(s1).toBe(s2) // deterministic
      expect(s1).toBeGreaterThanOrEqual(0)
      expect(s1).toBeLessThan(5 * 60 * 1000) // within 5min window
    })

    it("different job IDs produce different staggers", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" }
      const s1 = Schedule.computeStaggerMs(schedule, "job-alpha")
      const s2 = Schedule.computeStaggerMs(schedule, "job-beta")
      // Different IDs should (almost always) produce different offsets
      // Note: hash collisions are possible but extremely unlikely for these inputs
      expect(s1 !== s2 || s1 === 0).toBe(true)
    })

    it("respects override", () => {
      const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" }
      expect(Schedule.computeStaggerMs(schedule, "job-1", { overrideMs: 42000 })).toBe(42000)
    })
  })
})
