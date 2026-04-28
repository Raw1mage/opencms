import { afterEach, describe, expect, it, mock } from "bun:test"
import { Memory } from "./memory"
import { SharedContext } from "./shared-context"
import { Session } from "."

const originalSharedGet = SharedContext.get
const originalSessionMessages = Session.messages

afterEach(() => {
  ;(SharedContext as any).get = originalSharedGet
  ;(Session as any).messages = originalSessionMessages
})

function userMsg(id: string, sid: string, text: string, time = 1) {
  return {
    info: {
      id,
      sessionID: sid,
      role: "user",
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5" },
      time: { created: time },
    },
    parts: [{ id: `p_${id}`, messageID: id, sessionID: sid, type: "text", text }],
  } as any
}

function assistantMsg(
  id: string,
  sid: string,
  text: string,
  opts: { summary?: boolean; finish?: string; time?: number; modelID?: string; providerId?: string; accountId?: string } = {},
) {
  return {
    info: {
      id,
      sessionID: sid,
      role: "assistant",
      mode: "default",
      agent: "default",
      modelID: opts.modelID ?? "gpt-5.5",
      providerId: opts.providerId ?? "codex",
      accountId: opts.accountId,
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: opts.finish ?? "stop",
      time: { created: opts.time ?? 1, completed: opts.time ?? 1 },
      ...(opts.summary ? { summary: true } : {}),
    },
    parts: [{ id: `p_${id}`, messageID: id, sessionID: sid, type: "text", text }],
  } as any
}

describe("Memory", () => {
  it("read returns empty SessionMemory when stream + SharedContext are both empty", async () => {
    ;(Session as any).messages = mock(async () => [])
    ;(SharedContext as any).get = mock(async () => undefined)

    const mem = await Memory.read("ses_empty")
    expect(mem.sessionID).toBe("ses_empty")
    expect(mem.turnSummaries).toEqual([])
    expect(mem.fileIndex).toEqual([])
    expect(mem.actionLog).toEqual([])
    expect(mem.lastCompactedAt).toBeNull()
    expect(mem.rawTailBudget).toBe(5)
  })

  it("read derives turnSummaries from finished assistant messages in the stream", async () => {
    const sid = "ses_derive"
    ;(Session as any).messages = mock(async () => [
      userMsg("u1", sid, "hi", 100),
      assistantMsg("a1", sid, "did stuff", { time: 200 }),
      userMsg("u2", sid, "more", 300),
      assistantMsg("a2", sid, "did more", { time: 400 }),
    ])
    ;(SharedContext as any).get = mock(async () => undefined)

    const mem = await Memory.read(sid)
    expect(mem.turnSummaries).toHaveLength(2)
    expect(mem.turnSummaries[0].text).toBe("did stuff")
    expect(mem.turnSummaries[0].userMessageId).toBe("u1")
    expect(mem.turnSummaries[0].assistantMessageId).toBe("a1")
    expect(mem.turnSummaries[0].turnIndex).toBe(0)
    expect(mem.turnSummaries[1].text).toBe("did more")
    expect(mem.turnSummaries[1].userMessageId).toBe("u2")
    expect(mem.turnSummaries[1].turnIndex).toBe(1)
  })

  it("read slices from most recent anchor — pre-anchor turns become single rolled-up entry", async () => {
    const sid = "ses_anchor"
    ;(Session as any).messages = mock(async () => [
      userMsg("u1", sid, "old goal", 100),
      assistantMsg("a1", sid, "old reply", { time: 200 }),
      userMsg("u2", sid, "more old", 300),
      assistantMsg("anchor", sid, "<rolled-up summary text>", { summary: true, time: 400 }),
      userMsg("u3", sid, "post-anchor", 500),
      assistantMsg("a3", sid, "post reply", { time: 600 }),
    ])
    ;(SharedContext as any).get = mock(async () => undefined)

    const mem = await Memory.read(sid)
    // First entry = the anchor's text (rolled-up summary of pre-anchor history)
    expect(mem.turnSummaries[0].text).toContain("rolled-up summary")
    expect(mem.turnSummaries[0].userMessageId).toBe("<prior-anchor>")
    expect(mem.turnSummaries[0].assistantMessageId).toBe("anchor")
    // Second entry = post-anchor finished assistant turn
    expect(mem.turnSummaries[1].text).toBe("post reply")
    expect(mem.turnSummaries[1].userMessageId).toBe("u3")
    expect(mem.turnSummaries).toHaveLength(2)
    // lastCompactedAt mirrors anchor time
    expect(mem.lastCompactedAt?.timestamp).toBe(400)
  })

  it("read skips unfinished + narration assistant messages", async () => {
    const sid = "ses_skip"
    ;(Session as any).messages = mock(async () => [
      userMsg("u1", sid, "x", 100),
      // Unfinished — should be skipped
      {
        info: {
          id: "a1",
          sessionID: sid,
          role: "assistant",
          mode: "default",
          agent: "default",
          modelID: "gpt-5.5",
          providerId: "codex",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          // no finish
          time: { created: 200 },
        },
        parts: [{ id: "p_a1", messageID: "a1", sessionID: sid, type: "text", text: "incomplete" }],
      },
      userMsg("u2", sid, "y", 300),
      assistantMsg("a2", sid, "real summary", { time: 400 }),
    ])
    ;(SharedContext as any).get = mock(async () => undefined)

    const mem = await Memory.read(sid)
    expect(mem.turnSummaries).toHaveLength(1)
    expect(mem.turnSummaries[0].text).toBe("real summary")
  })

  it("read accepts pre-loaded messages to skip stream load", async () => {
    const sid = "ses_preload"
    let streamCalls = 0
    ;(Session as any).messages = mock(async () => {
      streamCalls++
      return []
    })
    ;(SharedContext as any).get = mock(async () => undefined)

    const preloaded = [
      userMsg("u1", sid, "x", 100),
      assistantMsg("a1", sid, "did", { time: 200 }),
    ]
    const mem = await Memory.read(sid, preloaded)
    expect(mem.turnSummaries).toHaveLength(1)
    expect(streamCalls).toBe(0) // didn't call Session.messages
  })

  it("read picks up fileIndex + actionLog from SharedContext.Space", async () => {
    const sid = "ses_aux"
    ;(Session as any).messages = mock(async () => [])
    ;(SharedContext as any).get = mock(async () => ({
      sessionID: sid,
      version: 1,
      updatedAt: 1,
      budget: 0,
      goal: "",
      files: [{ path: "/src/a.ts", operation: "edit", lines: 100, updatedAt: 1 }],
      discoveries: [],
      actions: [{ tool: "bash", summary: "git status", turn: 1, addedAt: 1 }],
      currentState: "",
    }))

    const mem = await Memory.read(sid)
    expect(mem.fileIndex).toHaveLength(1)
    expect(mem.fileIndex[0].path).toBe("/src/a.ts")
    expect(mem.actionLog).toHaveLength(1)
    expect(mem.actionLog[0].summary).toBe("git status")
  })

  // ── Render: LLM form ──────────────────────────────────────

  it("renderForLLMSync returns empty string for empty Memory", () => {
    const mem: Memory.SessionMemory = {
      sessionID: "ses_render_empty",
      version: 0,
      updatedAt: 1,
      turnSummaries: [],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }
    expect(Memory.renderForLLMSync(mem)).toBe("")
  })

  it("renderForLLMSync concatenates turn texts without per-turn headers", () => {
    const mem: Memory.SessionMemory = {
      sessionID: "ses_render_llm",
      version: 2,
      updatedAt: 1700000000000,
      turnSummaries: [
        {
          turnIndex: 0,
          userMessageId: "msg_u1",
          endedAt: 1700000000000,
          text: "Edited foo.ts to fix the auth bug; tests green.",
          modelID: "gpt-5.5",
          providerId: "codex",
        },
        {
          turnIndex: 1,
          userMessageId: "msg_u2",
          endedAt: 1700000060000,
          text: "Ran the migration; verified no rows lost.",
          modelID: "gpt-5.5",
          providerId: "codex",
        },
      ],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }
    const out = Memory.renderForLLMSync(mem)
    expect(out).toContain("Edited foo.ts")
    expect(out).toContain("Ran the migration")
    expect(out).not.toContain("gpt-5.5")
    expect(out).not.toContain("codex")
    expect(out).not.toContain("Turn ")
  })

  it("renderForLLMSync falls back to fileIndex+actionLog when turnSummaries empty", () => {
    const mem: Memory.SessionMemory = {
      sessionID: "ses_render_fallback",
      version: 1,
      updatedAt: 1,
      turnSummaries: [],
      fileIndex: [{ path: "/src/a.ts", operation: "edit", updatedAt: 1 }],
      actionLog: [{ tool: "bash", summary: "Bash: git status...", turn: 1, addedAt: 1 }],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }
    const out = Memory.renderForLLMSync(mem)
    expect(out).toContain("/src/a.ts")
    expect(out).toContain("Bash: git status")
  })

  it("renderForLLMSync caps at maxTokens, dropping oldest", () => {
    const turnSummaries: Memory.TurnSummary[] = []
    for (let i = 0; i < 10; i++) {
      turnSummaries.push({
        turnIndex: i,
        userMessageId: `u${i}`,
        endedAt: i,
        text: `turn ${i} text ` + "x".repeat(400),
        modelID: "gpt-5.5",
        providerId: "codex",
      })
    }
    const mem: Memory.SessionMemory = {
      sessionID: "s",
      version: 1,
      updatedAt: 1,
      turnSummaries,
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }
    // Cap = 200 tokens = 800 chars. Each turn ~ 412 chars. Should keep the
    // newest 1 (the very last one).
    const out = Memory.renderForLLMSync(mem, 200)
    expect(out).toContain("turn 9")
    expect(out).not.toContain("turn 0")
  })

  // ── Render: Human form ────────────────────────────────────

  it("renderForHumanSync produces timeline format with turn headers", () => {
    const mem: Memory.SessionMemory = {
      sessionID: "ses_render_human",
      version: 2,
      updatedAt: 1700000060000,
      turnSummaries: [
        {
          turnIndex: 0,
          userMessageId: "msg_u1",
          endedAt: 1700000000000,
          text: "edited foo.ts",
          modelID: "gpt-5.5",
          providerId: "codex",
        },
      ],
      fileIndex: [{ path: "/src/foo.ts", operation: "edit", updatedAt: 1 }],
      actionLog: [{ tool: "bash", summary: "Bash: bun test", turn: 1, addedAt: 1 }],
      lastCompactedAt: { round: 0, timestamp: 1700000120000 },
      rawTailBudget: 5,
    }
    const out = Memory.renderForHumanSync(mem)
    expect(out).toContain("# Session ses_render_human")
    expect(out).toContain("## Turn 0")
    expect(out).toContain("edited foo.ts")
    expect(out).toContain("## Files touched")
    expect(out).toContain("/src/foo.ts")
    expect(out).toContain("## Action log")
    expect(out).toContain("Bash: bun test")
    expect(out).toContain("last compacted at")
    expect(out).toContain("codex/gpt-5.5")
  })

  it("renderForHumanSync handles empty memory gracefully", () => {
    const mem: Memory.SessionMemory = {
      sessionID: "ses_render_human_empty",
      version: 0,
      updatedAt: 1,
      turnSummaries: [],
      fileIndex: [],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }
    const out = Memory.renderForHumanSync(mem)
    expect(out).toContain("# Session ses_render_human_empty")
    expect(out).toContain("(no turn summaries captured yet)")
  })

  it("renderForLLMSync and renderForHumanSync produce distinct strings (R-8)", () => {
    const mem: Memory.SessionMemory = {
      sessionID: "ses_distinct",
      version: 1,
      updatedAt: 1700000000000,
      turnSummaries: [
        {
          turnIndex: 0,
          userMessageId: "msg_u1",
          endedAt: 1700000000000,
          text: "did stuff",
          modelID: "gpt-5.5",
          providerId: "codex",
        },
      ],
      fileIndex: [{ path: "/a.ts", operation: "edit", updatedAt: 1 }],
      actionLog: [],
      lastCompactedAt: null,
      rawTailBudget: 5,
    }
    const llm = Memory.renderForLLMSync(mem)
    const human = Memory.renderForHumanSync(mem)
    expect(llm).toContain("did stuff")
    expect(human).toContain("did stuff")
    expect(llm).not.toBe(human)
    expect(llm).not.toContain("## Turn")
    expect(human).toContain("## Turn 0")
    expect(human).toContain("# Session")
    expect(llm).not.toContain("# Session")
  })
})
