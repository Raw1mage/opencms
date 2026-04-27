import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Memory } from "./memory"
import { Session } from "."
import { Provider } from "@/provider/provider"

const originalMemoryRead = Memory.read
const originalMemoryMarkCompacted = Memory.markCompacted
const originalSessionGet = Session.get
const originalProviderGetModel = Provider.getModel

afterEach(() => {
  ;(Memory as any).read = originalMemoryRead
  ;(Memory as any).markCompacted = originalMemoryMarkCompacted
  ;(Session as any).get = originalSessionGet
  ;(Provider as any).getModel = originalProviderGetModel
  SessionCompaction.__test__.resetAnchorWriter()
})

function fakeModel(): Provider.Model {
  return {
    id: "gpt-5.5",
    providerId: "codex",
    limit: { context: 272_000, input: 272_000, output: 32_000 },
    cost: { input: 1 },
  } as any
}

function setupCommonMocks(memory: Partial<Memory.SessionMemory>, sid: string) {
  const mem: Memory.SessionMemory = {
    sessionID: sid,
    version: 1,
    updatedAt: 1,
    turnSummaries: [],
    fileIndex: [],
    actionLog: [],
    lastCompactedAt: null,
    rawTailBudget: 5,
    ...memory,
  }
  ;(Memory as any).read = mock(async () => mem)
  ;(Memory as any).markCompacted = mock(async () => {})
  ;(Session as any).get = mock(async () => ({
    execution: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
  }))
  ;(Provider as any).getModel = mock(async () => fakeModel())
}

describe("compaction-redesign phase 4 — KIND_CHAIN + INJECT_CONTINUE table structure", () => {
  it("KIND_CHAIN entries are cost-monotonic for every observed (INV-4)", () => {
    const COST = { narrative: 0, schema: 0, "replay-tail": 0, "low-cost-server": 1, "llm-agent": 2 } as const
    const chains = SessionCompaction.__test__.KIND_CHAIN
    for (const [observed, kinds] of Object.entries(chains)) {
      let prev = -1
      for (const k of kinds) {
        const cost = COST[k as keyof typeof COST]
        expect(cost).toBeGreaterThanOrEqual(prev)
        prev = cost
      }
      // Every chain starts with a free kind (cost 0)
      expect(COST[kinds[0] as keyof typeof COST]).toBe(0)
    }
  })

  it("rebind / continuation-invalidated / provider-switched chains contain no paid kinds", () => {
    const chains = SessionCompaction.__test__.KIND_CHAIN
    for (const observed of ["rebind", "continuation-invalidated", "provider-switched"] as const) {
      const kinds = chains[observed]
      expect(kinds).not.toContain("low-cost-server")
      expect(kinds).not.toContain("llm-agent")
    }
  })

  it("manual chain skips schema (preserves user intent for narrative)", () => {
    const kinds = SessionCompaction.__test__.KIND_CHAIN["manual"]
    expect(kinds).toEqual(["narrative", "low-cost-server", "llm-agent"])
    expect(kinds).not.toContain("schema")
  })

  it("provider-switched chain stops at schema (no replay-tail, no codex)", () => {
    expect(SessionCompaction.__test__.KIND_CHAIN["provider-switched"]).toEqual([
      "narrative",
      "schema",
    ])
  })

  it("INJECT_CONTINUE: rebind / continuation-invalidated / provider-switched / manual = false (R-6)", () => {
    const t = SessionCompaction.__test__.INJECT_CONTINUE
    expect(t["rebind"]).toBe(false)
    expect(t["continuation-invalidated"]).toBe(false)
    expect(t["provider-switched"]).toBe(false)
    expect(t["manual"]).toBe(false)
  })

  it("INJECT_CONTINUE: overflow / cache-aware / idle = true", () => {
    const t = SessionCompaction.__test__.INJECT_CONTINUE
    expect(t["overflow"]).toBe(true)
    expect(t["cache-aware"]).toBe(true)
    expect(t["idle"]).toBe(true)
  })
})

describe("compaction-redesign phase 4 — Cooldown.shouldThrottle (DD-7)", () => {
  it("returns false when Memory.lastCompactedAt is null (never compacted)", async () => {
    setupCommonMocks({ lastCompactedAt: null }, "ses_cooldown_null")
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_null", 5)).toBe(false)
  })

  it("returns true when current round - lastCompactedRound < threshold", async () => {
    setupCommonMocks({ lastCompactedAt: { round: 10, timestamp: 1 } }, "ses_cooldown_within")
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_within", 12)).toBe(true)
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_within", 13)).toBe(true)
  })

  it("returns false when current round - lastCompactedRound >= threshold", async () => {
    setupCommonMocks({ lastCompactedAt: { round: 10, timestamp: 1 } }, "ses_cooldown_past")
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_past", 14)).toBe(false)
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_past", 100)).toBe(false)
  })

  it("respects custom threshold parameter", async () => {
    setupCommonMocks({ lastCompactedAt: { round: 10, timestamp: 1 } }, "ses_cooldown_custom")
    // Default threshold 4: round 13 throttled
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_custom", 13)).toBe(true)
    // Custom threshold 2: round 13 not throttled
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_custom", 13, 2)).toBe(false)
  })
})

describe("compaction-redesign phase 4 — run() entry point", () => {
  it("R-6: run({observed: 'rebind'}) writes anchor with auto=false (no Continue injection)", async () => {
    setupCommonMocks(
      {
        turnSummaries: [
          {
            turnIndex: 0,
            userMessageId: "msg_u1",
            endedAt: 1,
            text: "did stuff",
            modelID: "gpt-5.5",
            providerId: "codex",
          },
        ],
      },
      "ses_run_rebind",
    )
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_rebind",
      observed: "rebind",
      step: 5,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].auto).toBe(false) // R-6 acceptance
    expect(writes[0].kind).toBe("narrative")
    expect(writes[0].summaryText).toContain("did stuff")
  })

  it("R-4: run({observed: 'manual'}) with non-empty Memory uses narrative kind, no API call", async () => {
    setupCommonMocks(
      {
        turnSummaries: [
          {
            turnIndex: 0,
            userMessageId: "msg_u1",
            endedAt: 1,
            text: "previous turn narrative",
            modelID: "gpt-5.5",
            providerId: "codex",
          },
        ],
      },
      "ses_run_manual",
    )
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_manual",
      observed: "manual",
      step: 7,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe("narrative") // R-4: free path chosen, NO low-cost-server, NO llm-agent
    expect(writes[0].auto).toBe(false) // manual never injects Continue
  })

  it("R-5: run({observed: 'provider-switched'}) rejects kinds 3-5", async () => {
    // Memory has empty turnSummaries → narrative fails. Schema would be next
    // (but with stub it returns false). Provider-switched chain stops here.
    setupCommonMocks({ turnSummaries: [] }, "ses_run_pswitch")
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_pswitch",
      observed: "provider-switched",
      step: 3,
    })

    // No anchor written; chain returned "stop" because all attempted kinds
    // (narrative + schema stub) failed and replay-tail / low-cost-server /
    // llm-agent are NOT in provider-switched's chain.
    expect(result).toBe("stop")
    expect(writes).toHaveLength(0)

    // Verify chain doesn't contain replay-tail / paid kinds
    const chain = SessionCompaction.__test__.KIND_CHAIN["provider-switched"]
    expect(chain).not.toContain("replay-tail")
    expect(chain).not.toContain("low-cost-server")
    expect(chain).not.toContain("llm-agent")
  })

  it("Cooldown gates the entry: throttled run returns 'continue' without writing anchor", async () => {
    setupCommonMocks(
      {
        turnSummaries: [
          {
            turnIndex: 0,
            userMessageId: "msg_u1",
            endedAt: 1,
            text: "would compact if not throttled",
            modelID: "gpt-5.5",
            providerId: "codex",
          },
        ],
        lastCompactedAt: { round: 5, timestamp: 1 },
      },
      "ses_run_throttled",
    )
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_throttled",
      observed: "overflow",
      step: 6, // step - lastRound = 1, < default threshold 4 → throttled
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(0)
  })

  it("manual + intent='rich' skips kinds 1-3, goes straight to llm-agent (which is currently stub)", async () => {
    setupCommonMocks(
      {
        turnSummaries: [
          {
            turnIndex: 0,
            userMessageId: "msg_u1",
            endedAt: 1,
            text: "narrative would normally win",
            modelID: "gpt-5.5",
            providerId: "codex",
          },
        ],
      },
      "ses_run_rich",
    )
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_rich",
      observed: "manual",
      step: 1,
      intent: "rich",
    })

    // llm-agent is stubbed in phase 4 (returns false) → chain exhausted
    expect(result).toBe("stop")
    expect(writes).toHaveLength(0)
    // Critical: narrative was NOT attempted (rich skips it)
    // We can't directly inspect attempts here, but writes.length=0 + result=stop
    // proves narrative didn't succeed and write the anchor.
  })

  it("overflow with narrative success: writes anchor with auto=true (Continue injection)", async () => {
    setupCommonMocks(
      {
        turnSummaries: [
          {
            turnIndex: 0,
            userMessageId: "msg_u1",
            endedAt: 1,
            text: "session ran long, time to compact",
            modelID: "gpt-5.5",
            providerId: "codex",
          },
        ],
      },
      "ses_run_overflow",
    )
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_overflow",
      observed: "overflow",
      step: 12,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].auto).toBe(true) // overflow allows synthetic Continue
    expect(writes[0].kind).toBe("narrative")
  })

  it("memory empty + paid kinds unimplemented (phase 4): chain exhausts and returns 'stop'", async () => {
    setupCommonMocks({ turnSummaries: [] }, "ses_run_exhausted")
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_exhausted",
      observed: "overflow",
      step: 1,
    })

    // Phase 4: schema/replay-tail/low-cost-server/llm-agent are stubs.
    // narrative empty + stubs all fail → "stop".
    expect(result).toBe("stop")
    expect(writes).toHaveLength(0)
  })

  it("calls Memory.markCompacted with the correct round on successful run", async () => {
    let markedAt: { round: number } | undefined
    setupCommonMocks(
      {
        turnSummaries: [
          {
            turnIndex: 0,
            userMessageId: "msg_u1",
            endedAt: 1,
            text: "ok",
            modelID: "gpt-5.5",
            providerId: "codex",
          },
        ],
      },
      "ses_run_mark",
    )
    ;(Memory as any).markCompacted = mock(async (_sid: string, at: { round: number }) => {
      markedAt = at
    })
    SessionCompaction.__test__.setAnchorWriter(async () => {})

    await SessionCompaction.run({
      sessionID: "ses_run_mark",
      observed: "overflow",
      step: 9,
    })

    expect(markedAt?.round).toBe(9)
  })
})
