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

// Minimal WithParts builders for filterCompacted (stream is newest-first).
const mkMsg = (id: string, role: "user" | "assistant", parts: any[] = []) =>
  ({ info: { id, role, sessionID: "ses_inv0_fc", time: { created: 0 } }, parts }) as any
const anchorMsg = (id: string) =>
  ({
    info: { id, role: "assistant", sessionID: "ses_inv0_fc", summary: true, time: { created: 0 } },
    parts: [{ id: `${id}_p`, type: "compaction", sessionID: "ses_inv0_fc", messageID: id }],
  }) as any
// claude-authored (supersede-framed) anchor: a compaction part PLUS a text part
// carrying the supersede marker emitted by sanitizeAnchorToString({claudeSupersede}).
const framedAnchorMsg = (id: string) =>
  ({
    info: { id, role: "assistant", sessionID: "ses_inv0_fc", summary: true, time: { created: 0 } },
    parts: [
      {
        id: `${id}_t`,
        type: "text",
        sessionID: "ses_inv0_fc",
        messageID: id,
        text: `<prior_context source="narrative" superseded_by_recent="true">\nEARLIER portion…\n</prior_context>`,
      },
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
      expect([...SessionCompaction.kindChainFor(observed as any)]).toEqual([
        ...BASELINE_KIND_CHAIN[observed],
      ])
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
      SessionCompaction.isOverflow({ tokens: mk(100_000), model: codexModel, sessionID: "ses_inv0_low", currentRound: 5 }),
    ).resolves.toBe(false)
  })

  it("overflows when crossing usable budget (260K of 272K, reserved 20K)", async () => {
    ;(Config as any).get = mock(async () => ({ compaction: { auto: true, reserved: 20_000 } }))
    await expect(
      SessionCompaction.isOverflow({ tokens: mk(260_000), model: codexModel, sessionID: "ses_inv0_high", currentRound: 5 }),
    ).resolves.toBe(true)
  })

  it("overflows at the emergency ceiling (270.5K) regardless of cooldown", async () => {
    ;(Config as any).get = mock(async () => ({ compaction: { auto: true, reserved: 20_000 } }))
    await expect(
      SessionCompaction.isOverflow({ tokens: mk(270_500), model: codexModel, sessionID: "ses_inv0_emerg", currentRound: 11 }),
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
})

describe("claude firefight: filterCompacted claudeFramedOnly (INV-1: use framed, ignore inherited)", () => {
  // Same stream as the codex baseline: [recent2, recent1, ANCHOR, old1, old0].
  // claude mode: an UNFRAMED (inherited codex-era) anchor is ignored and ALL
  // raw history is kept (no stop) — INV-1.
  it("drops an inherited (unframed) anchor and includes full raw history (pre+post)", async () => {
    const msgs = [
      mkMsg("msg_z", "assistant"),
      mkMsg("msg_y", "user"),
      anchorMsg("msg_m"),
      mkMsg("msg_b", "assistant"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs), undefined, { claudeFramedOnly: true })
    // unframed anchor msg_m dropped; everything else included, chronological.
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_a", "msg_b", "msg_y", "msg_z"])
    expect(result.messages.some((m: any) => m.info.id === "msg_m")).toBe(false)
    expect(result.stoppedByBudget).toBe(false)
  })

  it("ignores multiple inherited (unframed) anchors, full raw history survives", async () => {
    const msgs = [
      mkMsg("msg_y", "user"),
      anchorMsg("msg_m2"),
      mkMsg("msg_c", "assistant"),
      anchorMsg("msg_m1"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs), undefined, { claudeFramedOnly: true })
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_a", "msg_c", "msg_y"])
  })

  it("short referential user answer after an inherited anchor SURVIVES (#4 / DD-10 mechanism)", async () => {
    // assistant offers A/B (pre-anchor), an inherited anchor exists, then user
    // replies "A". The 1-char answer + the A/B options must both survive.
    const userAnswer = {
      info: { id: "msg_user_A", role: "user", sessionID: "ses_inv0_fc", time: { created: 9 } },
      parts: [{ id: "p_a", type: "text", text: "A" }],
    } as any
    const abOptions = {
      info: { id: "msg_ab", role: "assistant", sessionID: "ses_inv0_fc", time: { created: 1 } },
      parts: [{ id: "p_ab", type: "text", text: "Choose A or B" }],
    } as any
    const msgs = [userAnswer, anchorMsg("msg_m"), abOptions] // newest-first
    const result = await MessageV2.filterCompacted(streamOf(msgs), undefined, { claudeFramedOnly: true })
    const ids = result.messages.map((m: any) => m.info.id)
    expect(ids).toContain("msg_user_A") // the short answer is not dropped
    expect(ids).toContain("msg_ab") // its referent (the options) survives too
    expect(ids).not.toContain("msg_m") // inherited anchor dropped
  })

  // DD-16/18: claude USES its OWN supersede-framed anchor as the boundary —
  // bounded [framed anchor + tail], NOT a full raw dump. This is what makes the
  // cold-cache size-gate compaction actually save tokens.
  it("uses a claude framed anchor as the boundary (keeps anchor + tail, drops pre-anchor history)", async () => {
    const msgs = [
      mkMsg("msg_z", "assistant"),
      mkMsg("msg_y", "user"),
      framedAnchorMsg("msg_m"),
      mkMsg("msg_b", "assistant"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs), undefined, { claudeFramedOnly: true })
    // framed anchor is the boundary: [anchor, tail] only; pre-anchor msg_a/msg_b dropped.
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_m", "msg_y", "msg_z"])
    expect(result.messages.some((m: any) => m.info.id === "msg_a")).toBe(false)
  })

  it("stops at the FRAMED anchor even when an older inherited anchor exists below it", async () => {
    const msgs = [
      mkMsg("msg_y", "user"),
      framedAnchorMsg("msg_framed"),
      mkMsg("msg_c", "assistant"),
      anchorMsg("msg_inherited"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs), undefined, { claudeFramedOnly: true })
    // boundary is the framed anchor; the older inherited anchor + msg_a/msg_c are never reached.
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_framed", "msg_y"])
    expect(result.messages.some((m: any) => m.info.id === "msg_inherited")).toBe(false)
  })

  it("codex byte-identical: same stream WITHOUT the flag still stops at the first anchor (INV-0)", async () => {
    const msgs = [
      mkMsg("msg_z", "assistant"),
      mkMsg("msg_y", "user"),
      anchorMsg("msg_m"),
      mkMsg("msg_b", "assistant"),
      mkMsg("msg_a", "user"),
    ]
    const result = await MessageV2.filterCompacted(streamOf(msgs))
    // no opts → unchanged: stop at the anchor, keep [anchor, tail].
    expect(result.messages.map((m: any) => m.info.id)).toEqual(["msg_m", "msg_y", "msg_z"])
  })
})
