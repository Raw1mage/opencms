import { afterEach, describe, expect, it, mock } from "bun:test"
import { captureTurnSummaryOnExit, extractFinalAssistantText } from "./prompt"
import { Memory } from "./memory"
import type { MessageV2 } from "./message-v2"

const originalAppend = Memory.appendTurnSummary

afterEach(() => {
  ;(Memory as any).appendTurnSummary = originalAppend
})

function makeAssistant(overrides: Partial<MessageV2.Assistant> = {}): MessageV2.Assistant {
  return {
    id: "msg_a1",
    role: "assistant",
    sessionID: "ses_test",
    parentID: "msg_u1",
    mode: "default",
    agent: "default",
    modelID: "gpt-5.5",
    providerId: "codex",
    accountId: "acc-A",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 1700000000000 },
    ...overrides,
  } as MessageV2.Assistant
}

function makeUser(overrides: Partial<MessageV2.User> = {}): MessageV2.User {
  return {
    id: "msg_u1",
    role: "user",
    sessionID: "ses_test",
    agent: "default",
    model: { providerId: "codex", modelID: "gpt-5.5" },
    time: { created: 1 },
    ...overrides,
  } as MessageV2.User
}

describe("compaction-redesign phase 3 — TurnSummary capture", () => {
  it("extractFinalAssistantText concatenates text parts in order", () => {
    const parts: MessageV2.Part[] = [
      { id: "p1", messageID: "msg_a1", sessionID: "s", type: "text", text: "first " } as any,
      { id: "p2", messageID: "msg_a1", sessionID: "s", type: "reasoning", text: "thinking..." } as any,
      { id: "p3", messageID: "msg_a1", sessionID: "s", type: "text", text: "second" } as any,
    ]
    expect(extractFinalAssistantText(parts)).toBe("first \nsecond")
  })

  it("extractFinalAssistantText returns empty when no text parts", () => {
    const parts: MessageV2.Part[] = [
      { id: "p1", messageID: "msg_a1", sessionID: "s", type: "reasoning", text: "..." } as any,
    ]
    expect(extractFinalAssistantText(parts)).toBe("")
  })

  it("extractFinalAssistantText handles undefined parts (graceful skip)", () => {
    expect(extractFinalAssistantText(undefined)).toBe("")
    expect(extractFinalAssistantText([])).toBe("")
  })

  it("captureTurnSummaryOnExit appends TurnSummary on happy path", async () => {
    let captured: { sessionID: string; summary: Memory.TurnSummary } | undefined
    ;(Memory as any).appendTurnSummary = mock(async (sid: string, s: Memory.TurnSummary) => {
      captured = { sessionID: sid, summary: s }
    })

    const lastAssistant = makeAssistant()
    const lastUser = makeUser()
    const msgs: MessageV2.WithParts[] = [
      {
        info: lastUser,
        parts: [
          { id: "pu", messageID: "msg_u1", sessionID: "ses_test", type: "text", text: "user said this" } as any,
        ],
      },
      {
        info: lastAssistant,
        parts: [
          {
            id: "pa1",
            messageID: "msg_a1",
            sessionID: "ses_test",
            type: "text",
            text: "Done. I edited foo.ts and ran tests.",
          } as any,
        ],
      },
    ]

    captureTurnSummaryOnExit({
      sessionID: "ses_test",
      lastAssistant,
      lastUser,
      msgs,
      step: 3,
    })

    // Fire-and-forget: give the microtask a chance to settle
    await new Promise((r) => setTimeout(r, 5))

    expect(captured).toBeDefined()
    expect(captured?.sessionID).toBe("ses_test")
    expect(captured?.summary.text).toBe("Done. I edited foo.ts and ran tests.")
    expect(captured?.summary.turnIndex).toBe(3)
    expect(captured?.summary.userMessageId).toBe("msg_u1")
    expect(captured?.summary.assistantMessageId).toBe("msg_a1")
    expect(captured?.summary.modelID).toBe("gpt-5.5")
    expect(captured?.summary.providerId).toBe("codex")
    expect(captured?.summary.accountId).toBe("acc-A")
  })

  it("captureTurnSummaryOnExit skips when lastAssistant is undefined", async () => {
    const appendCall = mock(async () => {})
    ;(Memory as any).appendTurnSummary = appendCall

    captureTurnSummaryOnExit({
      sessionID: "ses_test",
      lastAssistant: undefined,
      lastUser: makeUser(),
      msgs: [],
      step: 1,
    })

    await new Promise((r) => setTimeout(r, 5))
    expect(appendCall).not.toHaveBeenCalled()
  })

  it("captureTurnSummaryOnExit skips when no text part in lastAssistant", async () => {
    const appendCall = mock(async () => {})
    ;(Memory as any).appendTurnSummary = appendCall

    const lastAssistant = makeAssistant()
    const msgs: MessageV2.WithParts[] = [
      {
        info: lastAssistant,
        parts: [
          { id: "pa1", messageID: "msg_a1", sessionID: "ses_test", type: "reasoning", text: "..." } as any,
        ],
      },
    ]

    captureTurnSummaryOnExit({
      sessionID: "ses_test",
      lastAssistant,
      lastUser: makeUser(),
      msgs,
      step: 2,
    })

    await new Promise((r) => setTimeout(r, 5))
    expect(appendCall).not.toHaveBeenCalled()
  })

  it("captureTurnSummaryOnExit does not throw when Memory.appendTurnSummary rejects (fire-and-forget)", async () => {
    ;(Memory as any).appendTurnSummary = mock(async () => {
      throw new Error("storage write failed")
    })

    const lastAssistant = makeAssistant()
    const msgs: MessageV2.WithParts[] = [
      {
        info: lastAssistant,
        parts: [
          { id: "pa1", messageID: "msg_a1", sessionID: "ses_test", type: "text", text: "ok" } as any,
        ],
      },
    ]

    // Must not throw synchronously, must not throw after promise settles
    expect(() =>
      captureTurnSummaryOnExit({
        sessionID: "ses_test",
        lastAssistant,
        lastUser: makeUser(),
        msgs,
        step: 1,
      }),
    ).not.toThrow()

    await new Promise((r) => setTimeout(r, 10))
    // No assertion failure means the .catch() handler swallowed the rejection
  })
})
