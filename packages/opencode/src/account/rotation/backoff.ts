/**
 * Backoff calculation and rate limit reason parsing.
 *
 * @event_20260216_rotation_split — extracted from rotation.ts
 */

import { type RateLimitReason, type ErrorWithMetadata, asErrorWithMetadata, getNextQuotaReset } from "./types"

// ============================================================================
// Backoff Constants
// ============================================================================

const FIVE_HOUR_BACKOFF = 18_000_000
const QUOTA_EXHAUSTED_BACKOFFS = [FIVE_HOUR_BACKOFF, FIVE_HOUR_BACKOFF, 86_400_000] as const
const RATE_LIMIT_PROBE_BACKOFF = 60_000 // 1 minute safe bet for RPM
const RATE_LIMIT_LONG_BACKOFF = 86_400_000 // 24 hours for RPD
const RATE_LIMIT_EXCEEDED_BACKOFF = 300_000 // 5 minutes default
const SERVICE_UNAVAILABLE_503_BACKOFF = 300_000 // 5 minutes
const SITE_OVERLOADED_529_BACKOFF = 300_000 // 5 minutes
const MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF = 300_000 // 5 minutes
const MODEL_CAPACITY_EXHAUSTED_JITTER_MAX = 30_000
const SERVER_ERROR_BACKOFF = 20_000
const AUTH_FAILED_BACKOFF = 3_600_000 // 1 hour
const TOKEN_REFRESH_FAILED_BACKOFF = FIVE_HOUR_BACKOFF // 5 hours
const UNKNOWN_BACKOFF = 300_000 // 5 minutes
const MIN_BACKOFF_MS = 2_000

function generateJitter(maxJitterMs: number): number {
  return Math.random() * maxJitterMs - maxJitterMs / 2
}

// ============================================================================
// Parse Rate Limit Reason
// ============================================================================

/**
 * Parse rate limit reason from error details
 */
export function parseRateLimitReason(
  reason: string | undefined,
  message: string | undefined,
  status?: number,
): RateLimitReason {
  // Status Code Checks (preserve official HTTP semantics)
  if (status === 503) return "SERVICE_UNAVAILABLE_503"
  if (status === 529) return "SITE_OVERLOADED_529"
  if (status === 500) return "SERVER_ERROR"

  // Explicit Reason String
  if (reason) {
    switch (reason.toUpperCase()) {
      case "QUOTA_EXHAUSTED":
      case "USAGE_LIMIT_REACHED":
      case "INSUFFICIENT_QUOTA":
        return "QUOTA_EXHAUSTED"
      case "RATE_LIMIT_EXCEEDED":
        return "RATE_LIMIT_EXCEEDED"
      case "SERVICE_UNAVAILABLE_503":
        return "SERVICE_UNAVAILABLE_503"
      case "SITE_OVERLOADED_529":
        return "SITE_OVERLOADED_529"
      case "MODEL_CAPACITY_EXHAUSTED":
        return "MODEL_CAPACITY_EXHAUSTED"
    }
  }

  // Message Text Scanning
  if (message) {
    const lower = message.toLowerCase()

    // Check for specific token refresh failure that requires 5h cooldown
    if (lower.includes("token refresh failed") && lower.includes("invalid_scope")) {
      return "TOKEN_REFRESH_FAILED"
    }

    if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("resource exhausted")) {
      return "MODEL_CAPACITY_EXHAUSTED"
    }

    // Check for explicit short-term rate limits (RPM, TPM, RPS)
    if (
      lower.includes("per minute") ||
      lower.includes("per second") ||
      lower.includes("requests per minute") ||
      lower.includes("tokens per minute") ||
      lower.includes("minute limit") ||
      lower.includes("rpm") ||
      lower.includes("tpm") ||
      lower.includes("tps")
    ) {
      return "RATE_LIMIT_SHORT"
    }

    // Check for explicit long-term rate limits (Daily, Quota)
    if (
      lower.includes("per day") ||
      lower.includes("daily") ||
      lower.includes("limit reached for the day") ||
      lower.includes("rpd")
    ) {
      return "RATE_LIMIT_LONG"
    }

    // Check for Monthly / Billing limits (Github Copilot, OpenAI, etc)
    // @event_20260217_github_copilot_rate_limit: Catch monthly/billing limits to prevent model removal
    if (
      // @event_20260217_i18n_rate_limit: Chinese terms for monthly/quota limits
      lower.includes("頻率限制") ||
      lower.includes("配額") ||
      lower.includes("額度")
    ) {
      return "QUOTA_EXHAUSTED"
    }

    if (lower.includes("quota")) {
      return "QUOTA_EXHAUSTED"
    }

    // @plans/codex-rotation-hotfix Phase 4 — belt-and-suspenders for the codex
    // 5H window. Even when cockpit is offline or the error stream is parsed
    // before the quota fetcher responds, these message patterns force a
    // QUOTA_EXHAUSTED classification so the account does not silently cycle
    // through the short RPM backoff path.
    if (
      lower.includes("5 hour limit") ||
      lower.includes("5-hour limit") ||
      lower.includes("five hour limit") ||
      lower.includes("response_time_window_exhausted") ||
      lower.includes("response time window exhausted") ||
      lower.includes("usage limit reached") ||
      lower.includes("usage limit has been reached") ||
      lower.includes("usage limit exceeded") ||
      lower.includes("weekly limit") ||
      lower.includes("weekly usage")
    ) {
      return "QUOTA_EXHAUSTED"
    }

    if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("token refresh failed")) {
      return "RATE_LIMIT_EXCEEDED"
    }
  }

  if (status === 429) {
    return "UNKNOWN"
  }

  return "UNKNOWN"
}

// ============================================================================
// Calculate Backoff
// ============================================================================

/**
 * Calculate backoff time based on rate limit reason
 */
export function calculateBackoffMs(
  reason: RateLimitReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null,
  dailyFailures: number = 0,
): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.max(retryAfterMs, MIN_BACKOFF_MS)
  }

  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1)
      return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF
    }
    case "RATE_LIMIT_SHORT":
      // Short-term RPM/TPM limit: 5 minutes is usually enough to clear rolling windows
      return 300_000 // 5 minutes
    case "RATE_LIMIT_LONG":
      // Long-term Daily limit: Until the next 16:00 Taipei reset
      return Math.max(getNextQuotaReset() - Date.now(), 60_000)
    case "RATE_LIMIT_EXCEEDED":
    case "UNKNOWN":
    default: {
      // @event_20260215_daily_rpd: Use absolute daily counter for RPD detection
      // 1st failure in the quota day: 1 minute (Probe RPM)
      // 2nd+ failure in the same quota day: 1 hour (Suspected RPD)
      if (dailyFailures <= 1) {
        return RATE_LIMIT_PROBE_BACKOFF
      }
      return FIVE_HOUR_BACKOFF // repeated failures in same quota day: long cooldown to stop cycling
    }
    case "SERVICE_UNAVAILABLE_503":
      return SERVICE_UNAVAILABLE_503_BACKOFF
    case "SITE_OVERLOADED_529":
      return SITE_OVERLOADED_529_BACKOFF
    case "MODEL_CAPACITY_EXHAUSTED":
      return MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF + generateJitter(MODEL_CAPACITY_EXHAUSTED_JITTER_MAX)
    case "SERVER_ERROR":
      return SERVER_ERROR_BACKOFF
    case "AUTH_FAILED":
      return AUTH_FAILED_BACKOFF
    case "TOKEN_REFRESH_FAILED":
      return TOKEN_REFRESH_FAILED_BACKOFF
  }
}
