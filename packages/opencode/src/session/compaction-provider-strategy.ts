import type { Provider } from "../provider/provider"

/**
 * Per-provider compaction strategy layer (compaction/central-manager DD-10).
 *
 * Responsibility layering is three-tier:
 *   1. trigger points  — pure reporters; emit a request, decide nothing.
 *   2. CompactionManager — central layer; provider-AGNOSTIC concerns (intake,
 *      dedup, serialize, log, anomaly) + ROUTES by provider class.
 *   3. provider strategy — this file; each provider's detailed execution logic,
 *      designed independently. Codex SS-break chain-reset + item-count + dormant
 *      server-side compact; claude SL-noop + CLAUDE_NOOP_OBSERVED + absolute
 *      aFloor gate; general by-request forceRich — each lives in its own
 *      strategy, no cross-contamination.
 *
 * S1 implements `enrich` (background enrichment). S2 adds publish/chain-reset
 * (where codex SS-break vs claude SL-noop genuinely diverge); S3 adds
 * trigger/kind-chain selection.
 */

export type ProviderClass = "claude" | "codex" | "general"

/**
 * Classify a provider id into the 3-class compaction taxonomy. Mirrors
 * resolvePolicy's split (claude-cli → ClaudePolicy, else → GeneralPolicy) plus
 * codex broken out as its own class (general policy + stateful SS-chain).
 */
export function classifyProvider(providerId: string | undefined): ProviderClass {
  if (providerId === "claude-cli") return "claude"
  if (providerId === "codex") return "codex"
  return "general"
}

export type EnrichContext = {
  sessionID: string
  observed: string
  model: Provider.Model | undefined
}

/** Background enrichment executor (the existing scheduleHybridEnrichment). */
export type EnrichExecutor = (ctx: EnrichContext) => void

export interface CompactionProviderStrategy {
  readonly provider: ProviderClass
  /** Execute background enrichment for this provider. */
  enrich(ctx: EnrichContext): void
  /**
   * On provider takeover (the session just switched TO this provider), does
   * this provider need a narrative compaction to hand the context over?
   * (DD-12). Provider switch is no longer a global compaction trigger — each
   * provider decides. Chain-reset is separate (Continuation.run, already
   * provider-aware) and not affected by this.
   */
  shouldCompactOnTakeover(): boolean
}

// ── Per-provider strategies ──────────────────────────────────────────────
// S1: each provider's enrichment currently delegates to the shared executor
// (which already applies the per-provider A-tier gate internally via
// resolvePolicy). The strategies are the routing/ownership boundary so later
// slices migrate each provider's gate + publish + chain-reset behaviour here
// without entangling the others.

class ClaudeCompactionStrategy implements CompactionProviderStrategy {
  readonly provider = "claude" as const
  constructor(private readonly exec: EnrichExecutor) {}
  enrich(ctx: EnrichContext): void {
    this.exec(ctx)
  }
  shouldCompactOnTakeover(): boolean {
    // claude is stateless full-retransmit with a 1M window and no server chain
    // to reset — taking over a session needs no narrative compaction; the next
    // request just re-sends the context. Compacting here only forces a needless
    // SS-break amnesia + recall round-trip (CLAUDE_NOOP_OBSERVED / DD-4 intent).
    return false
  }
}

class CodexCompactionStrategy implements CompactionProviderStrategy {
  readonly provider = "codex" as const
  constructor(private readonly exec: EnrichExecutor) {}
  enrich(ctx: EnrichContext): void {
    this.exec(ctx)
  }
  shouldCompactOnTakeover(): boolean {
    // codex has a smaller window than claude and its server-side context
    // representation does not carry across a provider change — hand the context
    // over as a compacted narrative anchor. (Chain-reset itself is Continuation.run.)
    return true
  }
}

class GeneralCompactionStrategy implements CompactionProviderStrategy {
  readonly provider = "general" as const
  constructor(private readonly exec: EnrichExecutor) {}
  enrich(ctx: EnrichContext): void {
    this.exec(ctx)
  }
  shouldCompactOnTakeover(): boolean {
    // general providers (copilot etc.) have small windows (often 128K) where an
    // accumulated context is a large fraction — compact on takeover.
    return true
  }
}

/** Build the provider→strategy registry from a shared enrichment executor. */
export function createProviderStrategies(exec: EnrichExecutor): Map<ProviderClass, CompactionProviderStrategy> {
  return new Map<ProviderClass, CompactionProviderStrategy>([
    ["claude", new ClaudeCompactionStrategy(exec)],
    ["codex", new CodexCompactionStrategy(exec)],
    ["general", new GeneralCompactionStrategy(exec)],
  ])
}
