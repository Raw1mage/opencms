import type { MessageV2 } from "./message-v2"
import { checkCleanTail } from "./idle-compaction-gate"

function userMsg(id: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "s",
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerId: "p", modelID: "m" },
    } as MessageV2.User,
    parts: [{ id: `${id}.p1`, sessionID: "s", messageID: id, type: "text", text: "hi" } as MessageV2.TextPart],
  }
}

function assistantMsg(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "s",
      role: "assistant",
      parentID: "p",
      mode: "default",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "m",
      providerId: "p",
      time: { created: 0 },
    } as MessageV2.Assistant,
    parts,
  }
}

function toolPart(callID: string, status: "pending" | "running" | "completed" | "error"): MessageV2.ToolPart {
  const stateBase = { input: {} as Record<string, unknown>, time: { start: 0 } }
  let state: MessageV2.ToolPart["state"]
  if (status === "pending") state = { status: "pending" }
  else if (status === "running") state = { status: "running", ...stateBase }
  else if (status === "completed")
    state = { status: "completed", ...stateBase, output: "ok", time: { start: 0, end: 1 }, metadata: {} }
  else state = { status: "error", ...stateBase, error: "x", time: { start: 0, end: 1 } }
  return {
    id: `tp-${callID}`,
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID,
    tool: "bash",
    state,
  } as MessageV2.ToolPart
}

describe("idle compaction clean-tail gate (DD-7)", () => {
  it("returns clean=true on empty input", () => {
    expect(checkCleanTail([])).toEqual({ clean: true, scannedMessageCount: 0 })
  })

  it("returns clean=true when last assistant has only completed tool parts", () => {
    const msgs = [userMsg("u1"), assistantMsg("a1", [toolPart("c1", "completed")])]
    const out = checkCleanTail(msgs)
    expect(out.clean).toBe(true)
    expect(out.scannedMessageCount).toBe(2)
  })

  it("returns clean=false on a single dangling pending tool_use", () => {
    const msgs = [userMsg("u1"), assistantMsg("a1", [toolPart("c1", "pending")])]
    const out = checkCleanTail(msgs)
    expect(out.clean).toBe(false)
    expect(out.reason).toBe("unmatched tool_use c1")
  })

  it("returns clean=false on running tool_use", () => {
    const msgs = [userMsg("u1"), assistantMsg("a1", [toolPart("c1", "running")])]
    expect(checkCleanTail(msgs).clean).toBe(false)
  })

  it("treats error state as clean (settled, just failed)", () => {
    const msgs = [userMsg("u1"), assistantMsg("a1", [toolPart("c1", "error")])]
    expect(checkCleanTail(msgs).clean).toBe(true)
  })

  it("lists multiple unmatched callIDs", () => {
    const msgs = [
      userMsg("u1"),
      assistantMsg("a1", [toolPart("c1", "running"), toolPart("c2", "pending"), toolPart("c3", "completed")]),
    ]
    const out = checkCleanTail(msgs)
    expect(out.clean).toBe(false)
    expect(out.reason).toBe("multiple unmatched tool_use [c1, c2]")
  })

  it("only scans the last N messages (default N=2)", () => {
    // Older message has dangling tool_use; should be IGNORED outside window.
    const msgs = [
      assistantMsg("a0", [toolPart("old", "pending")]),
      userMsg("u1"),
      assistantMsg("a1", [toolPart("c1", "completed")]),
    ]
    const out = checkCleanTail(msgs, 2)
    expect(out.clean).toBe(true)
    expect(out.scannedMessageCount).toBe(2)
  })

  it("respects custom window size", () => {
    const msgs = [
      assistantMsg("a0", [toolPart("old", "pending")]),
      userMsg("u1"),
      assistantMsg("a1", [toolPart("c1", "completed")]),
    ]
    const out = checkCleanTail(msgs, 3)
    expect(out.clean).toBe(false)
    expect(out.reason).toBe("unmatched tool_use old")
  })

  it("ignores user/tool/system messages even within the window", () => {
    const msgs = [userMsg("u1"), userMsg("u2"), userMsg("u3")]
    expect(checkCleanTail(msgs).clean).toBe(true)
  })
})
