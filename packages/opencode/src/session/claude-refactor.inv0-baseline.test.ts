/**
 * INV-0 reverse-regression baseline (context/claude-refactor, tasks Phase 1).
 *
 * Pins the CURRENT behavior of the context-assembly shared functions for
 * non-claude providers (codex / openai / copilot-cli byRequest). The
 * claude-refactor firefight gates claude-only behavior into these same
 * functions; this baseline asserts codex/copilot/local stay byte-identical
 * (INV-0). It must be GREEN before any shared-function edit, and stay green
 * after every edit. A red here = claude logic leaked onto a shared path.
 *
 * Snapshot taken from main @ 0658e7e15 (pre-refactor).
 */
import { describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { MessageV2 } from "./message-v2"
import { Config } from "@/config/config"
import { projectClaudeAnchors } from "./claude-context-policy"

// Minimal WithParts builders for filterCompacted (stream is newest-first).
const mkMsg = (id: string, role: "user" | "assistant", parts: any[] = []) =>
  ({ info: { id, role, sessionID: "ses_inv0_fc", time: { created: 0 } }, parts }) as any
const anchorMsg = (id: string) =>
  ({
    info: { id, role: "assistant", sessionID: "ses_inv0_fc", summary: true, time: { created: 0 } },
    parts: [{ id: `${id}_p`, type: "compaction", sessionID: "ses_inv0_fc", messageID: id }],
  }) as any
const rawTailAnchorMsg = (id: string) =>
  ({
    info: { id, role: "assistant", sessionID: "ses_inv0_fc", summary: true, time: { created: 0 } },
    parts: [
      {
        id: `${id}_p`,
        type: "compaction",
        sessionID: "ses_inv0_fc",
        messageID: id,
        metadata: { rawTailProjection: { rounds: 1 } },
      },
    ],
  }) as any
// neutral (DD-21) anchor: a compaction part PLUS a text part holding the
// base `<prior_context source="kind">` body WITHOUT supersede framing — the
// form every provider stores and every legacy anchor already has.
const neutralAnchorMsg = (id: string, body: string) =>
  ({
    info: { id, role: "assistant", sessionID: "ses_inv0_fc", summary: true, time: { created: 0 } },
    parts: [
      { id: `${id}_t`, type: "text", sessionID: "ses_inv0_fc", messageID: id, text: body },
      { id: `${id}_p`, type: "compaction", sessionID: "ses_inv0_fc", messageID: id },
    ],
  }) as any
async function* streamOf(msgs: any[]) {
  for (const m of msgs) yield m
}

// All observed conditions the kind chain dispatches on.
const OBSERVED = [
  "overflow",
  "cache-aware",
  "idle",
  "rebind",
  "continuation-invalidated",
  "provider-switched",
  "stall-recovery",
  "manual",
  "empty-response",
  "reload",
] as const

// Pre-refactor KIND_CHAIN snapshot (compaction.ts).
const BASELINE_KIND_CHAIN: Record<string, readonly string[]> = {
  overflow: ["narrative", "ai_paid"],
  "cache-aware": ["narrative", "ai_paid"],
  idle: ["narrative"],
  rebind: ["narrative"],
  "continuation-invalidated": ["narrative"],
  "provider-switched": ["narrative"],
  "stall-recovery": ["narrative"],
  manual: ["narrative"],
  "empty-response": ["narrative"],
  reload: ["narrative"],
}

describe("INV-0 baseline: kindChainFor (provider-agnostic base chains unchanged)", () => {
  for (const observed of OBSERVED) {
    it(`kindChainFor("${observed}") === baseline`, () => {
      expect([...SessionCompaction.kindChainFor(observed as any)]).toEqual([...BASELINE_KIND_CHAIN[observed]])
    })
  }
})

describe("INV-0 baseline: resolveKindChain for codex (unchanged by claude gating)", () => {
  for (const observed of OBSERVED) {
    it(`resolveKindChain(codex, "${observed}") === base chain`, () => {
      const got = SessionCompaction.resolveKindChain({ observed: observed as any, providerId: "codex" })
      expect([...got]).toEqual([...BASELINE_KIND_CHAIN[observed]])
    })
  }
})

describe("INV-0 baseline: resolveKindChain byRequest (copilot) path unchanged", () => {
  // byRequest providers append ai_paid on overflow / cache-aware only.
  it("byRequest overflow appends ai_paid", () => {
    const got = SessionCompaction.resolveKindChain({
      observed: "overflow" as any,
      providerId: "copilot-cli",
      byRequest: true,
    })
    expect([...got]).toEqual(["narrative", "ai_paid", "ai_paid"])
  })
  it("byRequest cache-aware appends ai_paid", () => {
    const got = SessionCompaction.resolveKindChain({
      observed: "cache-aware" as any,
      providerId: "copilot-cli",
      byRequest: true,
    })
    expect([...got]).toEqual(["narrative", "ai_paid", "ai_paid"])
  })
  it("byRequest idle does NOT append (only overflow/cache-aware)", () => {
    const got = SessionCompaction.resolveKindChain({
      observed: "idle" as any,
      providerId: "copilot-cli",
      byRequest: true,
    })
    expect([...got]).toEqual(["narrative"])
  })
})

describe("INV-0 baseline: isOverflow token-pressure verdict for codex (272K)", () => {
  const codexModel = {
    id: "gpt-5.5",
    providerId: "codex",
    limit: { context: 272_000, input: 272_000, output: 32_000 },
    cost: { input: 1 },
  } as any

  const mk = (total: number) => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total })

  it("does NOT overflow well under usable (100K)", async () => {
    ;(Config as any).get = mock(async () => ({ compaction: { auto: true, reserved: 20_000 } }))
    await expect(
      SessionCompaction.isOverflow({
        tokens: mk(100_000),
        model: codexModel,
        sessionID: "ses_inv0_low",
        currentRound: 5,
      }),
    ).resolves.toBe(false)
  })

  it("overflows when crossing usable budget (260K of 272K, reserved 20K)", async () => {
    ;(Config as any).get = mock(async () => ({ compaction: { auto: true, reserved: 20_000 } }))
    await expect(
      SessionCompaction.isOverflow({
        tokens: mk(260_000),
        model: codexModel,
        sessionID: "ses_inv0_high",
        currentRound: 5,
      }),
    ).resolves.toBe(true)
  })

  it("overflows at the emergency ceiling (270.5K) regardless of cooldown", async () => {
    ;(Config as any).get = mock(async () => ({ compaction: { auto: true, reserved: 20_000 } }))
    await expect(
      SessionCompaction.isOverflow({
        tokens: mk(270_500),
        model: codexModel,
        sessionID: "ses_inv0_emerg",
        currentRound: 11,
      }),
    ).resolves.toBe(true)
  })
})

describe("INV-0 baseline: filterCompacted stops at the anchor (codex/default behavior)", () => {
  // Stream is newest-first: [recent2, recent1, ANCHOR, old1, old0].
  // Current behavior: scan until the compaction anchor, then break and reverse.
  // Result (chronological) = [ANCHOR, recent1, recent2]; pre-anchor (old0/old1) dropped.
  // The claude-refactor firefight will gate claude to NOT stop here; codex must.
  it("includes anchor + post-anchor tail, drops pre-anchor history", async () => {
    const msgs = [
      mkMsg("msg_z", "assistant"),
      mkMsg("msg_y", "user"),
      anchorMsg("msg_m"),
      mkMsg("msg_b", "assistant"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs))
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_m", "msg_y", "msg_z"])
    expect(result.stoppedByBudget).toBe(false)
  })

  it("no contextLimit => budget guard inactive (stoppedByBudget always false)", async () => {
    const msgs = [mkMsg("msg_y", "user"), anchorMsg("msg_m"), mkMsg("msg_a", "user")]
    const result = await MessageV2.filterCompacted(streamOf(msgs))
    expect(result.stoppedByBudget).toBe(false)
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_m", "msg_y"])
  })

  it("with no anchor in stream, includes all messages (no early stop)", async () => {
    const msgs = [mkMsg("msg_z", "assistant"), mkMsg("msg_y", "user"), mkMsg("msg_x", "assistant")]
    const result = await MessageV2.filterCompacted(streamOf(msgs))
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_x", "msg_y", "msg_z"])
    expect(result.stoppedByBudget).toBe(false)
  })

  it("rawTailProjection restores one completed raw C round after the anchor", async () => {
    const msgs = [
      mkMsg("msg_replay", "user"),
      rawTailAnchorMsg("msg_anchor"),
      mkMsg("msg_original_unanswered", "user"),
      mkMsg("msg_c_assistant", "assistant"),
      mkMsg("msg_c_user", "user"),
      mkMsg("msg_old_assistant", "assistant"),
      mkMsg("msg_old_user", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs))
    expect(result.messages.map((m: any) => m.info.id)).toEqual([
      "msg_anchor",
      "msg_c_user",
      "msg_c_assistant",
      "msg_replay",
    ])
    expect(result.messages.some((m: any) => m.info.id === "msg_original_unanswered")).toBe(false)
    expect(result.messages.some((m: any) => m.info.id === "msg_old_user")).toBe(false)
  })
})

describe("filterCompacted is provider-agnostic (DD-21: no claude discriminator, INV-0 restored)", () => {
  // After DD-21 there is NO claudeFramedOnly flag — every provider, incl. the
  // claude path, stops at the most-recent anchor. claude-safety lives in
  // projectClaudeAnchors (read-time framing), not in this boundary scan. This
  // is what keeps a legacy session bounded on resume (the 206K→662K regression
  // fix): the (unframed) most-recent anchor still bounds the context.
  it("stops at the most-recent anchor for ANY stream — legacy session stays bounded", async () => {
    const msgs = [
      mkMsg("msg_z", "assistant"),
      mkMsg("msg_y", "user"),
      anchorMsg("msg_m"), // unframed/legacy anchor — still a boundary
      mkMsg("msg_b", "assistant"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs))
    // bounded by the anchor — NOT a full raw dump (the legacy-resume fix).
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_m", "msg_y", "msg_z"])
    expect(result.messages.some((m: any) => m.info.id === "msg_a")).toBe(false)
  })

  it("stops at the FIRST (most-recent) of multiple anchors", async () => {
    const msgs = [
      mkMsg("msg_y", "user"),
      anchorMsg("msg_recent"),
      mkMsg("msg_c", "assistant"),
      anchorMsg("msg_older"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs))
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_recent", "msg_y"])
    expect(result.messages.some((m: any) => m.info.id === "msg_older")).toBe(false)
  })
})

describe("projectClaudeAnchors (DD-21: read-time supersede framing)", () => {
  it("re-frames a neutral / legacy anchor body with the supersede frame", () => {
    const legacy = neutralAnchorMsg("msg_m", `<prior_context source="narrative">\ndo the thing\n</prior_context>`)
    const out = projectClaudeAnchors([mkMsg("msg_y", "user"), legacy])
    const anchor = out.find((m: any) => m.info.id === "msg_m") as any
    const text = anchor.parts.find((p: any) => p.type === "text").text
    expect(text).toContain('superseded_by_recent="true"')
    expect(text).toContain("more recent and authoritative")
    expect(text).toContain("do the thing") // content preserved
  })

  it("leaves non-anchor messages untouched (same reference, no clone)", () => {
    const u = mkMsg("msg_y", "user")
    const out = projectClaudeAnchors([u])
    expect(out[0]).toBe(u)
  })

  it("preserves content when re-framing an already-framed body (idempotent on content)", () => {
    const framed = neutralAnchorMsg(
      "msg_m",
      `<prior_context source="narrative" superseded_by_recent="true">\nkept content\n</prior_context>`,
    )
    const out = projectClaudeAnchors([framed]) as any
    const text = out[0].parts.find((p: any) => p.type === "text").text
    expect(text).toContain("kept content")
    expect(text).toContain('superseded_by_recent="true"')
  })
})
