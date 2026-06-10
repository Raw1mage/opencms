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
}

class CodexCompactionStrategy implements CompactionProviderStrategy {
  readonly provider = "codex" as const
  constructor(private readonly exec: EnrichExecutor) {}
  enrich(ctx: EnrichContext): void {
    this.exec(ctx)
  }
}

class GeneralCompactionStrategy implements CompactionProviderStrategy {
  readonly provider = "general" as const
  constructor(private readonly exec: EnrichExecutor) {}
  enrich(ctx: EnrichContext): void {
    this.exec(ctx)
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
