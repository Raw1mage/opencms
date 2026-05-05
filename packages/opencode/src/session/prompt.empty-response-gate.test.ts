import { describe, expect, it } from "bun:test"
import { evaluateEmptyResponseGate } from "./prompt"

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
