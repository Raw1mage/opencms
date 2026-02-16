/**
 * Error classification utilities for rate limit and auth error detection.
 *
 * @event_20260216_rotation_split — extracted from rotation.ts
 */

import { Log } from "../../util/log"
import { type RateLimitReason, asErrorWithMetadata } from "./types"
import { parseRateLimitReason } from "./backoff"

const log = Log.create({ service: "error-classifier" })

/**
 * Utility to check if an error is a rate limit error (HTTP 429)
 *
 * This function is intentionally strict to avoid false positives.
 * It only returns true for:
 * - Explicit HTTP 429 status code
 * - Error messages containing explicit rate limit keywords
 *
 * It does NOT return true for:
 * - Empty error objects
 * - Generic errors without status codes
 * - Server-side errors (500, 503) which are handled differently
 */
export function isRateLimitError(error: unknown): boolean {
  const errorObj = asErrorWithMetadata(error)
  if (!errorObj) return false

  // Check for explicit 429 status code
  const status = errorObj.status ?? errorObj.statusCode ?? errorObj.code

  // Only treat as rate limit if we have an EXPLICIT 429
  // Do not assume rate limit for errors without a status
  if (status === 429) {
    log.debug("isRateLimitError: matched by status code 429")
    return true
  }

  // Check for explicit rate limit message patterns (strict matching)
  const message = errorObj.message ?? ""
  if (typeof message === "string" && message.length > 0) {
    const lower = message.toLowerCase()

    // FIX: invalid_scope is an AUTH error (expired OAuth grant), not a rate limit.
    // Treating it as rate limit causes useless rotation across all claude-cli vectors
    // sharing the same broken refresh token. Must stop and ask user to re-authenticate.
    // @event_20260212_invalid_scope_no_rotate
    if (lower.includes("token refresh failed") && lower.includes("invalid_scope")) {
      log.debug("isRateLimitError: invalid_scope is auth error, NOT rate limit — skipping")
      return false
    }

    // Only match very specific rate limit patterns, not generic "error" messages
    if (
      lower.includes("429") ||
      lower.includes("rate_limit_exceeded") ||
      lower.includes("rate limited") ||
      lower.includes("too many requests") ||
      // @event_20260217_i18n_rate_limit: Support Chinese error messages
      lower.includes("頻率限制") ||
      lower.includes("配額") ||
      lower.includes("額度")
    ) {
      log.debug("isRateLimitError: matched by message pattern", { message: message.substring(0, 100) })
      return true
    }
  }

  return false
}

/**
 * Utility to check if an error is an authentication error
 */
export function isAuthError(error: unknown): boolean {
  const errorObj = asErrorWithMetadata(error)
  if (!errorObj) return false

  const status = errorObj.status ?? errorObj.statusCode ?? errorObj.code
  if (status === 401 || status === 403) return true

  const message = errorObj.message ?? ""
  if (typeof message === "string" && message.length > 0) {
    const lower = message.toLowerCase()

    // FIX: invalid_scope means the OAuth grant is dead — this IS an auth error.
    // Must trigger hard stop + toast to ask user to re-authenticate.
    // Previously excluded to allow rotation, but rotation is useless when all
    // vectors share the same broken refresh token.
    // @event_20260212_invalid_scope_no_rotate

    return (
      lower.includes("token refresh failed") ||
      lower.includes("authentication failed") ||
      lower.includes("invalid token") ||
      lower.includes("unauthorized")
    )
  }
  return false
}

/**
 * Extract rate limit details from an error
 */
export function extractRateLimitDetails(error: unknown): {
  reason: RateLimitReason
  retryAfterMs?: number
} {
  const errorObj = asErrorWithMetadata(error)
  const status = errorObj?.status ?? errorObj?.statusCode
  const message = errorObj?.message ?? ""
  const reasonHintValue = errorObj?.error?.type ?? errorObj?.code
  const reasonHint = typeof reasonHintValue === "string" ? reasonHintValue : undefined

  const reason = parseRateLimitReason(reasonHint, message, status)

  // Try to extract Retry-After header
  let retryAfterMs: number | undefined
  const retryAfter = errorObj?.headers?.["retry-after"] ?? errorObj?.retryAfter
  if (retryAfter) {
    if (typeof retryAfter === "number") {
      retryAfterMs = retryAfter * 1000
    } else if (typeof retryAfter === "string") {
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) {
        retryAfterMs = seconds * 1000
      }
    }
  }

  // Fallback: Try to extract from error message (common in Gemini 429s where headers are lost)
  // Example: "Please retry in 23s"
  if (!retryAfterMs && message) {
    const retryMatch = message.match(/Please retry in ([0-9.]+(?:ms|s|m|h))/i)
    if (retryMatch?.[1]) {
      retryAfterMs = parseRetryDelayValue(retryMatch[1])
    }

    // Also check for "after X" pattern
    if (!retryAfterMs) {
      const resetMatch = message.match(/after\s+([0-9.]+(?:ms|s|m|h))/i)
      if (resetMatch?.[1]) {
        retryAfterMs = parseRetryDelayValue(resetMatch[1])
      }
    }
  }

  return { reason, retryAfterMs }
}

/**
 * Parses retry delay values from strings (e.g., "23s", "1m").
 * Helper for message-based extraction.
 */
function parseRetryDelayValue(value: string): number | undefined {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return undefined

  if (trimmed.endsWith("ms")) {
    const ms = Number(trimmed.slice(0, -2))
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined
  }
  if (trimmed.endsWith("s")) {
    const s = Number(trimmed.slice(0, -1))
    return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : undefined
  }
  if (trimmed.endsWith("m")) {
    const m = Number(trimmed.slice(0, -1))
    return Number.isFinite(m) && m > 0 ? Math.round(m * 60 * 1000) : undefined
  }
  if (trimmed.endsWith("h")) {
    const h = Number(trimmed.slice(0, -1))
    return Number.isFinite(h) && h > 0 ? Math.round(h * 60 * 60 * 1000) : undefined
  }

  return undefined
}
