import { afterEach, describe, expect, it, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

function part(callID: string, output: string, tool = "read") {
  return {
    type: "tool" as const,
    callID,
    tool,
    state: {
      status: "completed" as const,
      input: {},
      output,
      title: callID,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

function msg(id: string, role: "user" | "assistant", parts: any[]) {
  return {
    info: { id, role },
    parts,
  } as any
}

describe("Memory.Hybrid.recallByCallId", () => {
  it("finds a ToolPart by exact callID across messages", async () => {
    const stream = [
      msg("msg_1", "user", [{ type: "text", text: "hello" }]),
      msg("msg_2", "assistant", [part("call_a", "AAA")]),
      msg("msg_3", "user", [part("call_a_result", "RESULT-AAA", "read")]),
    ]
    mock.module("@/session", () => ({
      Session: { messages: async () => stream },
    }))
    const { Memory } = await import("./memory")
    const hit = await Memory.Hybrid.recallByCallId("ses_test", "call_a_result")
    expect(hit).not.toBeNull()
    expect(hit!.toolPart.callID).toBe("call_a_result")
    expect(hit!.toolPart.tool).toBe("read")
    expect((hit!.toolPart.state as any).output).toBe("RESULT-AAA")
    expect(hit!.messageIndex).toBe(2)
  })

  it("returns null when callID is not present", async () => {
    const stream = [msg("msg_1", "assistant", [part("call_a", "AAA")])]
    mock.module("@/session", () => ({
      Session: { messages: async () => stream },
    }))
    const { Memory } = await import("./memory")
    const hit = await Memory.Hybrid.recallByCallId("ses_test", "call_nonexistent")
    expect(hit).toBeNull()
  })

  it("returns null when callID is empty string", async () => {
    const stream = [msg("msg_1", "assistant", [part("", "EMPTY")])]
    mock.module("@/session", () => ({
      Session: { messages: async () => stream },
    }))
    const { Memory } = await import("./memory")
    const hit = await Memory.Hybrid.recallByCallId("ses_test", "")
    expect(hit).toBeNull()
  })

  it("first match wins on duplicate callIDs", async () => {
    const stream = [
      msg("msg_1", "assistant", [part("call_dup", "first")]),
      msg("msg_2", "assistant", [part("call_dup", "second")]),
    ]
    mock.module("@/session", () => ({
      Session: { messages: async () => stream },
    }))
    const { Memory } = await import("./memory")
    const hit = await Memory.Hybrid.recallByCallId("ses_test", "call_dup")
    expect((hit!.toolPart.state as any).output).toBe("first")
    expect(hit!.messageIndex).toBe(0)
  })

  it("skips non-tool parts when scanning", async () => {
    const stream = [
      msg("msg_1", "assistant", [
        { type: "text", text: "irrelevant" },
        part("call_a", "AAA"),
      ]),
    ]
    mock.module("@/session", () => ({
      Session: { messages: async () => stream },
    }))
    const { Memory } = await import("./memory")
    const hit = await Memory.Hybrid.recallByCallId("ses_test", "call_a")
    expect(hit).not.toBeNull()
    expect(hit!.toolPart.callID).toBe("call_a")
  })

  it("idempotent: repeat calls return identical content", async () => {
    const stream = [msg("msg_1", "assistant", [part("call_a", "AAA")])]
    mock.module("@/session", () => ({
      Session: { messages: async () => stream },
    }))
    const { Memory } = await import("./memory")
    const hit1 = await Memory.Hybrid.recallByCallId("ses_test", "call_a")
    const hit2 = await Memory.Hybrid.recallByCallId("ses_test", "call_a")
    expect((hit1!.toolPart.state as any).output).toBe((hit2!.toolPart.state as any).output)
  })

  it("handles empty session stream", async () => {
    mock.module("@/session", () => ({
      Session: { messages: async () => [] },
    }))
    const { Memory } = await import("./memory")
    const hit = await Memory.Hybrid.recallByCallId("ses_test", "call_a")
    expect(hit).toBeNull()
  })
})
