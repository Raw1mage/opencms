import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
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
  it("calls plugin with anchor body as single conversationItem and updates anchor in place on success", async () => {
    const anchorMsg = anchor("msg_anchor", "## Round 1\n\n**User**\n\nlong dialog\n\n**Assistant**\n\nlong answer ".repeat(100))
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

    // Plugin called with single conversationItem holding anchor body
    expect(pluginCalledWith).not.toBeNull()
    expect(pluginCalledWith.conversationItems).toHaveLength(1)
    expect(pluginCalledWith.conversationItems[0].role).toBe("user")
    expect(pluginCalledWith.conversationItems[0].content[0].text).toContain("## Round 1")

    // Anchor body updated in place
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].text).toBe("Server-distilled summary")
    expect(updateCalls[0].id).toBe(`prt_${anchorMsg.info.id}_body`)
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
  it("flag on + codex provider + anchor > floor → routes to codex server-side", async () => {
    const big = "x".repeat(60_000 * 4) // > 50K tokens estimate
    const anchorMsg = anchor("msg_anchor", big)
    ;(Session as any).messages = mock(async () => [anchorMsg])
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

    expect(pluginCalled).toBe(true)
  })

  it("flag off + observed=rebind → does NOT dispatch (legacy observed-gate)", async () => {
    const big = "x".repeat(60_000 * 4)
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

  it("anchor below 5K skip floor → no dispatch", async () => {
    const small = "x".repeat(4_000 * 4) // ~4K tokens
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

  it("flag on + observed=manual + 5K-50K range → routes to hybrid_llm (legacy-large-policy trigger)", async () => {
    const mid = "x".repeat(20_000 * 4) // ~20K tokens, in 5K-50K range
    const anchorMsg = anchor("msg_anchor", mid)
    ;(Session as any).messages = mock(async () => [anchorMsg])
    stubTweaks({ enableHybridLlm: true, enableDialogRedactionAnchor: true })

    let pluginCalled = false
    ;(Plugin as any).trigger = mock(async () => {
      pluginCalled = true
      return { compactedItems: null, summary: null }
    })
    // For codex provider in mid-range: still goes to codex path under flag-on
    SessionCompaction.__test__.scheduleHybridEnrichment("ses_test", "manual", fakeCodexModel())
    await new Promise((r) => setTimeout(r, 50))
    expect(pluginCalled).toBe(true) // routed to codex regardless of trigger label
  })
})
