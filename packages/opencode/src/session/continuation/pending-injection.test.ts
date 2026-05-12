import { afterEach, describe, expect, it } from "bun:test"
import { PendingInjectionStore, type PendingContinuationInjection } from "./pending-injection"

afterEach(() => {
  PendingInjectionStore.reset()
})

function fixture(overrides: Partial<PendingContinuationInjection> = {}): PendingContinuationInjection {
  return {
    chainInit: true,
    amnesia: false,
    digest: null,
    reason: "account_switch",
    ts: Date.now(),
    ...overrides,
  }
}

describe("PendingInjectionStore", () => {
  it("peek before mark returns null", () => {
    expect(PendingInjectionStore.peek("ses_x")).toBeNull()
  })

  it("mark + peek round-trips the marker", () => {
    PendingInjectionStore.mark("ses_x", fixture())
    const r = PendingInjectionStore.peek("ses_x")
    expect(r).not.toBeNull()
    expect(r!.chainInit).toBe(true)
    expect(r!.reason).toBe("account_switch")
  })

  it("consume reads + clears (once-after-chain-break)", () => {
    PendingInjectionStore.mark("ses_x", fixture())
    const first = PendingInjectionStore.consume("ses_x")
    expect(first).not.toBeNull()
    const second = PendingInjectionStore.consume("ses_x")
    expect(second).toBeNull()
  })

  it("clear is idempotent", () => {
    PendingInjectionStore.clear("ses_unknown")
    PendingInjectionStore.clear("ses_unknown")
    expect(PendingInjectionStore.peek("ses_unknown")).toBeNull()
  })

  it("isolates markers across sessions", () => {
    PendingInjectionStore.mark("ses_a", fixture({ reason: "account_switch" }))
    PendingInjectionStore.mark("ses_b", fixture({ reason: "empty_response_recovery" }))
    expect(PendingInjectionStore.peek("ses_a")!.reason).toBe("account_switch")
    expect(PendingInjectionStore.peek("ses_b")!.reason).toBe("empty_response_recovery")
  })

  it("mark overwrites prior marker for the same session", () => {
    PendingInjectionStore.mark("ses_x", fixture({ reason: "account_switch" }))
    PendingInjectionStore.mark("ses_x", fixture({ reason: "empty_response_recovery" }))
    expect(PendingInjectionStore.peek("ses_x")!.reason).toBe("empty_response_recovery")
  })

  it("size reflects the number of pending markers", () => {
    PendingInjectionStore.mark("a", fixture())
    PendingInjectionStore.mark("b", fixture())
    PendingInjectionStore.mark("c", fixture())
    expect(PendingInjectionStore.size()).toBe(3)
    PendingInjectionStore.consume("a")
    expect(PendingInjectionStore.size()).toBe(2)
    PendingInjectionStore.reset()
    expect(PendingInjectionStore.size()).toBe(0)
  })

  it("supports amnesia-only markers (chainInit=false, amnesia=true)", () => {
    PendingInjectionStore.mark("ses_x", fixture({ chainInit: false, amnesia: true, reason: "compaction_cache_aware" }))
    const r = PendingInjectionStore.peek("ses_x")
    expect(r!.chainInit).toBe(false)
    expect(r!.amnesia).toBe(true)
  })
})
