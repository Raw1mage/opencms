import { describe, expect, it, afterEach } from "bun:test"
import { Signals } from "./signals"

describe("Signals", () => {
  afterEach(() => {
    Signals.unregister()
  })

  it("registers and receives shutdown action", async () => {
    let receivedAction: string | undefined

    Signals.register((action) => {
      receivedAction = action
    })

    // Simulate SIGTERM
    process.emit("SIGTERM")
    expect(receivedAction).toBe("shutdown")
  })

  it("registers and receives restart action", async () => {
    let receivedAction: string | undefined

    Signals.register((action) => {
      receivedAction = action
    })

    // Simulate SIGUSR1
    process.emit("SIGUSR1")
    expect(receivedAction).toBe("restart")
  })

  it("replaces handler on re-register", () => {
    let firstCalled = false
    let secondCalled = false

    Signals.register(() => { firstCalled = true })
    Signals.register(() => { secondCalled = true })

    process.emit("SIGTERM")
    expect(firstCalled).toBe(false)
    expect(secondCalled).toBe(true)
  })
})
