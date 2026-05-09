import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Memory } from "./memory"
import { Session } from "."
import type { MessageV2 } from "./message-v2"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Tweaks } from "../config/tweaks"

const originalTweaksSync = Tweaks.compactionSync

const originalMemoryRead = Memory.read
const originalSessionGet = Session.get
const originalSessionMessages = Session.messages
const originalProviderGetModel = Provider.getModel
const originalAgentGet = Agent.get
const originalPluginTrigger = Plugin.trigger

afterEach(() => {
  ;(Memory as any).read = originalMemoryRead
  ;(Session as any).get = originalSessionGet
  ;(Session as any).messages = originalSessionMessages
  ;(Provider as any).getModel = originalProviderGetModel
  ;(Agent as any).get = originalAgentGet
  ;(Plugin as any).trigger = originalPluginTrigger
  ;(Tweaks as any).compactionSync = originalTweaksSync
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
  ;(Session as any).get = mock(async () => ({
    execution: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
  }))
  // Also produce an equivalent Session.messages stream so the
  // dialog-replay-redaction tryNarrative path (which reads messages
  // directly via serializeRedactedDialog) yields the same summaryText
  // assertions ("did stuff" etc) as the legacy turnSummaries path.
  const synthMessages = synthesizeMessagesFromTurnSummaries(mem.turnSummaries, sid)
  ;(Session as any).messages = mock(async () => synthMessages)
  ;(Provider as any).getModel = mock(async () => fakeModel())
}

function synthesizeMessagesFromTurnSummaries(
  turns: Memory.TurnSummary[],
  sid: string,
): MessageV2.WithParts[] {
  const out: MessageV2.WithParts[] = []
  turns.forEach((t, i) => {
    const userId = t.userMessageId || `msg_synth_u${i}`
    out.push({
      info: {
        id: userId,
        sessionID: sid,
        role: "user",
        time: { created: i * 2 },
        agent: "default",
        model: { providerId: "codex", modelID: "gpt-5.5" },
      } as any,
      parts: [
        {
          id: `prt_${userId}`,
          messageID: userId,
          sessionID: sid,
          type: "text",
          text: `synthetic round ${i}`,
          time: { start: 0, end: 0 },
        } as any,
      ],
    })
    const assistantId = `msg_synth_a${i}`
    out.push({
      info: {
        id: assistantId,
        sessionID: sid,
        role: "assistant",
        parentID: userId,
        modelID: t.modelID || "gpt-5.5",
        providerId: t.providerId || "codex",
        mode: "primary",
        agent: "default",
        path: { cwd: ".", root: "." },
        summary: false,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        time: { created: i * 2 + 1, completed: i * 2 + 1 },
      } as any,
      parts: [
        {
          id: `prt_${assistantId}`,
          messageID: assistantId,
          sessionID: sid,
          type: "text",
          text: t.text,
          time: { start: 0, end: 0 },
        } as any,
      ],
    })
  })
  return out
}

/**
 * Stub Session.messages to return a stream containing an anchor (assistant
 * message with summary:true) at `anchorAgeMs` milliseconds ago. Phase 13
 * cooldown reads anchor.time.created, not Memory.lastCompactedAt.
 */
function stubAnchorMessage(sid: string, anchorAgeMs: number | null) {
  if (anchorAgeMs === null) {
    ;(Session as any).messages = mock(async () => [])
    return
  }
  const anchorTime = Date.now() - anchorAgeMs
  ;(Session as any).messages = mock(async () => [
    {
      info: {
        id: "msg_anchor",
        role: "assistant",
        sessionID: sid,
        summary: true,
        time: { created: anchorTime },
      },
      parts: [],
    },
  ])
}

describe("compaction-redesign phase 4 — KIND_CHAIN + INJECT_CONTINUE table structure", () => {
  it("KIND_CHAIN entries are cost-monotonic except explicit server-priority recovery chains (INV-4)", () => {
    const COST = { narrative: 0, "replay-tail": 0, "low-cost-server": 1, "llm-agent": 2 } as const
    const chains = SessionCompaction.__test__.KIND_CHAIN
    for (const [observed, kinds] of Object.entries(chains)) {
      if (observed === "empty-response") {
        expect(kinds).toEqual(["low-cost-server", "narrative", "replay-tail", "llm-agent"])
        continue
      }
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

  it("manual chain has narrative + paid kinds (no replay-tail since manual user wants real compression)", () => {
    const kinds = SessionCompaction.__test__.KIND_CHAIN["manual"]
    expect(kinds).toEqual(["narrative", "low-cost-server", "llm-agent"])
  })

  it("provider-switched chain stays local-only (narrative + replay-tail, no paid kinds)", () => {
    expect(SessionCompaction.__test__.KIND_CHAIN["provider-switched"]).toEqual(["narrative", "replay-tail"])
  })

  it("Phase 13 REVISED — no chain contains 'schema' kind", () => {
    const chains = SessionCompaction.__test__.KIND_CHAIN
    for (const [, kinds] of Object.entries(chains)) {
      expect(kinds).not.toContain("schema" as any)
    }
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

describe("compaction-redesign phase 4 — Cooldown.shouldThrottle (DD-13 REVISED)", () => {
  it("returns false when no anchor message exists (never compacted)", async () => {
    setupCommonMocks({}, "ses_cooldown_null")
    stubAnchorMessage("ses_cooldown_null", null)
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_null")).toBe(false)
  })

  it("returns true when most recent anchor is within COOLDOWN_MS (30s)", async () => {
    setupCommonMocks({}, "ses_cooldown_within")
    stubAnchorMessage("ses_cooldown_within", 5_000) // 5s ago
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_within")).toBe(true)
  })

  it("returns false when most recent anchor is older than COOLDOWN_MS", async () => {
    setupCommonMocks({}, "ses_cooldown_past")
    stubAnchorMessage("ses_cooldown_past", 60_000) // 60s ago
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_past")).toBe(false)
  })

  it("uses single timestamp rule across runloop boundaries (round counter is irrelevant)", async () => {
    // Phase 13 collapses the round-vs-timestamp dual logic. Whether the
    // current step counter is fresh (1) or advanced (12) doesn't matter —
    // only the wall-clock distance to the most recent anchor.
    setupCommonMocks({}, "ses_cooldown_cross_recent")
    stubAnchorMessage("ses_cooldown_cross_recent", 1_000) // 1s ago
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_cross_recent")).toBe(true)

    setupCommonMocks({}, "ses_cooldown_cross_stale")
    stubAnchorMessage("ses_cooldown_cross_stale", 60_000) // 60s ago
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_cross_stale")).toBe(false)
  })

  it("ignores anchor with missing time.created (defensive against malformed messages)", async () => {
    setupCommonMocks({}, "ses_cooldown_malformed")
    ;(Session as any).messages = mock(async () => [
      {
        info: { id: "msg_anchor", role: "assistant", sessionID: "ses_cooldown_malformed", summary: true },
        parts: [],
      },
    ])
    expect(await SessionCompaction.Cooldown.shouldThrottle("ses_cooldown_malformed")).toBe(false)
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

  it("R-5: run({observed: 'provider-switched'}) permits local replay-tail but rejects paid kinds", async () => {
    // Provider-switched may recover from the local message tail, but must not
    // spend quota on low-cost-server or llm-agent.
    setupCommonMocks({ turnSummaries: [] }, "ses_run_pswitch")
    ;(Session as any).messages = mock(async () => [
      {
        info: { id: "msg_user", role: "user", sessionID: "ses_run_pswitch" },
        parts: [{ type: "text", text: "recover this provider-switched request" }],
      },
    ])
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_pswitch",
      observed: "provider-switched",
      step: 3,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe("replay-tail")
    expect(writes[0].auto).toBe(false)

    const chain = SessionCompaction.__test__.KIND_CHAIN["provider-switched"]
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
      },
      "ses_run_throttled",
    )
    // Phase 13 REVISED: cooldown reads anchor message timestamp, not Memory.
    stubAnchorMessage("ses_run_throttled", 1_000) // anchor 1s ago → within 30s window
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_throttled",
      observed: "overflow",
      step: 6,
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

  it("phase 5 — replay-tail executor succeeds when narrative empty + msg stream has text", async () => {
    setupCommonMocks({ turnSummaries: [] }, "ses_run_replay")
    ;(Session as any).messages = mock(async () => [
      {
        info: { id: "msg_u1", role: "user" },
        parts: [{ type: "text", text: "fix the auth bug" }],
      },
      {
        info: { id: "msg_a1", role: "assistant" },
        parts: [{ type: "text", text: "Looked at auth.ts, found token issue, patched." }],
      },
    ])
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_replay",
      observed: "overflow",
      step: 5,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe("replay-tail")
    expect(writes[0].summaryText).toContain("User: fix the auth bug")
    expect(writes[0].summaryText).toContain("Assistant: Looked at auth.ts")
  })

  it("phase 5 — low-cost-server executor succeeds when plugin returns compactedItems", async () => {
    // narrative empty, schema empty, manual chain skips schema/replay-tail
    setupCommonMocks({ turnSummaries: [] }, "ses_run_lowcost")
    ;(Session as any).messages = mock(async () => [
      {
        info: {
          id: "msg_u1",
          role: "user",
          agent: "default",
          model: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
        },
        parts: [{ type: "text", text: "do the thing" }],
      },
    ])
    ;(Agent as any).get = mock(async () => ({ prompt: "" }))
    ;(Plugin as any).trigger = mock(async () => ({
      compactedItems: [{ stub: true }],
      summary: "Server-compacted: did the thing.",
    }))
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_lowcost",
      observed: "manual",
      step: 2,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe("low-cost-server")
    expect(writes[0].summaryText).toContain("Server-compacted")
  })

  it("phase 5 — low-cost-server executor falls through when plugin returns null", async () => {
    setupCommonMocks({ turnSummaries: [] }, "ses_run_lowcost_null")
    ;(Session as any).messages = mock(async () => [
      {
        info: { id: "msg_u1", role: "user", agent: "default", model: { providerId: "codex", modelID: "gpt-5.5" } },
        parts: [{ type: "text", text: "x" }],
      },
    ])
    ;(Agent as any).get = mock(async () => ({ prompt: "" }))
    ;(Plugin as any).trigger = mock(async () => ({ compactedItems: null, summary: null }))
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async () => {
      writes.push("called")
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_lowcost_null",
      observed: "manual",
      step: 1,
    })

    // plugin null → low-cost-server fails; chain proceeds to llm-agent which is stub → "stop"
    expect(result).toBe("stop")
    expect(writes).toHaveLength(0)
  })

  it("phase 5 — replay-tail truncates oversize tail to model/target cap (newest preserved)", async () => {
    // Synthesize 20 rounds of moderate text — exceeds 30% of a SMALL model
    // context. tiny model: 8000 ctx → 30% = 2400 tokens (9600 chars) cap.
    // 20 × 2000 chars = 40000 chars ≈ 10K tokens. Cap = min(2400, 50000) = 2400.
    // New behaviour (DD-13 double-phase): replay-tail self-trims newest-first
    // instead of returning fail; estimate (~2400 tokens) is below target so no
    // escalation, anchor is written with the truncated tail.
    //
    // dialog-replay-redaction: this test asserts replay-tail behaviour, not
    // narrative-vs-replay-tail kind selection. With dialog-redaction enabled,
    // tryNarrative would always succeed on a non-empty Session.messages
    // stream. Disable the redaction flag for this test so legacy narrative
    // (turnSummaries empty → fail → fall through) preserves replay-tail's
    // chain position.
    ;(Tweaks as any).compactionSync = mock(() => ({
      ...originalTweaksSync(),
      enableDialogRedactionAnchor: false,
    }))
    const longText = "x".repeat(2000)
    const longMsgs = []
    for (let i = 0; i < 20; i++) {
      longMsgs.push({
        info: { id: `msg_${i}`, role: i % 2 === 0 ? "user" : "assistant" },
        parts: [{ type: "text", text: longText }],
      })
    }
    setupCommonMocks({ turnSummaries: [], rawTailBudget: 20 }, "ses_run_replay_truncate")
    ;(Provider as any).getModel = mock(async () => ({
      id: "tiny-model",
      providerId: "openai",
      limit: { context: 8000, input: 8000, output: 1000 },
      cost: { input: 1 },
    }))
    ;(Session as any).messages = mock(async () => longMsgs)
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    // Use `idle` chain (narrative → schema → replay-tail, no paid kinds).
    // Even though replay-tail is truncated, no paid kind is available, so
    // run() commits the truncated local result as best-effort.
    const result = await SessionCompaction.run({
      sessionID: "ses_run_replay_truncate",
      observed: "idle",
      step: 1,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe("replay-tail")
    // Truncated to ~9600 chars (2400 tokens × 4) plus minor join overhead.
    expect(writes[0].summaryText.length).toBeLessThanOrEqual(9600 + 100)
  })

  it("phase 5 — local kind over target escalates to paid kind (double-phase)", async () => {
    // Memory has narrative content well over the 50K-token target. tryNarrative
    // succeeds (ok=true) but its summary > target. With a paid kind (low-cost-
    // server) later in the chain, run() must NOT commit narrative; it must
    // escalate.
    const huge = "y".repeat(50_000 * 4 + 4_000) // > 50K tokens
    setupCommonMocks(
      {
        turnSummaries: [
          {
            turnIndex: 0,
            userMessageId: "msg_u1",
            endedAt: 1,
            text: huge,
            modelID: "gpt-5.5",
            providerId: "codex",
          },
        ],
        rawTailBudget: 5,
      },
      "ses_run_double_phase",
    )
    ;(Provider as any).getModel = mock(async () => ({
      id: "big-model",
      providerId: "codex",
      limit: { context: 1_000_000, input: 1_000_000, output: 32_000 },
      cost: { input: 1 },
    }))
    ;(Session as any).messages = mock(async () => [
      {
        info: { id: "msg_u1", role: "user", agent: "default", model: { providerId: "codex", modelID: "gpt-5.5" } },
        parts: [{ type: "text", text: "go" }],
      },
    ])
    ;(Agent as any).get = mock(async () => ({ prompt: "" }))
    ;(Plugin as any).trigger = mock(async () => ({
      compactedItems: [{ type: "text", text: "Server-compacted ok" }],
      summary: "Server-compacted ok",
    }))
    const writes: any[] = []
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    // `manual` chain = narrative → low-cost-server → llm-agent. narrative is
    // truncated and a paid kind (low-cost-server) is available next → escalate.
    const result = await SessionCompaction.run({
      sessionID: "ses_run_double_phase",
      observed: "manual",
      step: 2,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe("low-cost-server")
  })

  it("writes anchor on successful run (anchor IS the cooldown signal — no separate Memory.markCompacted call)", async () => {
    // Phase 13.1: Memory.markCompacted is gone. The anchor message written
    // by `_writeAnchor` carries `time.created = now`, which Cooldown reads
    // directly. This test verifies the anchor write is invoked with the
    // expected shape; cooldown wiring is exercised in the dedicated
    // Cooldown.shouldThrottle suite above.
    const writes: any[] = []
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
    SessionCompaction.__test__.setAnchorWriter(async (input) => {
      writes.push(input)
    })

    const result = await SessionCompaction.run({
      sessionID: "ses_run_mark",
      observed: "overflow",
      step: 9,
    })

    expect(result).toBe("continue")
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe("narrative")
  })
})
