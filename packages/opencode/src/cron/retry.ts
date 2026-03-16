import { Log } from "../util/log"
import type { CronJob, CronJobState, CronRunOutcome, CronSchedule } from "./types"
import { Schedule } from "./schedule"

/**
 * Cron job retry policy (D.3.10).
 *
 * - Transient errors: exponential backoff (30s → 1m → 5m → 15m → 60m)
 * - Permanent errors: disable immediately
 * - One-shot (at) jobs: retry up to maxAttempts, then disable
 * - Recurring (every/cron) jobs: backoff overlaid on natural schedule
 *
 * Benchmark: refs/openclaw/src/cron/service/timer.ts
 * IDEF0 reference: A14 (Enforce Session Retention Policy — error subset)
 */
export namespace RetryPolicy {
  const log = Log.create({ service: "cron.retry" })

  // --- Backoff schedule ---

  const DEFAULT_BACKOFF_MS = [
    30_000,       // 1st error  →  30s
    60_000,       // 2nd error  →  1m
    5 * 60_000,   // 3rd error  →  5m
    15 * 60_000,  // 4th error  →  15m
    60 * 60_000,  // 5th+ error →  60m
  ]

  const DEFAULT_MAX_ATTEMPTS = 3

  // --- Error classification ---

  export type ErrorClass = "transient" | "permanent"

  const TRANSIENT_PATTERNS: Array<[string, RegExp]> = [
    ["rate_limit", /(rate[_ ]limit|too many requests|429|resource has been exhausted)/i],
    ["overloaded", /\b529\b|\boverloaded\b|high demand|capacity exceeded/i],
    ["network", /(econnreset|econnrefused|fetch failed|socket|network)/i],
    ["timeout", /(timeout|etimedout)/i],
    ["server_error", /\b5\d{2}\b/],
  ]

  const PERMANENT_REASONS = new Set([
    "auth", "auth_permanent", "format", "billing",
    "model_not_found", "session_expired",
  ])

  /**
   * Classify an error string as transient or permanent.
   */
  export function classifyError(error: string | undefined, reason?: string): ErrorClass {
    if (reason && PERMANENT_REASONS.has(reason)) return "permanent"
    if (!error) return "permanent" // no error info → assume permanent

    for (const [, pattern] of TRANSIENT_PATTERNS) {
      if (pattern.test(error)) return "transient"
    }

    return "permanent"
  }

  /**
   * Compute backoff delay in ms for the given number of consecutive errors.
   */
  export function backoffMs(
    consecutiveErrors: number,
    schedule?: number[],
  ): number {
    const backoff = schedule ?? DEFAULT_BACKOFF_MS
    const index = Math.min(consecutiveErrors - 1, backoff.length - 1)
    return backoff[Math.max(0, index)]
  }

  // --- Config ---

  export type RetryConfig = {
    maxAttempts?: number
    backoffScheduleMs?: number[]
  }

  // --- Apply result ---

  export type RetryDecision =
    | { action: "continue"; nextRunAtMs: number; consecutiveErrors: number }
    | { action: "disable"; reason: string; consecutiveErrors: number }

  /**
   * Given a job and its run outcome, decide what to do next.
   *
   * On success: reset consecutiveErrors, compute normal next run.
   * On error:
   *   - Permanent → disable immediately
   *   - Transient + one-shot → retry up to maxAttempts, then disable
   *   - Transient + recurring → overlay backoff on natural schedule
   */
  export function decide(
    job: Pick<CronJob, "schedule" | "deleteAfterRun">,
    state: Pick<CronJobState, "consecutiveErrors">,
    outcome: CronRunOutcome,
    config?: RetryConfig,
    nowMs?: number,
  ): RetryDecision {
    const now = nowMs ?? Date.now()
    const errors = state.consecutiveErrors ?? 0

    // --- Success ---
    if (outcome.status === "ok" || outcome.status === "skipped") {
      if (job.schedule.kind === "at") {
        // One-shot completed — disable (or will be deleted by caller if deleteAfterRun)
        return { action: "disable", reason: "one-shot completed", consecutiveErrors: 0 }
      }
      const nextRunAtMs = Schedule.computeNextRunAtMs(job.schedule, now)
      return { action: "continue", nextRunAtMs, consecutiveErrors: 0 }
    }

    // --- Error ---
    const newErrors = errors + 1
    const errorClass = classifyError(outcome.error, undefined)

    // Permanent error → disable
    if (errorClass === "permanent") {
      log.warn("permanent error — disabling job", {
        error: outcome.error,
        consecutiveErrors: newErrors,
      })
      return {
        action: "disable",
        reason: `permanent error: ${outcome.error ?? "unknown"}`,
        consecutiveErrors: newErrors,
      }
    }

    // Transient error
    const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

    if (job.schedule.kind === "at") {
      // One-shot: limited retries
      if (newErrors >= maxAttempts) {
        log.warn("one-shot max retries reached — disabling", {
          consecutiveErrors: newErrors,
          maxAttempts,
        })
        return {
          action: "disable",
          reason: `max retries (${maxAttempts}) reached`,
          consecutiveErrors: newErrors,
        }
      }
      const delay = backoffMs(newErrors, config?.backoffScheduleMs)
      return { action: "continue", nextRunAtMs: now + delay, consecutiveErrors: newErrors }
    }

    // Recurring: overlay backoff on natural schedule
    const naturalNext = Schedule.computeNextRunAtMs(job.schedule, now)
    const delay = backoffMs(newErrors, config?.backoffScheduleMs)
    const backoffNext = now + delay
    const nextRunAtMs = Math.max(naturalNext, backoffNext)

    log.info("transient error — backoff applied", {
      consecutiveErrors: newErrors,
      delayMs: delay,
      nextRunAtMs,
    })

    return { action: "continue", nextRunAtMs, consecutiveErrors: newErrors }
  }

  /**
   * Apply a retry decision to job state fields.
   * Returns a partial CronJobState to merge.
   */
  export function applyOutcomeToState(
    outcome: CronRunOutcome,
    decision: RetryDecision,
    nowMs?: number,
  ): Partial<CronJobState> {
    const now = nowMs ?? Date.now()
    const base: Partial<CronJobState> = {
      lastRunAtMs: now,
      lastRunStatus: outcome.status,
      lastDurationMs: outcome.durationMs,
      consecutiveErrors: decision.consecutiveErrors,
      runningAtMs: undefined,
    }

    if (outcome.status === "error") {
      base.lastError = outcome.error
      base.lastErrorReason = classifyError(outcome.error)
    } else {
      base.lastError = undefined
      base.lastErrorReason = undefined
    }

    if (decision.action === "continue") {
      base.nextRunAtMs = decision.nextRunAtMs
    } else {
      base.nextRunAtMs = undefined
    }

    return base
  }
}
