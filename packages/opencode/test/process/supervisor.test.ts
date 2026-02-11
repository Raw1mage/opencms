import { afterEach, describe, expect, test } from "bun:test"
import { ProcessSupervisor } from "@/process/supervisor"

afterEach(async () => {
  await ProcessSupervisor.disposeAll()
})

describe("ProcessSupervisor", () => {
  test("tracks session state transitions", () => {
    ProcessSupervisor.register({
      id: "call-a",
      kind: "task-subagent",
      sessionID: "ses_abc",
    })
    expect(ProcessSupervisor.sessionState("ses_abc")).toBe("running")

    ProcessSupervisor.markStalled("call-a")
    expect(ProcessSupervisor.sessionState("ses_abc")).toBe("stalled")

    ProcessSupervisor.touch("call-a")
    expect(ProcessSupervisor.sessionState("ses_abc")).toBe("running")

    ProcessSupervisor.kill("call-a")
    expect(ProcessSupervisor.sessionState("ses_abc")).toBeUndefined()
  })

  test("disposeAll clears all registered entries", async () => {
    ProcessSupervisor.register({
      id: "call-a",
      kind: "task-subagent",
      sessionID: "ses_a",
    })
    ProcessSupervisor.register({
      id: "call-b",
      kind: "task-subagent",
      sessionID: "ses_b",
    })
    expect(ProcessSupervisor.snapshot().length).toBe(2)

    await ProcessSupervisor.disposeAll()
    expect(ProcessSupervisor.snapshot().length).toBe(0)
    expect(ProcessSupervisor.sessionState("ses_a")).toBeUndefined()
    expect(ProcessSupervisor.sessionState("ses_b")).toBeUndefined()
  })
})

