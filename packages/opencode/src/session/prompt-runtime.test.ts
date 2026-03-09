import { describe, expect, it } from "bun:test"
import { finish, start } from "./prompt-runtime"

describe("prompt runtime replacement", () => {
  it("replaces an existing run without letting the old finish clear the new one", () => {
    const sessionID = `session_test_runtime_${Date.now().toString(36)}`
    const first = start(sessionID)
    expect(first).toBeDefined()
    const second = start(sessionID, { replace: true })
    expect(second).toBeDefined()
    expect(first?.signal.aborted).toBe(true)
    expect(second?.signal.aborted).toBe(false)

    finish(sessionID, first!.runID)
    const third = start(sessionID)
    expect(third).toBeUndefined()

    finish(sessionID, second!.runID)
    const fourth = start(sessionID)
    expect(fourth).toBeDefined()

    if (fourth) finish(sessionID, fourth.runID)
  })
})
