import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { CompactionManager } from "./compaction-manager"
import { Session } from "."
import { Tweaks } from "../config/tweaks"
import { Plugin } from "@/plugin"
import type { MessageV2 } from "./message-v2"
import type { Provider } from "@/provider/provider"

// ─────────────────────────────────────────────────────────────────────
// Test seam state — capture per-test to avoid pollution from
// other test files sharing the module graph.
// ─────────────────────────────────────────────────────────────────────

let originalSessionMessages: typeof Session.messages
let originalSessionUpdatePart: typeof Session.updatePart
let originalTweaksSync: typeof Tweaks.compactionSync
let originalPluginTrigger: typeof Plugin.trigger

beforeEach(() => {
  originalSessionMessages = Session.messages
  originalSessionUpdatePart = Session.updatePart
  originalTweaksSync = Tweaks.compactionSync
  originalPluginTrigger = Plugin.trigger
})

afterEach(() => {
  ;(Session as any).messages = originalSessionMessages
  ;(Session as any).updatePart = originalSessionUpdatePart
  ;(Tweaks as any).compactionSync = originalTweaksSync
  ;(Plugin as any).trigger = originalPluginTrigger
})

function stubTweaks(overrides: Record<string, unknown> = {}) {
  ;(Tweaks as any).compactionSync = mock(() => ({
    ...originalTweaksSync(),
    ...overrides,
  }))
}

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

function anchor(id: string, body: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "assistant",
      parentID: "p",
      modelID: "gpt-5.5",
      providerId: "codex",
      mode: "primary",
      agent: "default",
      path: { cwd: ".", root: "." },
      summary: true,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      time: { created: 0, completed: 1 },
      accountId: "acc-A",
    } as MessageV2.Assistant,
    parts: [
      {
        id: `prt_${id}_body`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text: body,
        time: { start: 0, end: 1 },
      } as MessageV2.TextPart,
    ],
  }
}

function userMsg(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "default",
      model: { providerId: "codex", modelID: "gpt-5.5", accountId: "acc-A" },
    } as MessageV2.User,
    parts: [
      {
        id: `prt_${id}`,
        messageID: id,
        sessionID: "ses_test",
        type: "text",
        text,
        time: { start: 1, end: 2 },
      } as MessageV2.TextPart,
    ],
  }
}

function fakeCodexModel(): Provider.Model {
  return {
    id: "gpt-5.5",
    providerId: "codex",
    limit: { context: 272_000, input: 272_000, output: 32_000 },
    cost: { input: 1 },
  } as any
}

// ─────────────────────────────────────────────────────────────────────
// runCodexServerSideRecompress
// ─────────────────────────────────────────────────────────────────────

describe("runCodexServerSideRecompress", () => {
  it("calls plugin with actual conversation items from session messages and updates anchor on success", async () => {
    const anchorMsg = anchor(
      "msg_anchor",
      "## Round 1\n\n**User**\n\nlong dialog\n\n**Assistant**\n\nlong answer ".repeat(100),
    )
    // dialog-replay-redaction DD-8: the server-compacted result is stored on the
    // anchor's compaction part metadata, so the fixture needs that part present.
    anchorMsg.parts.push({
      id: `prt_${anchorMsg.info.id}_compaction`,
      messageID: anchorMsg.info.id,
      sessionID: "ses_test",
      type: "compaction",
      auto: false,
    } as any)
    const messagesPre = [userMsg("u_pre", "go"), anchorMsg]
    ;(Session as any).messages = mock(async () => messagesPre)

    let pluginCalledWith: any = null
    ;(Plugin as any).trigger = mock(async (event: string, ctx: any) => {
      pluginCalledWith = ctx
      return {
        compactedItems: [{ type: "message", role: "system", content: [{ type: "input_text", text: "..." }] }],
        summary: "Server-distilled summary",
      }
    })

    const updateCalls: any[] = []
    ;(Session as any).updatePart = mock(async (part: any) => {
      updateCalls.push(part)
    })

    await SessionCompaction.__test__.runCodexServerSideRecompress({
      sessionID: "ses_test",
      anchorMsg,
      anchorTokensBefore: 60_000,
      model: fakeCodexModel(),
      trigger: "size-ceiling",
      messagesPre,
    })

    // dialog-replay-redaction DD-4: the anchor body is sent to the plugin as a
    // single assistant message (not rebuilt from the session message stream),
    // so the first conversation item is the assistant anchor, not a user msg.
    expect(pluginCalledWith).not.toBeNull()
    expect(pluginCalledWith.conversationItems.length).toBeGreaterThanOrEqual(1)
    expect(pluginCalledWith.conversationItems[0].role).toBe("assistant")

    // dialog-replay-redaction DD-8: server-compacted items + chainBinding are
    // stored on the anchor's COMPACTION part metadata; the narrative text body
    // is deliberately preserved (not overwritten) for human readability.
    expect(updateCalls).toHaveLength(1)
    const updated = updateCalls[0]
    expect(updated.type).toBe("compaction")
    expect(updated.metadata.serverCompactedItems.length).toBeGreaterThanOrEqual(1)
    expect(updated.metadata.chainBinding.accountId).toBe("acc-A")
  })

  it("plugin returning null compactedItems → emits provider-error, does not update anchor", async () => {
    const anchorMsg = anchor("msg_anchor", "anchor body")
    ;(Session as any).messages = mock(async () => [anchorMsg])
    ;(Plugin as any).trigger = mock(async () => ({ compactedItems: null, summary: null }))
    const updateCalls: any[] = []
    ;(Session as any).updatePart = mock(async (p: any) => updateCalls.push(p))

    await SessionCompaction.__test__.runCodexServerSideRecompress({
      sessionID: "ses_test",
      anchorMsg,
      anchorTokensBefore: 50_000,
      model: fakeCodexModel(),
      trigger: "size-ceiling",
      messagesPre: [anchorMsg],
    })
    expect(updateCalls).toHaveLength(0)
  })

  it("plugin throws → emits provider-error, does not update anchor", async () => {
    const anchorMsg = anchor("msg_anchor", "anchor body")
    ;(Session as any).messages = mock(async () => [anchorMsg])
    ;(Plugin as any).trigger = mock(async () => {
      throw new Error("HTTP 429")
    })
    const updateCalls: any[] = []
    ;(Session as any).updatePart = mock(async (p: any) => updateCalls.push(p))

    await SessionCompaction.__test__.runCodexServerSideRecompress({
      sessionID: "ses_test",
      anchorMsg,
      anchorTokensBefore: 50_000,
      model: fakeCodexModel(),
      trigger: "size-ceiling",
      messagesPre: [anchorMsg],
    })
    expect(updateCalls).toHaveLength(0)
  })

  it("interloper anchor written before recompress completes → stale-anchor-skipped, no update", async () => {
    const oldAnchor = anchor("msg_anchor_OLD", "old body")
    const newAnchor = anchor("msg_anchor_NEW", "new body")
    // runCodexServerSideRecompress reads Session.messages once (post-plugin
    // staleness check). Return the interloper-state directly so the freshly-
    // read latest anchor is newAnchor, not the dispatched oldAnchor.
    ;(Session as any).messages = mock(async () => [oldAnchor, newAnchor])
    ;(Plugin as any).trigger = mock(async () => ({
      compactedItems: [{}],
      summary: "Should not be applied",
    }))
    const updateCalls: any[] = []
    ;(Session as any).updatePart = mock(async (p: any) => updateCalls.push(p))

    await SessionCompaction.__test__.runCodexServerSideRecompress({
      sessionID: "ses_test",
      anchorMsg: oldAnchor,
      anchorTokensBefore: 60_000,
      model: fakeCodexModel(),
      trigger: "size-ceiling",
      messagesPre: [oldAnchor],
    })

    expect(updateCalls).toHaveLength(0) // staleness aborted in-place update
  })

  it("anchor body empty → emits exception, skips plugin call", async () => {
    const emptyAnchor: MessageV2.WithParts = {
      info: anchor("msg_a", "x").info,
      parts: [],
    }
    let pluginCalled = false
    ;(Plugin as any).trigger = mock(async () => {
      pluginCalled = true
      return { compactedItems: [{}], summary: "x" }
    })
    const updateCalls: any[] = []
    ;(Session as any).updatePart = mock(async (p: any) => updateCalls.push(p))

    await SessionCompaction.__test__.runCodexServerSideRecompress({
      sessionID: "ses_test",
      anchorMsg: emptyAnchor,
      anchorTokensBefore: 0,
      model: fakeCodexModel(),
      trigger: "size-ceiling",
      messagesPre: [emptyAnchor],
    })

    expect(pluginCalled).toBe(false)
    expect(updateCalls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// scheduleHybridEnrichment dispatch (M4 routing logic)
// ─────────────────────────────────────────────────────────────────────

describe("scheduleHybridEnrichment dispatch", () => {
  it("flag on + codex provider + anchor > floor → codex server-side dispatch is dormant (ai_paid sole path, DD-11)", async () => {
    const big = "x".repeat(150_000 * 4) // ~150K tokens, above the 128K absolute floor (DD-8)
    const anchorMsg = anchor("msg_anchor", big)
    // Include non-anchor messages so buildConversationItemsForPlugin has items to send
    const uMsg = userMsg("u_pre", "do the thing")
    ;(Session as any).messages = mock(async () => [uMsg, anchorMsg])
    stubTweaks({
      enableHybridLlm: true,
      enableDialogRedactionAnchor: true,
      anchorRecompressCeilingTokens: 50_000,
    })

    let pluginCalled = false
    ;(Plugin as any).trigger = mock(async () => {
      pluginCalled = true
      return { compactedItems: null, summary: null } // fail fast — only checking dispatch
    })

    SessionCompaction.__test__.scheduleHybridEnrichment(
      "ses_test",
      "rebind", // observed value previously gated out — flag-on bypasses
      fakeCodexModel(),
    )

    // Wait for the background promise to settle
    await new Promise((r) => setTimeout(r, 50))

    // The codex server-side `/responses/compact` dispatch is dormant
    // (encrypted-blob anchor is incompatible with rotation-heavy sessions);
    // enrichment goes straight to ai_paid (runHybridLlm) — the Plugin path
    // is NOT invoked even with flag on + a gate-passing anchor.
    expect(pluginCalled).toBe(false)
  })

  it("flag off + observed=rebind → does NOT dispatch (legacy observed-gate)", async () => {
    const big = "x".repeat(120_000 * 4)
    const anchorMsg = anchor("msg_anchor", big)
    ;(Session as any).messages = mock(async () => [anchorMsg])
    stubTweaks({ enableHybridLlm: true, enableDialogRedactionAnchor: false })

    let pluginCalled = false
    ;(Plugin as any).trigger = mock(async () => {
      pluginCalled = true
      return { compactedItems: null, summary: null }
    })

    SessionCompaction.__test__.scheduleHybridEnrichment("ses_test", "rebind", fakeCodexModel())
    await new Promise((r) => setTimeout(r, 50))

    expect(pluginCalled).toBe(false)
  })

  it("anchor below the 128K absolute floor → no dispatch (DD-8)", async () => {
    // compaction_enrichment-ai-first DD-3/DD-8: the ratio gate is retired;
    // the trigger is the absolute aCompactTokens floor (128K unified).
    // 4K tokens is far below it, so the skip behaviour is preserved.
    const small = "x".repeat(4_000 * 4) // ~4K tokens, well below 128K floor
    const anchorMsg = anchor("msg_anchor", small)
    ;(Session as any).messages = mock(async () => [anchorMsg])
    stubTweaks({ enableHybridLlm: true, enableDialogRedactionAnchor: true })

    let pluginCalled = false
    ;(Plugin as any).trigger = mock(async () => {
      pluginCalled = true
      return { compactedItems: null, summary: null }
    })

    SessionCompaction.__test__.scheduleHybridEnrichment("ses_test", "manual", fakeCodexModel())
    await new Promise((r) => setTimeout(r, 50))

    expect(pluginCalled).toBe(false)
  })

  it("flag on + observed=manual + anchor above 128K floor → ai_paid sole path (codex dispatch dormant, DD-11)", async () => {
    // compaction_enrichment-ai-first DD-8: gate is the 128K absolute floor.
    // 150K tokens passes it, so enrichment proceeds — straight to ai_paid
    // (runHybridLlm), NOT the dormant codex server-side dispatch and NOT any
    // positional drop (removed per DD-11).
    const mid = "x".repeat(150_000 * 4) // ~150K tokens, above the 128K floor
    const anchorMsg = anchor("msg_anchor", mid)
    const uMsg = userMsg("u_pre", "do the thing")
    ;(Session as any).messages = mock(async () => [uMsg, anchorMsg])
    stubTweaks({ enableHybridLlm: true, enableDialogRedactionAnchor: true })

    let pluginCalled = false
    ;(Plugin as any).trigger = mock(async () => {
      pluginCalled = true
      return { compactedItems: null, summary: null }
    })
    SessionCompaction.__test__.scheduleHybridEnrichment("ses_test", "manual", fakeCodexModel())
    await new Promise((r) => setTimeout(r, 50))
    // codex server-side dispatch is dormant — enrichment goes to ai_paid,
    // so the plugin is not invoked.
    expect(pluginCalled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// ai_paid sole path — success upgrades anchor, failure leaves it alone
// (compaction_enrichment-ai-first task 4.1, DD-4/DD-11)
// ─────────────────────────────────────────────────────────────────────

describe("scheduleHybridEnrichment ai_paid outcomes", () => {
  const Hybrid = SessionCompaction.Hybrid as any

  let originalRunHybridLlm: any
  let originalUpdateMessage: typeof Session.updateMessage
  let originalAppendRecentEvent: typeof Session.appendRecentEvent

  beforeEach(() => {
    originalRunHybridLlm = Hybrid.runHybridLlm
    originalUpdateMessage = Session.updateMessage
    originalAppendRecentEvent = Session.appendRecentEvent
  })

  afterEach(() => {
    Hybrid.runHybridLlm = originalRunHybridLlm
    ;(Session as any).updateMessage = originalUpdateMessage
    ;(Session as any).appendRecentEvent = originalAppendRecentEvent
  })

  function successEvent(): any {
    return {
      eventId: "cev_test",
      sessionId: "ses_test",
      kind: "hybrid_llm",
      phase: 1,
      internalMode: "llm",
      inputTokens: 150_000,
      outputTokens: 5_000,
      latencyMs: 10,
      result: "success",
      emittedAt: new Date().toISOString(),
    }
  }

  function failureEvent(): any {
    return { ...successEvent(), result: "unrecoverable", errorCode: "E_HYBRID_LLM_FAILED" }
  }

  it("ai_paid success → narrative anchor upgraded in place, stub demoted", async () => {
    const big = "x".repeat(150_000 * 4) // above the 128K floor (DD-8)
    const narrative = anchor("msg_anchor", big)
    const uMsg = userMsg("u_pre", "do the thing")
    const stub = anchor("msg_stub", "ESSENCE: decisions + constraints survive")

    // Pre-LLM the stub does not exist; post-LLM it appears after the narrative.
    let llmRan = false
    ;(Session as any).messages = mock(async () => (llmRan ? [uMsg, narrative, stub] : [uMsg, narrative]))
    Hybrid.runHybridLlm = mock(async () => {
      llmRan = true
      return successEvent()
    })

    const updatedParts: any[] = []
    const updatedMessages: any[] = []
    ;(Session as any).updatePart = mock(async (p: any) => updatedParts.push(p))
    ;(Session as any).updateMessage = mock(async (m: any) => updatedMessages.push(m))
    ;(Session as any).appendRecentEvent = mock(async () => {})
    stubTweaks({ enableHybridLlm: true, enableDialogRedactionAnchor: true })

    SessionCompaction.__test__.scheduleHybridEnrichment("ses_test", "manual", fakeCodexModel())
    await new Promise((r) => setTimeout(r, 100))

    expect(llmRan).toBe(true)
    // Narrative anchor's text part updated with the stub's essence body
    expect(updatedParts.length).toBe(1)
    expect(updatedParts[0].messageID).toBe("msg_anchor")
    expect(updatedParts[0].text).toContain("ESSENCE")
    // Stub anchor demoted (summary:false)
    expect(updatedMessages.some((m) => m.id === "msg_stub" && m.summary === false)).toBe(true)
  })

  it("ai_paid failure → anchor untouched + failed event carries ai_paid_failed (DD-4/DD-11, no fallback)", async () => {
    const big = "x".repeat(150_000 * 4)
    const narrative = anchor("msg_anchor", big)
    const uMsg = userMsg("u_pre", "do the thing")
    ;(Session as any).messages = mock(async () => [uMsg, narrative])
    Hybrid.runHybridLlm = mock(async () => failureEvent())

    const updatedParts: any[] = []
    const recentEvents: any[] = []
    ;(Session as any).updatePart = mock(async (p: any) => updatedParts.push(p))
    ;(Session as any).updateMessage = mock(async () => {})
    ;(Session as any).appendRecentEvent = mock(async (_sid: string, ev: any) => recentEvents.push(ev))
    stubTweaks({ enableHybridLlm: true, enableDialogRedactionAnchor: true })

    SessionCompaction.__test__.scheduleHybridEnrichment("ses_test", "manual", fakeCodexModel())
    await new Promise((r) => setTimeout(r, 100))

    // Anchor stays untouched — NO positional drop, NO fallback (DD-11)
    expect(updatedParts.length).toBe(0)
    // Explicit failed event with ai_paid_failed reason classification (DD-4)
    const failed = recentEvents.find((e) => e.kind === "enrichment" && e.enrichment?.status === "failed")
    expect(failed).toBeTruthy()
    expect(failed.enrichment.detail).toContain("ai_paid_failed")
    expect(failed.enrichment.detail).toContain("E_HYBRID_LLM_FAILED")
  })
})

// ─────────────────────────────────────────────────────────────────────
// ai-paid-event-consistency (issue 20260612_session_resume_ai_paid_
// compaction_timeout): runLlmCompact's finally publish must carry the
// REAL outcome (DD-1) so a failed ai_paid attempt is never recorded as
// compaction success:true next to an enrichment failed event. The
// `success !== false` default in publishCompactedAndResetChain stays
// for local kinds (DD-2).
// ─────────────────────────────────────────────────────────────────────

describe("ai-paid event consistency (DD-1/DD-2)", () => {
  let originalAppendRecentEvent: typeof Session.appendRecentEvent
  let originalSetActiveImageRefs: typeof Session.setActiveImageRefs

  beforeEach(() => {
    originalAppendRecentEvent = Session.appendRecentEvent
    originalSetActiveImageRefs = Session.setActiveImageRefs
  })

  afterEach(() => {
    ;(Session as any).appendRecentEvent = originalAppendRecentEvent
    ;(Session as any).setActiveImageRefs = originalSetActiveImageRefs
    // Restore the production publish executor replaced by setPublishExecutor.
    SessionCompaction.__test__.wireCompactionManager()
  })

  it("runLlmCompact failure → finally publish carries success:false (DD-1, no contradictory pair)", async () => {
    const captured: Array<{ sessionID: string; meta: any }> = []
    CompactionManager.setPublishExecutor((sessionID, meta) => captured.push({ sessionID, meta }))
    // Empty stream → runLlmCompactInner returns {ok:false, reason:"no_response"}
    ;(Session as any).messages = mock(async () => [])

    const result = await (SessionCompaction.Hybrid as any).runLlmCompact(
      "ses_test",
      {
        priorAnchor: null,
        journalUnpinned: [],
        framing: { mode: "phase1", strict: false },
        targetTokens: 1_000,
      },
      { abort: new AbortController().signal, observed: "cache-aware" },
    )

    expect(result.ok).toBe(false)
    expect(captured.length).toBe(1)
    expect(captured[0].meta).toMatchObject({ kind: "ai_paid", success: false, observed: "cache-aware" })
  })

  it("publishCompactedAndResetChain: explicit success honored, local-kind default stays true (DD-2)", async () => {
    const recentEvents: any[] = []
    ;(Session as any).appendRecentEvent = mock(async (_sid: string, ev: any) => recentEvents.push(ev))
    ;(Session as any).setActiveImageRefs = mock(async () => {})

    // Failed ai_paid attempt — meta now carries success:false (DD-1 caller)
    await SessionCompaction.publishCompactedAndResetChain("ses_test", {
      observed: "cache-aware",
      kind: "ai_paid",
      success: false,
    })
    // Successful ai_paid attempt
    await SessionCompaction.publishCompactedAndResetChain("ses_test", {
      observed: "cache-aware",
      kind: "ai_paid",
      success: true,
    })
    // Local kind without explicit success — default true preserved (DD-2)
    await SessionCompaction.publishCompactedAndResetChain("ses_test", {
      observed: "overflow",
      kind: "narrative",
    })

    const compactions = recentEvents.filter((e) => e.kind === "compaction")
    expect(compactions.length).toBe(3)
    expect(compactions[0].compaction).toMatchObject({ kind: "ai_paid", success: false })
    expect(compactions[1].compaction).toMatchObject({ kind: "ai_paid", success: true })
    expect(compactions[2].compaction).toMatchObject({ kind: "narrative", success: true })
  })
})
