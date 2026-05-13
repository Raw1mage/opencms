import { describe, it, expect, mock, beforeEach } from "bun:test"
import { Memory } from "./memory"
import { Session } from "./index"
import type { MessageV2 } from "./message-v2"

function assistantAnchor(
  id: string,
  sessionID: string,
  opts: { replacesAnchorId?: string; time?: number; text?: string } = {},
): MessageV2.WithParts {
  return {
    info: {
      id,
      role: "assistant",
      sessionID,
      summary: true,
      replacesAnchorId: opts.replacesAnchorId,
      time: { created: opts.time ?? 0 },
      modelID: "m",
      providerId: "p",
      accountId: "a",
      mode: "compaction",
      agent: "compaction",
      parentID: "parent",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: "/", root: "/" },
    } as any,
    parts: opts.text ? [{ type: "text", text: opts.text } as any] : ([] as any),
  } as MessageV2.WithParts
}

function userMsg(id: string, sessionID: string): MessageV2.WithParts {
  return {
    info: { id, role: "user", sessionID, time: { created: 0 } } as any,
    parts: [],
  } as MessageV2.WithParts
}

describe("compaction_simplification T7 — walkAnchorLineage", () => {
  beforeEach(() => {
    ;(Session as any).messages = mock(async () => [])
  })

  it("returns empty chain when session has no anchors", async () => {
    const chain = await Memory.Hybrid.walkAnchorLineage("ses_a", [userMsg("u1", "ses_a")])
    expect(chain).toEqual([])
  })

  it("returns single anchor when only one exists", async () => {
    const a = assistantAnchor("anc_1", "ses_a", { text: "anchor body" })
    const chain = await Memory.Hybrid.walkAnchorLineage("ses_a", [userMsg("u1", "ses_a"), a])
    expect(chain).toHaveLength(1)
    expect(chain[0].info.id).toBe("anc_1")
  })

  it("walks newest-first through replacesAnchorId pointers", async () => {
    const a1 = assistantAnchor("anc_1", "ses_a", { time: 100 })
    const a2 = assistantAnchor("anc_2", "ses_a", { time: 200, replacesAnchorId: "anc_1" })
    const a3 = assistantAnchor("anc_3", "ses_a", { time: 300, replacesAnchorId: "anc_2" })
    const chain = await Memory.Hybrid.walkAnchorLineage("ses_a", [a1, a2, a3])
    expect(chain.map((m) => m.info.id)).toEqual(["anc_3", "anc_2", "anc_1"])
  })

  it("falls back to chronological order when replacesAnchorId is absent (legacy anchors)", async () => {
    // Both anchors lack replacesAnchorId — pre-T7 legacy data shape.
    const a1 = assistantAnchor("anc_1", "ses_a", { time: 100 })
    const a2 = assistantAnchor("anc_2", "ses_a", { time: 200 })
    const chain = await Memory.Hybrid.walkAnchorLineage("ses_a", [a1, a2])
    expect(chain.map((m) => m.info.id)).toEqual(["anc_2", "anc_1"])
  })

  it("mixed-vintage chain: stitches explicit pointer + legacy fallback", async () => {
    // Two legacy anchors at the bottom, then a T7-aware anchor on top.
    const a1 = assistantAnchor("anc_1", "ses_a", { time: 100 })
    const a2 = assistantAnchor("anc_2", "ses_a", { time: 200 })
    const a3 = assistantAnchor("anc_3", "ses_a", { time: 300, replacesAnchorId: "anc_2" })
    const chain = await Memory.Hybrid.walkAnchorLineage("ses_a", [a1, a2, a3])
    expect(chain.map((m) => m.info.id)).toEqual(["anc_3", "anc_2", "anc_1"])
  })

  it("does not loop on first anchor when pointer is dangling", async () => {
    const a1 = assistantAnchor("anc_1", "ses_a", { time: 100, replacesAnchorId: "ghost_999" })
    const chain = await Memory.Hybrid.walkAnchorLineage("ses_a", [a1])
    expect(chain.map((m) => m.info.id)).toEqual(["anc_1"])
  })

  it("lineage length matches N for an N-compaction session (plan verification)", async () => {
    const N = 5
    const msgs: MessageV2.WithParts[] = []
    let prev: string | undefined
    for (let i = 1; i <= N; i++) {
      const id = `anc_${i}`
      msgs.push(assistantAnchor(id, "ses_a", { time: i * 100, replacesAnchorId: prev }))
      prev = id
    }
    const chain = await Memory.Hybrid.walkAnchorLineage("ses_a", msgs)
    expect(chain).toHaveLength(N)
    expect(chain[0].info.id).toBe(`anc_${N}`)
    expect(chain[N - 1].info.id).toBe("anc_1")
  })
})
