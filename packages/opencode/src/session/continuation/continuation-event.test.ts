import { describe, expect, it } from "bun:test"
import { classify, ContinuationEventSchema, type ContinuationEvent } from "./continuation-event"

const S = "ses_test_1"

describe("continuation-event / classify", () => {
  // ----- SS provider path (codex) -----

  describe("SS provider (codex)", () => {
    it("account_switch → breaks + digest + init + epoch", () => {
      const d = classify({
        kind: "account_switch",
        sessionID: S,
        previousAccountId: "A1",
        accountId: "A2",
        providerId: "codex",
      })
      expect(d).toMatchObject({
        breaksChain: true,
        capturesDigest: true,
        injectsChainInit: true,
        injectsAmnesia: false,
        bumpsRebindEpoch: true,
        chainBreakClass: "SS-break",
      })
    })

    it("account_rotate → same shape as account_switch", () => {
      const d = classify({
        kind: "account_rotate",
        sessionID: S,
        previousAccountId: "A1",
        accountId: "A2",
        providerId: "codex",
        trigger: "quota",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(true)
      expect(d.chainBreakClass).toBe("SS-break")
    })

    it("provider_switch → breaks + init", () => {
      const d = classify({
        kind: "provider_switch",
        sessionID: S,
        previousProviderId: "claude-cli",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(true)
    })

    it("model_switch_same_family → DD-4 conservative break", () => {
      const d = classify({
        kind: "model_switch_same_family",
        sessionID: S,
        previousModelId: "gpt-5.5",
        modelId: "gpt-5.4",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(true)
    })

    it("model_switch_cross_family → always break", () => {
      const d = classify({
        kind: "model_switch_cross_family",
        sessionID: S,
        previousModelId: "gpt-5",
        modelId: "o4-mini-high",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(true)
    })

    it("session_fork → no break, no init (no prior chain)", () => {
      const d = classify({
        kind: "session_fork",
        sessionID: S,
        parentSessionID: "ses_parent",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
      expect(d.skipReason).toBe("no_prior_chain")
      expect(d.chainBreakClass).toBe("preserved")
    })

    it("session_resume_daemon_alive → no break, capability-only epoch", () => {
      const d = classify({
        kind: "session_resume_daemon_alive",
        sessionID: S,
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.bumpsRebindEpoch).toBe(true)
      expect(d.chainBreakClass).toBe("capability-only")
      expect(d.skipReason).toBe("capability_only")
    })

    it("session_resume_after_daemon_restart → breaks + init", () => {
      const d = classify({
        kind: "session_resume_after_daemon_restart",
        sessionID: S,
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(true)
      expect(d.chainBreakClass).toBe("SS-break")
    })

    it("capability_layer_refresh → no break, epoch only (DD-12)", () => {
      const d = classify({
        kind: "capability_layer_refresh",
        sessionID: S,
        reason: "AGENTS.md updated",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
      expect(d.bumpsRebindEpoch).toBe(true)
      expect(d.skipReason).toBe("capability_only")
    })

    it("compaction_narrative → breaks + amnesia (not init)", () => {
      const d = classify({
        kind: "compaction_narrative",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsAmnesia).toBe(true)
      expect(d.injectsChainInit).toBe(false)
    })

    it("compaction_cache_aware → breaks + amnesia", () => {
      const d = classify({
        kind: "compaction_cache_aware",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "codex",
      })
      expect(d.injectsAmnesia).toBe(true)
      expect(d.injectsChainInit).toBe(false)
    })

    it("compaction_stall_recovery → breaks + amnesia", () => {
      const d = classify({
        kind: "compaction_stall_recovery",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "codex",
      })
      expect(d.injectsAmnesia).toBe(true)
    })

    it("compaction_preemptive_daemon_restart → breaks + amnesia", () => {
      const d = classify({
        kind: "compaction_preemptive_daemon_restart",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "codex",
      })
      expect(d.injectsAmnesia).toBe(true)
    })

    it("compaction_server_side → chain preserved (skip notice)", () => {
      const d = classify({
        kind: "compaction_server_side",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsAmnesia).toBe(false)
      expect(d.injectsChainInit).toBe(false)
      expect(d.skipReason).toBe("server_side_compaction")
    })

    it("empty_response_recovery → breaks + init (DD-10)", () => {
      const d = classify({
        kind: "empty_response_recovery",
        sessionID: S,
        emptyRoundCount: 1,
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(true)
    })

    it("ws_reconnect → no-op", () => {
      const d = classify({ kind: "ws_reconnect", sessionID: S, providerId: "codex" })
      expect(d.breaksChain).toBe(false)
      expect(d.bumpsRebindEpoch).toBe(false)
      expect(d.skipReason).toBe("ws_reconnect")
    })

    it("subagent_spawn → no-op, skipReason=subagent_spawn", () => {
      const d = classify({
        kind: "subagent_spawn",
        sessionID: S,
        parentSessionID: "ses_parent",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
      expect(d.skipReason).toBe("subagent_spawn")
    })

    it("user_clear → breaks chain BUT suppresses notice (DD-9)", () => {
      const d = classify({ kind: "user_clear", sessionID: S, providerId: "codex" })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(false)
      expect(d.skipReason).toBe("user_clear")
      expect(d.chainBreakClass).toBe("user-intent")
    })

    it("backend_failure_forced_resend → breaks + init (DD-5)", () => {
      const d = classify({
        kind: "backend_failure_forced_resend",
        sessionID: S,
        classifier: "ws_truncation",
        providerId: "codex",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.injectsChainInit).toBe(true)
    })
  })

  // ----- SL provider path (anthropic / claude-cli) -----

  describe("SL provider (claude-cli)", () => {
    it("account_switch → no break, no chain-init, but epoch bumps", () => {
      const d = classify({
        kind: "account_switch",
        sessionID: S,
        previousAccountId: "B1",
        accountId: "B2",
        providerId: "claude-cli",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
      expect(d.bumpsRebindEpoch).toBe(true)
      expect(d.chainBreakClass).toBe("SL-noop")
      expect(d.skipReason).toBe("sl_provider")
    })

    it("account_rotate → SL-noop", () => {
      const d = classify({
        kind: "account_rotate",
        sessionID: S,
        previousAccountId: "B1",
        accountId: "B2",
        providerId: "claude-cli",
        trigger: "429",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
    })

    it("compaction_cache_aware → amnesia still fires (client-side messages summarised)", () => {
      const d = classify({
        kind: "compaction_cache_aware",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "claude-cli",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
      expect(d.injectsAmnesia).toBe(true) // amnesia still fires on SL
      expect(d.capturesDigest).toBe(true)
    })

    it("compaction_narrative → amnesia, no chain init", () => {
      const d = classify({
        kind: "compaction_narrative",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "claude-cli",
      })
      expect(d.injectsAmnesia).toBe(true)
      expect(d.injectsChainInit).toBe(false)
    })

    it("provider_switch out of codex into claude-cli → SL-noop on dispatch", () => {
      const d = classify({
        kind: "provider_switch",
        sessionID: S,
        previousProviderId: "codex",
        providerId: "claude-cli",
      })
      // Provider class is resolved against the NEW providerId (where the
      // chain would live going forward). Since claude-cli is SL, no chain
      // break, no init.
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
    })

    it("backend_failure_forced_resend on SL → still SL-noop", () => {
      const d = classify({
        kind: "backend_failure_forced_resend",
        sessionID: S,
        classifier: "server_failed",
        providerId: "claude-cli",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
    })

    it("empty_response_recovery on SL → SL-noop", () => {
      const d = classify({
        kind: "empty_response_recovery",
        sessionID: S,
        emptyRoundCount: 1,
        providerId: "claude-cli",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.injectsChainInit).toBe(false)
    })
  })

  // ----- SS provider variants: github-copilot, openai -----

  describe("SS provider variants", () => {
    it("github-copilot account_switch → SS-break (DD-6)", () => {
      const d = classify({
        kind: "account_switch",
        sessionID: S,
        previousAccountId: "C1",
        accountId: "C2",
        providerId: "github-copilot",
      })
      expect(d.breaksChain).toBe(true)
      expect(d.chainBreakClass).toBe("SS-break")
    })

    it("openai account_switch → SS-break", () => {
      const d = classify({
        kind: "account_switch",
        sessionID: S,
        previousAccountId: "D1",
        accountId: "D2",
        providerId: "openai",
      })
      expect(d.breaksChain).toBe(true)
    })
  })

  // ----- Events without providerId -----

  describe("provider-id-less events", () => {
    it("ws_reconnect without providerId → no-op (resolves to SL by default)", () => {
      const d = classify({ kind: "ws_reconnect", sessionID: S })
      expect(d.breaksChain).toBe(false)
      expect(d.bumpsRebindEpoch).toBe(false)
    })

    it("capability_layer_refresh without providerId → epoch only", () => {
      const d = classify({
        kind: "capability_layer_refresh",
        sessionID: S,
        reason: "test",
      })
      expect(d.breaksChain).toBe(false)
      expect(d.bumpsRebindEpoch).toBe(true)
    })

    it("session_fork without providerId → no-op skip path", () => {
      const d = classify({
        kind: "session_fork",
        sessionID: S,
        parentSessionID: "p",
      })
      expect(d.skipReason).toBe("no_prior_chain")
    })

    it("subagent_spawn without providerId → suppressed", () => {
      const d = classify({
        kind: "subagent_spawn",
        sessionID: S,
        parentSessionID: "p",
      })
      expect(d.bumpsRebindEpoch).toBe(false)
      expect(d.skipReason).toBe("subagent_spawn")
    })
  })

  // ----- Schema validation -----

  describe("ContinuationEventSchema", () => {
    it("accepts a valid account_switch event", () => {
      const evt: ContinuationEvent = {
        kind: "account_switch",
        sessionID: S,
        previousAccountId: "A1",
        accountId: "A2",
        providerId: "codex",
      }
      expect(ContinuationEventSchema.safeParse(evt).success).toBe(true)
    })

    it("rejects an unknown event kind", () => {
      expect(ContinuationEventSchema.safeParse({ kind: "made_up_kind", sessionID: S }).success).toBe(false)
    })

    it("rejects malformed account_switch missing previousAccountId", () => {
      expect(
        ContinuationEventSchema.safeParse({
          kind: "account_switch",
          sessionID: S,
          accountId: "A2",
          providerId: "codex",
        }).success,
      ).toBe(false)
    })

    it("rejects backend_failure_forced_resend with unknown classifier", () => {
      expect(
        ContinuationEventSchema.safeParse({
          kind: "backend_failure_forced_resend",
          sessionID: S,
          providerId: "codex",
          classifier: "made_up",
        }).success,
      ).toBe(false)
    })
  })
})
