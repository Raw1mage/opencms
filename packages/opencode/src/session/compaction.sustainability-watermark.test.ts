import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Session } from "."
import { Tweaks } from "../config/tweaks"
import type { MessageV2 } from "./message-v2"
import type { Provider } from "../provider/provider"

/**
 * 2026-05-13 rev5 — Compaction Sustainability Invariant watermark tests.
 *
 * Spec: specs/session/rebind-procedure-revision/events/event_2026-05-13_rev5-*
 *
 * Tested function: measureSustainabilityWatermark(sessionID, model)
 *
 * Behaviour matrix (anchor + post-anchor tokens vs model.context_limit):
 *
 * | anchor_tokens | post_anchor_tokens | ctx_limit | threshold | expected.ratio | expected.violated |
 * |---|---|---|---|---|---|
 * | 10k          |    5k              |  200k     |   0.5     |   0.075        |  false  |
 * | 60k          |   30k              |  200k     |   0.5     |   0.45         |  false  |
 * | 80k          |   30k              |  200k     |   0.5     |   0.55         |  true   |  ← typical bad case
 * | 80k          |    0k              |  100k     |   0.5     |   0.8          |  true   |  ← smaller model
 * | 80k          |    0k              |  500k     |   0.5     |   0.16         |  false  |  ← bigger model
 * | 50k          |   50k              |  200k     |   0.4     |   0.5          |  true   |  ← tighter threshold
 *
 * The cross-model invariance (same anchor, same residual → violation
 * decision depends only on model.context_limit) is the key property the
 * paper-level theorem relies on.
 */

const originalSessionMessages = Session.messages
const originalTweaksSync = Tweaks.compactionSync

afterEach(() => {
  ;(Session as any).messages = originalSessionMessages
  ;(Tweaks as any).compactionSync = originalTweaksSync
})

function mockSession(
  anchorText: string,
  postAnchorTexts: string[] = [],
): void {
  const messages: MessageV2.WithParts[] = []
  messages.push({
    info: {
      id: "msg_anchor",
      sessionID: "ses_wm_test",
      role: "assistant",
      summary: true,
    } as any,
    parts: [{ type: "text", text: anchorText } as any],
  })
  for (const [i, t] of postAnchorTexts.entries()) {
    messages.push({
      info: { id: `msg_post_${i + 1}`, sessionID: "ses_wm_test", role: i % 2 === 0 ? "user" : "assistant" } as any,
      parts: [{ type: "text", text: t } as any],
    })
  }
  ;(Session as any).messages = mock(async () => messages)
}

function mockThreshold(ratio: number) {
  ;(Tweaks as any).compactionSync = mock(() => ({
    ...originalTweaksSync(),
    sustainabilityRatio: ratio,
  }))
}

function model(contextLimit: number, providerId = "codex"): Provider.Model {
  return {
    id: "test-model",
    providerId,
    limit: { context: contextLimit, input: contextLimit, output: 8_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  } as Provider.Model
}

// Each "x".repeat(N) ≈ N/4 tokens (the helper uses Math.ceil(len/4))
const TOK = (n: number) => "x".repeat(n * 4)

describe("measureSustainabilityWatermark — ratio computation", () => {
  it("anchor only, well under threshold → not violated", async () => {
    mockSession(TOK(10_000))
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(200_000))
    expect(wm).not.toBeNull()
    expect(wm!.anchorTokens).toBe(10_000)
    expect(wm!.contextResidual).toBe(10_000)
    expect(wm!.ratio).toBeCloseTo(0.05, 2)
    expect(wm!.violated).toBe(false)
  })

  it("anchor + post-anchor at 45% → not violated", async () => {
    mockSession(TOK(60_000), [TOK(30_000)])
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(200_000))
    expect(wm!.contextResidual).toBe(90_000)
    expect(wm!.ratio).toBeCloseTo(0.45, 2)
    expect(wm!.violated).toBe(false)
  })

  it("anchor + post-anchor at 55% → violated (typical bad case)", async () => {
    mockSession(TOK(80_000), [TOK(30_000)])
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(200_000))
    expect(wm!.contextResidual).toBe(110_000)
    expect(wm!.ratio).toBeCloseTo(0.55, 2)
    expect(wm!.violated).toBe(true)
  })

  it("MODEL INVARIANCE: same residual, smaller context → violated", async () => {
    mockSession(TOK(80_000))
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(100_000))
    expect(wm!.ratio).toBeCloseTo(0.8, 2)
    expect(wm!.violated).toBe(true)
  })

  it("MODEL INVARIANCE: same residual, larger context → NOT violated", async () => {
    mockSession(TOK(80_000))
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(500_000))
    expect(wm!.ratio).toBeCloseTo(0.16, 2)
    expect(wm!.violated).toBe(false)
  })

  it("custom threshold 0.4 → 50% residual now violates", async () => {
    mockSession(TOK(50_000), [TOK(50_000)])
    mockThreshold(0.4)
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(200_000))
    expect(wm!.threshold).toBe(0.4)
    expect(wm!.ratio).toBeCloseTo(0.5, 2)
    expect(wm!.violated).toBe(true)
  })

  it("no anchor present → returns null", async () => {
    ;(Session as any).messages = mock(async () => [
      {
        info: { id: "msg_user_1", sessionID: "ses_wm_test", role: "user" } as any,
        parts: [{ type: "text", text: "hello" } as any],
      },
    ])
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(200_000))
    expect(wm).toBeNull()
  })

  it("model.context = 0 → returns null (defensive)", async () => {
    mockSession(TOK(10_000))
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(0))
    expect(wm).toBeNull()
  })

  it("empty session → returns null", async () => {
    ;(Session as any).messages = mock(async () => [])
    const wm = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(200_000))
    expect(wm).toBeNull()
  })
})

describe("Compaction Sustainability Invariant — paper-theorem cross-model property", () => {
  // Theorem: For a fixed anchor body, the sustainability decision should
  // depend ONLY on model.context_limit. Two providers with the same
  // anchor produce the same `violated` decision iff their context_limits
  // bracket the threshold the same way.
  it("anchor=100K residual; 128K-context model → violated; 272K-context model → NOT violated", async () => {
    mockSession(TOK(100_000))
    const wmSmall = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(128_000))
    const wmLarge = await SessionCompaction.__test__.measureSustainabilityWatermark("ses_wm_test", model(272_000))
    expect(wmSmall!.violated).toBe(true)
    expect(wmLarge!.violated).toBe(false)
    expect(wmSmall!.anchorTokens).toBe(wmLarge!.anchorTokens) // same physical anchor
  })
})
