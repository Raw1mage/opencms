import { Log } from "../util/log"
import type { CronSchedule } from "./types"

/**
 * Schedule expression engine (D.2.1) — computes next fire time for cron jobs.
 *
 * Supports three schedule kinds:
 *   - "at": one-shot ISO timestamp
 *   - "every": fixed interval with optional anchor
 *   - "cron": 5/6-field cron expression with IANA timezone
 *
 * IDEF0 reference: A21 (Parse Schedule Expression)
 * GRAFCET reference: opencode_a2_grafcet.json step S0
 * Design decision: DD-9 (30min default heartbeat interval)
 */
export namespace Schedule {
  const log = Log.create({ service: "cron.schedule" })

  /**
   * Compute the next run time (ms since epoch) for a schedule.
   * Returns undefined if the schedule has no future fire time (e.g., expired "at").
   */
  export function computeNextRunAtMs(
    schedule: CronSchedule,
    nowMs: number = Date.now(),
  ): number | undefined {
    switch (schedule.kind) {
      case "at":
        return computeAt(schedule.at, nowMs)
      case "every":
        return computeEvery(schedule.everyMs, nowMs, schedule.anchorMs)
      case "cron":
        return computeCron(schedule.expr, nowMs, schedule.tz, schedule.staggerMs)
    }
  }

  /**
   * Check if a schedule is expired (no future fire times).
   */
  export function isExpired(schedule: CronSchedule, nowMs: number = Date.now()): boolean {
    return computeNextRunAtMs(schedule, nowMs) === undefined
  }

  // --- "at" schedule: one-shot ISO timestamp ---

  function computeAt(at: string, nowMs: number): number | undefined {
    const ts = new Date(at).getTime()
    if (isNaN(ts)) {
      log.warn("invalid 'at' timestamp", { at })
      return undefined
    }
    return ts > nowMs ? ts : undefined
  }

  // --- "every" schedule: fixed interval ---

  function computeEvery(
    everyMs: number,
    nowMs: number,
    anchorMs?: number,
  ): number | undefined {
    if (everyMs <= 0) return undefined
    const anchor = anchorMs ?? nowMs
    if (anchor > nowMs) return anchor

    // Find next interval boundary after now
    const elapsed = nowMs - anchor
    const periods = Math.floor(elapsed / everyMs)
    const next = anchor + (periods + 1) * everyMs
    return next
  }

  // --- "cron" schedule: cron expression ---

  // Minimal cron expression parser for 5-field standard cron.
  // Supports: minute hour day-of-month month day-of-week
  // Handles: star (any), star-slash-N (step), N (exact), N-M (range), N,M (list)
  function computeCron(
    expr: string,
    nowMs: number,
    tz?: string,
    staggerMs?: number,
  ): number | undefined {
    try {
      const fields = expr.trim().split(/\s+/)
      if (fields.length < 5 || fields.length > 6) {
        log.warn("invalid cron expression field count", { expr, fields: fields.length })
        return undefined
      }

      // Use 5-field format (ignore optional seconds field)
      const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] =
        fields.length === 6 ? fields.slice(1) : fields

      const now = tz ? dateInTimezone(nowMs, tz) : new Date(nowMs)

      // Search forward up to 366 days
      const searchLimit = 366 * 24 * 60
      let candidate = new Date(now)
      candidate.setSeconds(0, 0)
      candidate.setMinutes(candidate.getMinutes() + 1)

      for (let i = 0; i < searchLimit; i++) {
        if (
          matchField(monthExpr, candidate.getMonth() + 1, 1, 12) &&
          matchField(domExpr, candidate.getDate(), 1, 31) &&
          matchField(dowExpr, candidate.getDay(), 0, 6) &&
          matchField(hourExpr, candidate.getHours(), 0, 23) &&
          matchField(minuteExpr, candidate.getMinutes(), 0, 59)
        ) {
          let result = candidate.getTime()

          // Apply stagger offset
          if (staggerMs && staggerMs > 0) {
            result += staggerMs
          }

          return result > nowMs ? result : undefined
        }
        candidate.setMinutes(candidate.getMinutes() + 1)
      }

      log.warn("no match found within search window", { expr })
      return undefined
    } catch (e) {
      log.error("cron parse error", { expr, error: e })
      return undefined
    }
  }

  /**
   * Match a cron field expression against a value.
   */
  function matchField(expr: string, value: number, min: number, max: number): boolean {
    if (expr === "*") return true

    for (const part of expr.split(",")) {
      // Step: */N or N-M/S
      const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/)
      if (stepMatch) {
        const step = parseInt(stepMatch[4])
        const rangeStart = stepMatch[1] === "*" ? min : parseInt(stepMatch[2])
        const rangeEnd = stepMatch[1] === "*" ? max : parseInt(stepMatch[3])
        if (value >= rangeStart && value <= rangeEnd && (value - rangeStart) % step === 0) return true
        continue
      }

      // Range: N-M
      const rangeMatch = part.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1])
        const end = parseInt(rangeMatch[2])
        if (value >= start && value <= end) return true
        continue
      }

      // Exact: N
      if (parseInt(part) === value) return true
    }

    return false
  }

  /**
   * Create a Date object adjusted for a timezone.
   * Uses Intl.DateTimeFormat for timezone conversion.
   */
  function dateInTimezone(ms: number, tz: string): Date {
    const date = new Date(ms)
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    const parts = formatter.formatToParts(date)
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0")
    return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  }

  // --- Deterministic stagger (D.2.2) ---

  const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000 // 5 minutes

  /**
   * Compute deterministic stagger offset for a job based on its ID hash.
   * Only applies to top-of-hour cron expressions to reduce thundering herd.
   */
  export function computeStaggerMs(
    schedule: CronSchedule,
    jobId: string,
    opts?: { exact?: boolean; overrideMs?: number },
  ): number {
    if (opts?.exact) return 0
    if (schedule.kind !== "cron") return 0
    if (opts?.overrideMs !== undefined) return opts.overrideMs

    // Check if this is a top-of-hour expression (minute field is "0")
    const fields = schedule.expr.trim().split(/\s+/)
    const minuteField = fields.length === 6 ? fields[1] : fields[0]
    if (minuteField !== "0") return 0

    // Hash job ID to produce a deterministic offset within the stagger window
    const window = schedule.staggerMs ?? DEFAULT_TOP_OF_HOUR_STAGGER_MS
    if (window <= 0) return 0

    let hash = 0
    for (let i = 0; i < jobId.length; i++) {
      hash = ((hash << 5) - hash + jobId.charCodeAt(i)) | 0
    }
    return Math.abs(hash) % window
  }
}
