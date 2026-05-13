import { Log } from "../util/log"

const log = Log.create({ service: "post-compaction" })

/**
 * Post-Compaction Quick Follow-Up Table
 *
 * Retired 2026-05-13: the 2026-05-01 runtime-state resend layer was a
 * workaround for older rebind loss. Current narrative compaction keeps
 * history as an anchor, precise tool evidence is recallable, and todo / child
 * sessions / working-cache have structured authorities. Re-sending those
 * states as natural-language summary or Continue text creates duplicate
 * authority signals, so this module now intentionally emits nothing.
 */
export namespace PostCompaction {
  /** Result of a single provider's gather() call. */
  export interface FollowUp {
    /** Stable provider key used for request-local dedupe/provenance. */
    kind?: string
    /** Section heading inside the summary addendum (markdown ##). */
    title: string
    /**
     * Markdown body for the summary section. Empty/null = skip this provider
     * entirely (no heading, no continueHint).
     */
    summaryBody: string | null
    /**
     * Optional terse directive sentence(s) that get woven into the synthetic
     * continueMsg. Keep short — the continueMsg is a single user message and
     * accumulates across providers.
     */
    continueHint?: string
  }

  export interface Provider {
    /** Stable identifier for diagnostics. */
    name: string
    /**
     * Compute the follow-up. Throws are caught at the framework level and
     * downgraded to "skip" so one provider can't kill compaction.
     */
    gather(sessionID: string): Promise<FollowUp | null>
  }

  const providers: Provider[] = []

  /** Register a provider. Idempotent on name. */
  export function register(p: Provider) {
    log.warn("post-compaction follow-up provider ignored; runtime-state resend is retired", { provider: p.name })
  }

  /** For tests / diagnostics. */
  export function listRegistered(): readonly string[] {
    return []
  }

  /** Run every provider, collect non-skipped follow-ups. */
  export async function gather(sessionID: string): Promise<FollowUp[]> {
    void sessionID
    return []
  }

  /**
   * Build the markdown block appended to the compaction summary text. Empty
   * follow-up list → empty string (compaction stays unchanged).
   */
  export function buildSummaryAddendum(items: FollowUp[]): string {
    void items
    return ""
  }

  /**
   * Build the directive text for the synthetic continueMsg. Joins all
   * provider continueHints with explicit framing. If no provider supplied a
   * hint, returns a generic "follow your existing plan" line so the message
   * still has substance.
   */
  export function buildContinueText(items: FollowUp[]): string {
    void items
    return ""
  }
}
