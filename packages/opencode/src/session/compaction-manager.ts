import { Log } from "../util/log"
import { RuntimeEventService } from "../system/runtime-event-service"
import type { Provider } from "../provider/provider"

/**
 * CompactionManager — single intake + structural dedup for compaction's
 * post-anchor side-effects.
 *
 * spec: compaction/central-manager (S1). Background enrichment scheduling used
 * to be invoked from two layers of the same run() call stack
 * (writeAnchorFromBody + run()), with a weak in-flight guard as the only
 * dedup. The guard was defeated by the ~2 ms drop_old_history fast path, so a
 * single compaction double-trimmed its anchor (23,706 → 6,102 → 2,441 tokens),
 * collapsing a 233-round session's sole-memory anchor → user-visible amnesia
 * (RCA event_2026-06-10_rca-re-verified-with-hard-data-…).
 *
 * Now every enrichment request funnels through `requestEnrich`, deduped per
 * anchor id. A second request for the same anchor is a no-op + duplicate-enrich
 * anomaly — dedup is a structural property of the single intake, so the old
 * in-flight guard is retired with no replacement guard (DD-2/DD-3).
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
   * The underlying enrichment executor. Injected by compaction.ts at module
   * load (one-directional import: compaction.ts → manager) so the manager owns
   * the decision while reusing the existing executor unchanged (DD-5).
   */
  type EnrichExecutor = (sessionID: string, observed: string, model: Provider.Model | undefined) => void
  let enrichExecutor: EnrichExecutor | undefined

  export function setEnrichExecutor(fn: EnrichExecutor): void {
    enrichExecutor = fn
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
   * Single intake for background enrichment. Dedups per anchor id: the first
   * request for an anchor schedules the background distillation; any later
   * request for the SAME anchor is rejected as a `duplicate-enrich` anomaly
   * (this is exactly the double-trim the structural fix eliminates).
   */
  export function requestEnrich(req: EnrichRequest): void {
    const { sessionID, anchorId, observed, model, origin } = req

    if (anchorId && lastEnrichedAnchor.get(sessionID) === anchorId) {
      log.info("enrich rejected: duplicate anchor", { sessionID, anchorId, origin, observed })
      void RuntimeEventService.append({
        sessionID,
        level: "info",
        domain: "telemetry",
        eventType: "compaction.anomaly",
        anomalyFlags: ["duplicate-enrich"],
        payload: { code: "duplicate-enrich", anchorId, origin, observed },
      }).catch(() => undefined)
      return
    }

    if (anchorId) lastEnrichedAnchor.set(sessionID, anchorId)
    log.info("enrich scheduled", { sessionID, anchorId, origin, observed })
    enrichExecutor?.(sessionID, observed, model)
  }

  /** Drop per-session dedup state (call on session delete to avoid growth). */
  export function forget(sessionID: string): void {
    lastEnrichedAnchor.delete(sessionID)
  }

  /** Test-only seam. */
  export const __test__ = Object.freeze({
    requestEnrich,
    reset() {
      lastEnrichedAnchor.clear()
      enrichExecutor = undefined
    },
    peekLastEnriched(sessionID: string) {
      return lastEnrichedAnchor.get(sessionID)
    },
  })
}
