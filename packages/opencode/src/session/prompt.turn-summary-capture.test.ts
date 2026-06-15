import { describe, expect, it } from "bun:test"
import { extractFinalAssistantText } from "./prompt"
import type { MessageV2 } from "./message-v2"

// NOTE: captureTurnSummaryOnExit was removed in Phase 13.1 (see prompt.ts) —
// TurnSummaries are now derived at read time by Memory.read() rather than
// persisted on exit. Its tests are deleted; only extractFinalAssistantText
// (still exported) is covered here.

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
})
