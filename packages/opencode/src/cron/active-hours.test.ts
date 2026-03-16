import { describe, expect, it } from "bun:test"
import { ActiveHours } from "./active-hours"

describe("ActiveHours", () => {
  it("allows when no config", () => {
    const result = ActiveHours.check(undefined)
    expect(result.allowed).toBe(true)
  })

  it("allows within window (same-day)", () => {
    // Create a time that's 10:30
    const d = new Date()
    d.setHours(10, 30, 0, 0)

    const result = ActiveHours.check(
      { start: "09:00", end: "17:00" },
      d.getTime(),
    )
    expect(result.allowed).toBe(true)
  })

  it("blocks outside window (same-day)", () => {
    // Create a time that's 20:30
    const d = new Date()
    d.setHours(20, 30, 0, 0)

    const result = ActiveHours.check(
      { start: "09:00", end: "17:00" },
      d.getTime(),
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.nextEligibleMs).toBeGreaterThan(d.getTime())
    }
  })

  it("handles overnight window (start > end)", () => {
    // 22:00-06:00 window, time is 23:00 → should be allowed
    const d = new Date()
    d.setHours(23, 0, 0, 0)

    const result = ActiveHours.check(
      { start: "22:00", end: "06:00" },
      d.getTime(),
    )
    expect(result.allowed).toBe(true)
  })

  it("blocks during day for overnight window", () => {
    // 22:00-06:00 window, time is 12:00 → should be blocked
    const d = new Date()
    d.setHours(12, 0, 0, 0)

    const result = ActiveHours.check(
      { start: "22:00", end: "06:00" },
      d.getTime(),
    )
    expect(result.allowed).toBe(false)
  })

  it("returns next eligible time when blocked", () => {
    const d = new Date()
    d.setHours(7, 0, 0, 0)
    const nowMs = d.getTime()

    const result = ActiveHours.check(
      { start: "09:00", end: "17:00" },
      nowMs,
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      // Should be about 2 hours later
      const deltaMinutes = (result.nextEligibleMs - nowMs) / 60_000
      expect(deltaMinutes).toBeCloseTo(120, 0)
    }
  })
})
