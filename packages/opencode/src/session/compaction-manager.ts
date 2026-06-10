import { Log } from "../util/log"
import { RuntimeEventService } from "../system/runtime-event-service"
import type { Provider } from "../provider/provider"
import {
  classifyProvider,
  createProviderStrategies,
  type ProviderClass,
  type CompactionProviderStrategy,
} from "./compaction-provider-strategy"

/**
 * CompactionManager — central layer for compaction's post-anchor side-effects.
 *
 * spec: compaction/central-manager (S1 + DD-10). Responsibility layering:
 *   1. trigger points  — pure reporters (emit a request, decide nothing).
 *   2. this manager     — provider-AGNOSTIC concerns (intake, per-anchor dedup,
 *      structured logging, anomaly events) + ROUTES by provider class.
 *   3. provider strategy (compaction-provider-strategy.ts) — each provider's
 *      detailed execution logic, designed independently.
 *
 * Enrichment scheduling used to be invoked from two layers of the same run()
 * call stack with a weak in-flight guard as the only dedup; the guard was
 * defeated by the ~2 ms drop_old_history fast path, double-trimming a single
 * compaction's anchor (23,706 → 6,102 → 2,441 tokens) and collapsing a
 * 233-round session to ~10% → user-visible amnesia
 * (RCA event_2026-06-10_rca-re-verified-with-hard-data-…). Dedup is now a
 * structural property of this single intake (DD-2/DD-3).
 */
export namespace CompactionManager {
  const log = Log.create({ service: "session.compaction-manager" })

  /**
   * Per-session: the anchor id we have already scheduled enrichment for.
   * Enrichment only ever targets the most-recent anchor, and each compaction
   * mints a fresh anchor id, so a single slot per session is sufficient and
   * bounded (no growth, no replacement guard needed).
   */
  const lastEnrichedAnchor = new Map<string, string>()

  /**
   * provider → strategy registry (DD-10). Built when compaction.ts registers
   * the shared enrichment executor (one-directional import: compaction.ts →
   * manager → strategy), so the manager owns routing while each provider's
   * execution lives in its own strategy.
   */
  let strategies: Map<ProviderClass, CompactionProviderStrategy> | undefined

  /** Register the shared enrichment executor; builds the per-provider strategies. */
  export function setEnrichExecutor(
    fn: (sessionID: string, observed: string, model: Provider.Model | undefined) => void,
  ): void {
    strategies = createProviderStrategies((ctx) => fn(ctx.sessionID, ctx.observed, ctx.model))
  }

  export type EnrichRequest = {
    sessionID: string
    /** The just-committed anchor's message id; the dedup key. */
    anchorId: string | undefined
    observed: string
    model: Provider.Model | undefined
    /** Stable call-site id, for accountability (DD-4). */
    origin: string
  }

  /**
   * Single intake for background enrichment. Provider-agnostic dedup first
   * (per anchor id), then route by provider class to the strategy. The first
   * request for an anchor schedules enrichment; any later request for the SAME
   * anchor is rejected as a `duplicate-enrich` anomaly (the eliminated
   * double-trim).
   */
  export function requestEnrich(req: EnrichRequest): void {
    const { sessionID, anchorId, observed, model, origin } = req
    const provider = classifyProvider(model?.providerId)

    if (anchorId && lastEnrichedAnchor.get(sessionID) === anchorId) {
      log.info("enrich rejected: duplicate anchor", { sessionID, anchorId, origin, observed, provider })
      void RuntimeEventService.append({
        sessionID,
        level: "info",
        domain: "telemetry",
        eventType: "compaction.anomaly",
        anomalyFlags: ["duplicate-enrich"],
        payload: { code: "duplicate-enrich", anchorId, origin, observed, provider },
      }).catch(() => undefined)
      return
    }

    if (anchorId) lastEnrichedAnchor.set(sessionID, anchorId)
    log.info("enrich scheduled", { sessionID, anchorId, origin, observed, provider })

    // Central layer routes by provider class to the per-provider strategy (DD-10).
    const strategy = strategies?.get(provider) ?? strategies?.get("general")
    strategy?.enrich({ sessionID, observed, model })
  }

  /** Drop per-session dedup state (call on session delete to avoid growth). */
  export function forget(sessionID: string): void {
    lastEnrichedAnchor.delete(sessionID)
  }

  /** Test-only seam. */
  export const __test__ = Object.freeze({
    requestEnrich,
    classifyProvider,
    reset() {
      lastEnrichedAnchor.clear()
      strategies = undefined
    },
    peekLastEnriched(sessionID: string) {
      return lastEnrichedAnchor.get(sessionID)
    },
  })
}
