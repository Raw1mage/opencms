import { describe, expect, it, beforeEach } from "bun:test"
import { Drain } from "./drain"

describe("Drain", () => {
  beforeEach(() => {
    Drain.reset()
  })

  it("starts in idle state", () => {
    const { state } = Drain.getState()
    expect(state).toBe("idle")
    expect(Drain.isDraining()).toBe(false)
  })

  it("enters drain mode", () => {
    Drain.enter("shutdown")
    expect(Drain.isDraining()).toBe(true)
    const { state, reason } = Drain.getState()
    expect(state).toBe("draining")
    expect(reason).toBe("shutdown")
  })

  it("marks drain complete", () => {
    Drain.enter("restart")
    Drain.complete()
    const { state } = Drain.getState()
    expect(state).toBe("drained")
    expect(Drain.isDraining()).toBe(true) // still draining until reset
  })

  it("resets to idle", () => {
    Drain.enter("shutdown")
    Drain.complete()
    Drain.reset()
    expect(Drain.isDraining()).toBe(false)
    const { state, reason } = Drain.getState()
    expect(state).toBe("idle")
    expect(reason).toBeUndefined()
  })

  it("returns correct timeout for shutdown vs restart", () => {
    Drain.enter("shutdown")
    expect(Drain.getTimeoutMs()).toBe(5_000)
    Drain.reset()
    Drain.enter("restart")
    expect(Drain.getTimeoutMs()).toBe(90_000)
  })

  it("waitFor resolves true when condition already met", async () => {
    const result = await Drain.waitFor(() => true, { timeoutMs: 100 })
    expect(result).toBe(true)
  })

  it("waitFor resolves false on timeout", async () => {
    const result = await Drain.waitFor(() => false, { timeoutMs: 100, pollMs: 50 })
    expect(result).toBe(false)
  })
})
