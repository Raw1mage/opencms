import { describe, it, expect, beforeEach, afterAll } from "bun:test"
import { CompactionManager } from "./compaction-manager"
import { SessionCompaction } from "./compaction"

// These tests inject mock executors into the CompactionManager singleton. Restore
// the production wiring afterwards so we don't leak undefined/mock executors into
// other test files sharing this process.
afterAll(() => {
  CompactionManager.__test__.reset()
  SessionCompaction.__test__.wireCompactionManager()
})

// compaction/central-manager S1 — the structural fix for the verified
// double-trim amnesia (event_2026-06-10_rca-re-verified-with-hard-data-…).
// Enrichment now funnels through one intake, deduped per anchor id.
describe("CompactionManager — enrichment dedup (S1)", () => {
  beforeEach(() => {
    CompactionManager.__test__.reset()
  })

  it("TV-1: two enrich requests for the SAME anchor → executor runs exactly once", () => {
    const calls: Array<{ sid: string; origin: string }> = []
    CompactionManager.setEnrichExecutor((sid) => calls.push({ sid, origin: "" }))

    // The two legacy call sites (writeAnchorFromBody:795 + run():2678) firing
    // for the same just-written anchor — the exact double-schedule that
    // double-trimmed 23,706 → 6,102 → 2,441 tokens before the manager existed.
    CompactionManager.requestEnrich({
      sessionID: "ses_a",
      anchorId: "anchor_1",
      observed: "cache-aware",
      model: undefined,
      origin: "writeAnchorFromBody",
    })
    CompactionManager.requestEnrich({
      sessionID: "ses_a",
      anchorId: "anchor_1",
      observed: "cache-aware",
      model: undefined,
      origin: "run-postchain",
    })

    expect(calls).toHaveLength(1)
  })

  it("a later compaction's NEW anchor still gets enriched (dedup is per anchor, not per session)", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((_sid, obs) => calls.push(obs))

    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "run-postchain" })
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "writeAnchorFromBody" }) // dup
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_2", observed: "overflow", model: undefined, origin: "run-postchain" }) // fresh anchor

    expect(calls).toHaveLength(2)
    expect(CompactionManager.__test__.peekLastEnriched("ses_a")).toBe("anchor_2")
  })

  it("different sessions do not collide on the same anchor id", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((sid) => calls.push(sid))
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    CompactionManager.requestEnrich({ sessionID: "ses_b", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    expect(calls).toHaveLength(2)
  })

  it("forget() clears per-session dedup state so a re-created session can re-enrich", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((sid) => calls.push(sid))
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    CompactionManager.forget("ses_a")
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "x" })
    expect(calls).toHaveLength(2)
  })
})

// DD-10: the central layer routes by provider class to a per-provider strategy.
describe("CompactionManager — provider routing (DD-10)", () => {
  it("classifies provider id into the 3-class taxonomy", () => {
    expect(CompactionManager.__test__.classifyProvider("claude-cli")).toBe("claude")
    expect(CompactionManager.__test__.classifyProvider("codex")).toBe("codex")
    expect(CompactionManager.__test__.classifyProvider("github-copilot")).toBe("general")
    expect(CompactionManager.__test__.classifyProvider(undefined)).toBe("general")
  })

  it("routes an enrich request through the strategy registry (reaches the executor)", () => {
    CompactionManager.__test__.reset()
    const seen: Array<string | undefined> = []
    CompactionManager.setEnrichExecutor((_sid, _obs, model) => seen.push(model?.providerId))
    CompactionManager.requestEnrich({
      sessionID: "ses_a",
      anchorId: "anchor_1",
      observed: "overflow",
      model: { providerId: "claude-cli" } as any,
      origin: "x",
    })
    expect(seen).toEqual(["claude-cli"])
  })
})

// S4: the observed-eligibility 7-set is one predicate at the manager (was split
// between run()'s 7-set and the unconditional writeAnchorFromBody site).
describe("CompactionManager — enrichment observed-eligibility (S4)", () => {
  beforeEach(() => CompactionManager.__test__.reset())

  it("eligible observeds enrich; idle / empty-response / reload do not", () => {
    expect(CompactionManager.isEnrichObservedEligible("overflow")).toBe(true)
    expect(CompactionManager.isEnrichObservedEligible("cache-aware")).toBe(true)
    expect(CompactionManager.isEnrichObservedEligible("rebind")).toBe(true)
    expect(CompactionManager.isEnrichObservedEligible("manual")).toBe(true)
    expect(CompactionManager.isEnrichObservedEligible("idle")).toBe(false)
    expect(CompactionManager.isEnrichObservedEligible("empty-response")).toBe(false)
    expect(CompactionManager.isEnrichObservedEligible("reload")).toBe(false)
  })

  it("an ineligible observed (idle) is skipped at the intake — executor not reached", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((sid) => calls.push(sid))
    // This is the case that used to slip through writeAnchorFromBody's
    // unconditional enrich call and over-enrich idle compactions.
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "idle", model: undefined, origin: "writeAnchorFromBody" })
    expect(calls).toHaveLength(0)
  })

  it("an eligible observed reaches the executor", () => {
    const calls: string[] = []
    CompactionManager.setEnrichExecutor((sid) => calls.push(sid))
    CompactionManager.requestEnrich({ sessionID: "ses_a", anchorId: "anchor_1", observed: "overflow", model: undefined, origin: "run-postchain" })
    expect(calls).toHaveLength(1)
  })
})

// S2: publish is brought under the same monitored intake. The wrapper is a
// transparent pass-through — it monitors (log + duplicate-publish anomaly) but
// NEVER suppresses, so a needed chain-reset can't be dropped.
describe("CompactionManager — publish monitoring (S2)", () => {
  beforeEach(() => CompactionManager.__test__.reset())

  it("delegates every publish to the executor with its meta", () => {
    const calls: Array<{ sid: string; kind?: string }> = []
    CompactionManager.setPublishExecutor((sid, meta) => calls.push({ sid, kind: meta?.kind }))
    CompactionManager.requestPublish({ sessionID: "ses_a", anchorId: "anchor_1", origin: "writeAnchorFromBody", meta: { observed: "overflow", kind: "narrative" } })
    expect(calls).toEqual([{ sid: "ses_a", kind: "narrative" }])
  })

  it("a duplicate publish for the same anchor is MONITORED but still published (never suppressed)", () => {
    const calls: string[] = []
    CompactionManager.setPublishExecutor((sid, meta) => calls.push(`${sid}:${meta?.kind}`))
    CompactionManager.requestPublish({ sessionID: "ses_a", anchorId: "anchor_1", origin: "writeAnchorFromBody", meta: { kind: "ai_free" } })
    CompactionManager.requestPublish({ sessionID: "ses_a", anchorId: "anchor_1", origin: "run-ai_free", meta: { kind: "ai_free" } }) // the regressed double
    // Both delegate (chain-reset is never dropped); the second raises the
    // duplicate-publish tripwire (asserted via never-suppress here).
    expect(calls).toHaveLength(2)
  })

  it("anchor-less publishes (failure / reload) still delegate, without dedup", () => {
    const calls: string[] = []
    CompactionManager.setPublishExecutor((sid, meta) => calls.push(`${sid}:${meta?.success}`))
    CompactionManager.requestPublish({ sessionID: "ses_a", origin: "chain-exhausted", meta: { success: false } })
    CompactionManager.requestPublish({ sessionID: "ses_a", origin: "reload-rebuild", meta: { observed: "reload" } })
    expect(calls).toHaveLength(2)
  })
})

// S3: compaction execution flows through the manager too (resolves the dual-track).
describe("CompactionManager — compact execution (S3)", () => {
  beforeEach(() => CompactionManager.__test__.reset())

  it("delegates to the executor and returns its result", async () => {
    const seen: Array<{ observed: string; origin: string }> = []
    CompactionManager.setCompactExecutor(async (input) => {
      seen.push({ observed: input.observed, origin: "" })
      return "continue"
    })
    const r = await CompactionManager.requestCompact({
      input: { sessionID: "ses_a", observed: "overflow", step: 3 },
      origin: "mainloop",
      cause: { observed: "overflow" },
    })
    expect(r).toBe("continue")
    expect(seen).toEqual([{ observed: "overflow", origin: "" }])
  })

  it("returns 'continue' (no-op) when no executor is registered", async () => {
    const r = await CompactionManager.requestCompact({
      input: { sessionID: "ses_a", observed: "manual", step: 0 },
      origin: "manual-route",
    })
    expect(r).toBe("continue")
  })
})

// DD-12: provider switch is not a global compaction trigger — each provider's
// strategy decides on takeover. Surfaced by live fetch-back validation.
describe("CompactionManager — provider-switch takeover decision (DD-12)", () => {
  beforeEach(() => {
    CompactionManager.__test__.reset()
    SessionCompaction.__test__.wireCompactionManager()
  })

  it("claude does NOT compact on takeover; codex / general DO", () => {
    expect(CompactionManager.shouldCompactOnTakeover("claude-cli")).toBe(false)
    expect(CompactionManager.shouldCompactOnTakeover("codex")).toBe(true)
    expect(CompactionManager.shouldCompactOnTakeover("github-copilot")).toBe(true)
    expect(CompactionManager.shouldCompactOnTakeover(undefined)).toBe(true) // general default
  })
})

// DD-13: provider-switch compaction EXECUTION is monitored (ledger parity) and
// transparently delegates to the caller's writeAnchorFromBody thunk.
describe("CompactionManager — provider-switch execution monitor (DD-13)", () => {
  it("requestProviderSwitchCompact delegates to the executor exactly once", async () => {
    let calls = 0
    await CompactionManager.requestProviderSwitchCompact(
      { sessionID: "ses_ps", cause: { prevProvider: "codex", nextProvider: "claude-cli" } },
      async () => {
        calls++
      },
    )
    expect(calls).toBe(1)
  })

  it("never suppresses — a throwing executor surfaces (no silent swallow)", async () => {
    let threw = false
    await CompactionManager.requestProviderSwitchCompact({ sessionID: "ses_ps2" }, async () => {
      throw new Error("boom")
    }).catch(() => {
      threw = true
    })
    expect(threw).toBe(true)
  })
})
