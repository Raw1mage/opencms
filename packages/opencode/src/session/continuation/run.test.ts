import { afterEach, describe, expect, it } from "bun:test"
import { Continuation } from "./run"
import { PendingInjectionStore } from "./pending-injection"

afterEach(() => {
  PendingInjectionStore.reset()
})

describe("Continuation.run — dispatch + pending-injection orchestration", () => {
  it("SS account_switch → writes pending injection with chainInit=true", async () => {
    const out = await Continuation.run({
      kind: "account_switch",
      sessionID: "ses_run_1",
      previousAccountId: "A1",
      accountId: "A2",
      providerId: "codex",
    })
    expect(out.decision.breaksChain).toBe(true)
    expect(out.decision.injectsChainInit).toBe(true)
    expect(out.pendingMarkWritten).toBe(true)
    const mark = PendingInjectionStore.peek("ses_run_1")
    expect(mark).not.toBeNull()
    expect(mark!.chainInit).toBe(true)
    expect(mark!.amnesia).toBe(false)
    expect(mark!.reason).toBe("account_switch")
  })

  it("SL account_switch → NO pending injection", async () => {
    const out = await Continuation.run({
      kind: "account_switch",
      sessionID: "ses_run_2",
      previousAccountId: "B1",
      accountId: "B2",
      providerId: "claude-cli",
    })
    expect(out.decision.breaksChain).toBe(false)
    expect(out.decision.injectsChainInit).toBe(false)
    expect(out.pendingMarkWritten).toBe(false)
    expect(PendingInjectionStore.peek("ses_run_2")).toBeNull()
  })

  it("compaction on SS provider → writes amnesia-only pending injection", async () => {
    const out = await Continuation.run({
      kind: "compaction_cache_aware",
      sessionID: "ses_run_3",
      anchorId: "anchor_x",
      providerId: "codex",
    })
    expect(out.decision.injectsAmnesia).toBe(true)
    expect(out.decision.injectsChainInit).toBe(false)
    expect(out.pendingMarkWritten).toBe(true)
    const mark = PendingInjectionStore.peek("ses_run_3")
    expect(mark!.amnesia).toBe(true)
    expect(mark!.chainInit).toBe(false)
    expect(mark!.anchorId).toBe("anchor_x")
  })

  it("compaction on SL provider → writes amnesia-only pending injection (still client-side summary)", async () => {
    const out = await Continuation.run({
      kind: "compaction_narrative",
      sessionID: "ses_run_4",
      anchorId: "anchor_x",
      providerId: "claude-cli",
    })
    expect(out.decision.injectsAmnesia).toBe(true)
    expect(out.decision.injectsChainInit).toBe(false)
    expect(out.decision.breaksChain).toBe(false)
    expect(out.pendingMarkWritten).toBe(true)
  })

  it("subagent_spawn → NO pending injection (DD-9: no prior chain to mourn)", async () => {
    const out = await Continuation.run({
      kind: "subagent_spawn",
      sessionID: "ses_run_5_child",
      parentSessionID: "ses_run_5_parent",
      providerId: "codex",
    })
    expect(out.pendingMarkWritten).toBe(false)
    expect(out.decision.bumpsRebindEpoch).toBe(false)
    expect(PendingInjectionStore.peek("ses_run_5_child")).toBeNull()
  })

  it("user_clear → chain breaks but NO pending injection (DD-9: user-aware reset)", async () => {
    const out = await Continuation.run({
      kind: "user_clear",
      sessionID: "ses_run_6",
      providerId: "codex",
    })
    expect(out.decision.breaksChain).toBe(true)
    expect(out.decision.injectsChainInit).toBe(false)
    expect(out.pendingMarkWritten).toBe(false)
    expect(out.decision.chainBreakClass).toBe("user-intent")
  })

  it("ws_reconnect → completely silent path", async () => {
    const out = await Continuation.run({
      kind: "ws_reconnect",
      sessionID: "ses_run_7",
      providerId: "codex",
    })
    expect(out.decision.breaksChain).toBe(false)
    expect(out.pendingMarkWritten).toBe(false)
    expect(out.decision.bumpsRebindEpoch).toBe(false)
  })

  it("capability_layer_refresh → no chain break, no pending, but epoch bumps (DD-12)", async () => {
    const out = await Continuation.run({
      kind: "capability_layer_refresh",
      sessionID: "ses_run_8",
      reason: "AGENTS.md updated",
      providerId: "codex",
    })
    expect(out.decision.breaksChain).toBe(false)
    expect(out.pendingMarkWritten).toBe(false)
    expect(out.decision.bumpsRebindEpoch).toBe(true)
  })

  it("empty_response_recovery on SS → chain breaks + pending init (DD-10)", async () => {
    const out = await Continuation.run({
      kind: "empty_response_recovery",
      sessionID: "ses_run_9",
      emptyRoundCount: 1,
      providerId: "codex",
    })
    expect(out.decision.breaksChain).toBe(true)
    expect(out.decision.injectsChainInit).toBe(true)
    expect(out.pendingMarkWritten).toBe(true)
    const mark = PendingInjectionStore.peek("ses_run_9")
    expect(mark!.reason).toBe("empty_response_recovery")
  })

  it("backend_failure_forced_resend on SS → init notice (DD-5)", async () => {
    const out = await Continuation.run({
      kind: "backend_failure_forced_resend",
      sessionID: "ses_run_10",
      classifier: "ws_truncation",
      providerId: "codex",
    })
    expect(out.decision.breaksChain).toBe(true)
    expect(out.decision.injectsChainInit).toBe(true)
    expect(out.pendingMarkWritten).toBe(true)
  })

  it("returns ContinuationOutcome with all 5 fields populated", async () => {
    const out = await Continuation.run({
      kind: "account_switch",
      sessionID: "ses_run_11",
      previousAccountId: "A1",
      accountId: "A2",
      providerId: "claude-cli",
    })
    expect(out).toHaveProperty("decision")
    expect(out).toHaveProperty("digest")
    expect(out).toHaveProperty("chainInvalidated")
    expect(out).toHaveProperty("epochBumped")
    expect(out).toHaveProperty("pendingMarkWritten")
  })

  it("multiple events on same session — second mark overwrites first", async () => {
    await Continuation.run({
      kind: "account_switch",
      sessionID: "ses_run_12",
      previousAccountId: "A1",
      accountId: "A2",
      providerId: "codex",
    })
    expect(PendingInjectionStore.peek("ses_run_12")!.reason).toBe("account_switch")
    await Continuation.run({
      kind: "empty_response_recovery",
      sessionID: "ses_run_12",
      emptyRoundCount: 1,
      providerId: "codex",
    })
    expect(PendingInjectionStore.peek("ses_run_12")!.reason).toBe("empty_response_recovery")
  })
})
