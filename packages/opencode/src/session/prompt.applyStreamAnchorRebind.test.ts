import { describe, expect, it } from "bun:test"
import { applyStreamAnchorRebind, findMostRecentAnchorIndex } from "./prompt"

// Phase 13.2-B: stream-anchor rebind tests. Replaces the deleted
// `applyRebindCheckpoint` Phase 8 tests in compaction.test.ts. These exercise
// the single-source-of-truth recovery path: scan messages for the most recent
// `summary: true` assistant message and slice from there onward.

function userMsg(id: string, sid: string, text: string) {
  return {
    info: {
      id,
      sessionID: sid,
      role: "user",
      agent: "default",
      model: { providerId: "openai", modelID: "gpt-5.4" },
      time: { created: parseInt(id.replace(/\D/g, "")) || 1 },
    },
    parts: [{ id: `p_${id}`, messageID: id, sessionID: sid, type: "text", text }],
  } as any
}

function assistantMsg(id: string, sid: string, text: string, opts: { summary?: boolean; tools?: boolean } = {}) {
  const parts: any[] = [{ id: `p_${id}`, messageID: id, sessionID: sid, type: "text", text }]
  if (opts.tools) {
    parts.push({
      id: `p_${id}_t`,
      messageID: id,
      sessionID: sid,
      type: "tool",
      state: { status: "completed" },
    })
  }
  return {
    info: {
      id,
      sessionID: sid,
      role: "assistant",
      mode: "default",
      agent: "default",
      modelID: "gpt-5.4",
      providerId: "openai",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: parseInt(id.replace(/\D/g, "")) || 1, completed: parseInt(id.replace(/\D/g, "")) || 1 },
      ...(opts.summary ? { summary: true } : {}),
    },
    parts,
  } as any
}

describe("findMostRecentAnchorIndex", () => {
  it("returns -1 when no anchor exists in the stream", () => {
    const msgs = [userMsg("m1", "s", "hi"), assistantMsg("m2", "s", "ok")]
    expect(findMostRecentAnchorIndex(msgs)).toBe(-1)
  })

  it("returns the index of the most recent summary:true assistant", () => {
    const msgs = [
      userMsg("m1", "s", "hi"),
      assistantMsg("m2", "s", "summary one", { summary: true }),
      userMsg("m3", "s", "more"),
      assistantMsg("m4", "s", "summary two", { summary: true }),
      userMsg("m5", "s", "last"),
    ]
    expect(findMostRecentAnchorIndex(msgs)).toBe(3)
  })
})

describe("applyStreamAnchorRebind", () => {
  it("returns no_anchor when stream has no compaction anchor", () => {
    const msgs = [userMsg("m1", "s", "hi"), assistantMsg("m2", "s", "ok")]
    const result = applyStreamAnchorRebind(msgs)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe("no_anchor")
    expect(result.messages).toBe(msgs) // unchanged
  })

  it("slices stream from the most recent anchor onward (anchor included)", () => {
    const msgs = [
      userMsg("m1", "s", "earlier"),
      assistantMsg("m2", "s", "earlier-reply"),
      assistantMsg("m3", "s", "<compacted>", { summary: true }),
      userMsg("m4", "s", "post-anchor"),
      assistantMsg("m5", "s", "post-reply"),
    ]
    const result = applyStreamAnchorRebind(msgs)
    expect(result.applied).toBe(true)
    expect(result.anchorIndex).toBe(2)
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0].info.id).toBe("m3")
    expect((result.messages[0].info as any).summary).toBe(true)
    expect(result.messages[1].info.id).toBe("m4")
    expect(result.messages[2].info.id).toBe("m5")
  })

  it("refuses to slice when first post-anchor message is an assistant with completed tool calls (unsafe boundary)", () => {
    const msgs = [
      userMsg("m1", "s", "x"),
      assistantMsg("m2", "s", "<compacted>", { summary: true }),
      assistantMsg("m3", "s", "tool-using", { tools: true }), // unsafe: completed tool calls
    ]
    const result = applyStreamAnchorRebind(msgs)
    expect(result.applied).toBe(false)
    expect(result.reason).toBe("unsafe_boundary")
    expect(result.messages).toBe(msgs) // unchanged on refusal
  })

  it("only the most recent anchor wins when multiple anchors exist", () => {
    const msgs = [
      userMsg("m1", "s", "first goal"),
      assistantMsg("m2", "s", "<old>", { summary: true }),
      userMsg("m3", "s", "second goal"),
      assistantMsg("m4", "s", "<new>", { summary: true }),
      userMsg("m5", "s", "tail"),
    ]
    const result = applyStreamAnchorRebind(msgs)
    expect(result.applied).toBe(true)
    expect(result.anchorIndex).toBe(3)
    expect(result.messages.map((m) => m.info.id)).toEqual(["m4", "m5"])
  })

  it("anchor at end of stream with no post-anchor messages still applies (single-element result)", () => {
    const msgs = [
      userMsg("m1", "s", "x"),
      assistantMsg("m2", "s", "<compacted>", { summary: true }),
    ]
    const result = applyStreamAnchorRebind(msgs)
    expect(result.applied).toBe(true)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].info.id).toBe("m2")
  })
})
