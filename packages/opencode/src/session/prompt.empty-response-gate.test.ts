import { describe, expect, it } from "bun:test"
import { evaluateEmptyResponseGate, evaluateUnproductiveRound } from "./prompt"

describe("evaluateEmptyResponseGate (storm-prevention 2026-05-05)", () => {
  it("returns overflowSuspected=false at low usage (transient blip lane)", () => {
    const out = evaluateEmptyResponseGate({ used: 10_000, window: 200_000, floor: 0.8 })
    expect(out.overflowSuspected).toBe(false)
    expect(out.ratio).toBeCloseTo(0.05, 3)
  })

  it("returns overflowSuspected=true at exactly the floor (>=, not >)", () => {
    const out = evaluateEmptyResponseGate({ used: 160_000, window: 200_000, floor: 0.8 })
    expect(out.overflowSuspected).toBe(true)
    expect(out.ratio).toBeCloseTo(0.8, 3)
  })

  it("returns overflowSuspected=false just below the floor", () => {
    const out = evaluateEmptyResponseGate({ used: 159_000, window: 200_000, floor: 0.8 })
    expect(out.overflowSuspected).toBe(false)
    expect(out.ratio).toBeCloseTo(0.795, 3)
  })

  it("returns overflowSuspected=true when usage is well past the floor", () => {
    const out = evaluateEmptyResponseGate({ used: 180_000, window: 200_000, floor: 0.8 })
    expect(out.overflowSuspected).toBe(true)
    expect(out.ratio).toBeCloseTo(0.9, 3)
  })

  it("returns overflowSuspected=false on a zero / unknown window (refuses to fire on bad input)", () => {
    expect(evaluateEmptyResponseGate({ used: 100_000, window: 0, floor: 0.8 }).overflowSuspected).toBe(false)
    expect(evaluateEmptyResponseGate({ used: 100_000, window: NaN, floor: 0.8 }).overflowSuspected).toBe(false)
    expect(evaluateEmptyResponseGate({ used: 100_000, window: -1, floor: 0.8 }).overflowSuspected).toBe(false)
  })

  it("returns overflowSuspected=false when used=0 (no signal)", () => {
    expect(evaluateEmptyResponseGate({ used: 0, window: 200_000, floor: 0.8 }).overflowSuspected).toBe(false)
  })

  it("respects a configured floor override", () => {
    expect(evaluateEmptyResponseGate({ used: 110_000, window: 200_000, floor: 0.5 }).overflowSuspected).toBe(true)
    expect(evaluateEmptyResponseGate({ used: 110_000, window: 200_000, floor: 0.9 }).overflowSuspected).toBe(false)
  })
})

describe("evaluateUnproductiveRound (non-productive round circuit breaker)", () => {
  const C = 16 // ceiling
  const L = 3 // limit

  it("a tool-call round is productive and resets the streak", () => {
    const out = evaluateUnproductiveRound({ finish: "tool-calls", outputTokens: 0, consecutive: 2, ceiling: C, limit: L })
    expect(out.productive).toBe(true)
    expect(out.nextCount).toBe(0)
    expect(out.tripped).toBe(false)
  })

  it("a round with real output (> ceiling) is productive and resets — even on finish=other", () => {
    const out = evaluateUnproductiveRound({ finish: "other", outputTokens: 500, consecutive: 2, ceiling: C, limit: L })
    expect(out.productive).toBe(true)
    expect(out.nextCount).toBe(0)
    expect(out.tripped).toBe(false)
  })

  it("a tiny-output non-tool round increments the streak (Fable output=2/finish=other)", () => {
    const out = evaluateUnproductiveRound({ finish: "other", outputTokens: 2, consecutive: 0, ceiling: C, limit: L })
    expect(out.productive).toBe(false)
    expect(out.nextCount).toBe(1)
    expect(out.tripped).toBe(false)
  })

  it("trips exactly at the limit of consecutive non-productive rounds", () => {
    const out = evaluateUnproductiveRound({ finish: "unknown", outputTokens: 0, consecutive: 2, ceiling: C, limit: L })
    expect(out.nextCount).toBe(3)
    expect(out.tripped).toBe(true)
  })

  it("does not trip below the limit", () => {
    const out = evaluateUnproductiveRound({ finish: "other", outputTokens: 5, consecutive: 1, ceiling: C, limit: L })
    expect(out.tripped).toBe(false)
  })

  it("output exactly at the ceiling is NOT productive (strict >)", () => {
    const out = evaluateUnproductiveRound({ finish: "stop", outputTokens: C, consecutive: 0, ceiling: C, limit: L })
    expect(out.productive).toBe(false)
    expect(out.nextCount).toBe(1)
  })
})
