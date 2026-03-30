/**
 * Rate Limit Judge — Single Authority for Rate Limit Detection & Notification
 *
 * This module is the **only** place that:
 * 1. Classifies errors into rate limit reasons
 * 2. Calculates backoff times (with provider-specific strategies)
 * 3. Updates RateLimitTracker + HealthScoreTracker
 * 4. Broadcasts Bus events so Rotation and Admin Panel react in real time
 *
 * Provider-specific detection strategies:
 * - cockpit  (openai) → Query live quota API for quota-window based backoff
 * - counter  (gemini-cli, google-api) → Use RequestMonitor RPM/RPD to infer limit type
 * - passive  (all others)           → Rely on error response only
 *
 * @event_20260216_rate_limit_judge
 */

import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import z from "zod"
import {
  isRateLimitError as _isRateLimitError,
  isAuthError as _isAuthError,
  extractRateLimitDetails,
  calculateBackoffMs,
  getHealthTracker,
  getRateLimitTracker,
  getNextQuotaReset,
  type RateLimitReason,
} from "./rotation"
import { RequestMonitor } from "./monitor"
import { debugCheckpoint } from "../util/debug"

const log = Log.create({ service: "rate-limit-judge" })
const PROVIDER_COOLDOWN_MIN_MS = 5 * 60 * 60 * 1000

export function shouldPromoteToProviderCooldown(reason: RateLimitReason, backoffMs: number): boolean {
  switch (reason) {
    case "QUOTA_EXHAUSTED":
    case "RATE_LIMIT_LONG":
    case "TOKEN_REFRESH_FAILED":
      return true
    case "RATE_LIMIT_EXCEEDED":
      return backoffMs >= PROVIDER_COOLDOWN_MIN_MS
    // UNKNOWN must NOT promote: unrecognised errors (e.g. stale token 429)
    // would wrongly lock the entire provider and cascade across all accounts.
    default:
      return false
  }
}

function serializeErrorForDebug(error: unknown): Record<string, unknown> {
  const obj = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
  const data = obj?.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : undefined
  return {
    status: obj?.status ?? obj?.statusCode ?? data?.status,
    code: obj?.code ?? data?.code,
    name: obj?.name,
    message: obj?.message ?? data?.message,
    responseHeaders: data?.responseHeaders,
    responseBody: data?.responseBody,
    headers: obj?.headers ?? data?.headers,
    errorType: data?.error && typeof data.error === "object" ? (data.error as Record<string, unknown>).type : undefined,
    raw: error,
  }
}

// ============================================================================
// Bus Events — real-time notifications to Rotation, Admin Panel, etc.
// ============================================================================

export const RateLimitEvent = {
  /**
   * Fired when a rate limit is detected and classified.
   * Subscribers:
   *   - Rotation module → triggers 3D fallback
   *   - Admin Panel (dialog-admin.tsx) → updates model status display
   */
  Detected: BusEvent.define(
    "ratelimit.detected",
    z.object({
      providerId: z.string(),
      accountId: z.string(),
      modelId: z.string(),
      reason: z.string(), // RateLimitReason
      backoffMs: z.number(),
      source: z.enum(["error-response", "rpm-inference", "rpd-inference", "cockpit"]),
      dailyFailures: z.number(),
      timestamp: z.number(),
    }),
  ),

  /**
   * Fired when a rate limit is cleared (successful request).
   * Subscribers:
   *   - Admin Panel → removes rate limit indicator
   */
  Cleared: BusEvent.define(
    "ratelimit.cleared",
    z.object({
      providerId: z.string(),
      accountId: z.string(),
      modelId: z.string(),
      timestamp: z.number(),
    }),
  ),

  /**
   * Fired when an authentication error is detected (hard stop).
   * Subscribers:
   *   - Admin Panel → shows re-authentication prompt
   */
  AuthFailed: BusEvent.define(
    "ratelimit.auth_failed",
    z.object({
      providerId: z.string(),
      accountId: z.string(),
      modelId: z.string(),
      message: z.string(),
      timestamp: z.number(),
    }),
  ),
}

// ============================================================================
// Provider-specific backoff strategy
// ============================================================================

export type BackoffStrategy = "cockpit" | "counter" | "passive"

/**
 * Determine the backoff detection strategy for a provider.
 * - cockpit: OpenAI — query live quota API for quota-window based backoff
 * - counter: gemini-cli/google-api — use RequestMonitor RPM/RPD counts
 * - passive: everyone else — rely on error response only
 */
export function getBackoffStrategy(providerId: string): BackoffStrategy {
  if (providerId === "openai") return "cockpit"
  if (providerId === "gemini-cli" || providerId === "google-api") return "counter"
  return "passive"
}

// ============================================================================
// Re-exports for convenience (so callers don't need to import rotation.ts)
// ============================================================================

export const isRateLimitError = _isRateLimitError
export const isAuthError = _isAuthError

// ============================================================================
// Minimum backoff guardrails
// ============================================================================

const MODEL_CAPACITY_MIN_BACKOFF_MS = 300_000 // 5 minutes

// ============================================================================
// Judge Result
// ============================================================================

export interface JudgeResult {
  reason: RateLimitReason
  backoffMs: number
  source: "error-response" | "rpm-inference" | "rpd-inference" | "cockpit"
  dailyFailures: number
}

// ============================================================================
// RateLimitJudge namespace — public API
// ============================================================================

export namespace RateLimitJudge {
  /**
   * Analyze an error, classify the rate limit, calculate backoff, update trackers,
   * and broadcast a Bus event — all in one call.
   *
   * This replaces the inline logic previously duplicated across:
   * - llm.ts onError (L342-465)
   * - llm.ts handleRateLimitFallback (L672-833)
   *
   * @returns JudgeResult with the classified reason, calculated backoff, and source
   */
  export async function judge(
    providerId: string,
    accountId: string,
    modelId: string,
    error: unknown,
  ): Promise<JudgeResult> {
    debugCheckpoint("rotation.judge", "judge:start", {
      providerId,
      accountId,
      modelID: modelId,
      errorDetail: serializeErrorForDebug(error),
    })

    // Step 1: Extract reason + retryAfter from error
    const { reason, retryAfterMs } = extractRateLimitDetails(error)

    debugCheckpoint("rotation.judge", "judge:classified", {
      providerId,
      accountId,
      modelID: modelId,
      reason,
      retryAfterMs,
    })

    // Step 2: Increment daily failure counter (resets at 16:00 Taipei)
    const rateLimitTracker = getRateLimitTracker()
    const dailyFailures = rateLimitTracker.incrementDailyFailureCount(accountId, providerId, modelId)

    const consecutiveFailures = getHealthTracker().getConsecutiveFailures(accountId, providerId, modelId)

    // Step 3: Calculate initial backoff
    let backoffMs = calculateBackoffMs(reason, consecutiveFailures, retryAfterMs, dailyFailures)
    let source: JudgeResult["source"] = "error-response"

    // Step 4: Apply provider-specific strategy
    const strategy = getBackoffStrategy(providerId)

    debugCheckpoint("rotation.judge", "judge:strategy", {
      providerId,
      accountId,
      modelID: modelId,
      strategy,
      reason,
      initialBackoffMs: backoffMs,
      dailyFailures,
      consecutiveFailures,
    })

    if (strategy === "cockpit" && reason !== "TOKEN_REFRESH_FAILED") {
      // Cockpit strategy: query real quota reset time from cockpit API
      const cockpitResult = await fetchCockpitBackoff(providerId, accountId, modelId, backoffMs)
      if (cockpitResult.fromCockpit) {
        backoffMs = cockpitResult.backoffMs
        source = "cockpit"
      }
    }

    if (strategy === "counter" || strategy === "passive") {
      // Counter/Passive strategy: infer RPD from RPM stats
      const inference = inferFromRequestLog(providerId, accountId, modelId, reason, backoffMs)
      if (inference.adjusted) {
        backoffMs = inference.backoffMs
        source = inference.source
      }
    }

    // Step 5: Apply guardrails (503/529/capacity minimum 5 minutes)
    if (
      (reason === "SERVICE_UNAVAILABLE_503" ||
        reason === "SITE_OVERLOADED_529" ||
        reason === "MODEL_CAPACITY_EXHAUSTED") &&
      backoffMs < MODEL_CAPACITY_MIN_BACKOFF_MS
    ) {
      backoffMs = MODEL_CAPACITY_MIN_BACKOFF_MS
    }

    // Step 6: Update trackers
    const { Account } = await import("./index")
    await Account.recordRateLimit(accountId, providerId, reason, backoffMs, modelId)

    log.info("Rate limit judged", {
      providerId,
      accountId,
      modelId,
      reason,
      backoffMs,
      source,
      dailyFailures,
      strategy,
    })

    debugCheckpoint("rotation.judge", "judge:result", {
      providerId,
      accountId,
      modelID: modelId,
      reason,
      backoffMs,
      source,
      dailyFailures,
      strategy,
    })

    // Step 7: Broadcast event
    const result: JudgeResult = { reason, backoffMs, source, dailyFailures }

    Bus.publish(RateLimitEvent.Detected, {
      providerId,
      accountId,
      modelId,
      reason,
      backoffMs,
      source,
      dailyFailures,
      timestamp: Date.now(),
    }).catch(() => {})

    return result
  }

  /**
   * Record a successful request — clear rate limit state and broadcast Cleared event.
   *
   * Replaces llm.ts recordSuccess() inline logic.
   */
  export async function recordSuccess(providerId: string, accountId: string, modelId: string): Promise<void> {
    log.info("Recording success", { providerId, accountId, modelId })

    const { Account } = await import("./index")
    await Account.recordSuccess(accountId, providerId)

    // Clear rate limit for this specific 3D vector
    const rateLimitTracker = getRateLimitTracker()
    rateLimitTracker.clear(accountId, providerId, modelId)

    Bus.publish(RateLimitEvent.Cleared, {
      providerId,
      accountId,
      modelId,
      timestamp: Date.now(),
    }).catch(() => {})
  }

  /**
   * Record an authentication failure — hard block + broadcast AuthFailed event.
   *
   * Replaces llm.ts onError auth handling (L303-337).
   */
  export async function recordAuthFailure(
    providerId: string,
    accountId: string,
    modelId: string,
    error: unknown,
  ): Promise<void> {
    log.error("Authentication failure recorded", { providerId, accountId, modelId })

    const { Account } = await import("./index")
    await Account.recordFailure(accountId, providerId)

    // Hard block for 1 hour
    const rateLimitTracker = getRateLimitTracker()
    rateLimitTracker.markRateLimited(accountId, providerId, "AUTH_FAILED", 3_600_000, modelId)

    const errorMessage =
      error instanceof Error ? error.message : typeof error === "string" ? error : "Authentication failed"

    Bus.publish(RateLimitEvent.AuthFailed, {
      providerId,
      accountId,
      modelId,
      message: errorMessage,
      timestamp: Date.now(),
    }).catch(() => {})
  }

  /**
   * Mark a specific 3D vector as rate-limited without going through full judge flow.
   * Used by handleRateLimitFallback when marking current vector before searching for fallback.
   *
   * Steps:
   * 1. Extract reason from error (if provided)
   * 2. Apply provider-specific backoff (cockpit/counter/passive)
   * 3. Update tracker
   * 4. Broadcast event
   *
   * @returns The calculated backoff info
   */
  export async function markRateLimited(
    providerId: string,
    accountId: string,
    modelId: string,
    error?: unknown,
  ): Promise<JudgeResult | null> {
    debugCheckpoint("rotation.judge", "markRateLimited:start", {
      providerId,
      accountId,
      modelID: modelId,
      errorDetail: error ? serializeErrorForDebug(error) : undefined,
    })

    // Check if already marked
    const rateLimitTracker = getRateLimitTracker()
    if (rateLimitTracker.isRateLimited(accountId, providerId, modelId)) {
      debugCheckpoint("rotation.judge", "markRateLimited:skip_already_marked", {
        providerId,
        accountId,
        modelID: modelId,
      })
      return null // Already marked, skip
    }

    let reason: RateLimitReason = "RATE_LIMIT_EXCEEDED"
    let retryAfterMs: number | undefined

    if (error) {
      const details = extractRateLimitDetails(error)
      reason = details.reason
      retryAfterMs = details.retryAfterMs
    }

    // Only mark temporary errors — don't mark permanent errors like "model not found"
    const isTemporary =
      reason === "RATE_LIMIT_EXCEEDED" ||
      reason === "RATE_LIMIT_SHORT" ||
      reason === "RATE_LIMIT_LONG" ||
      reason === "QUOTA_EXHAUSTED" ||
      reason === "SERVICE_UNAVAILABLE_503" ||
      reason === "SITE_OVERLOADED_529" ||
      reason === "MODEL_CAPACITY_EXHAUSTED" ||
      reason === "SERVER_ERROR" ||
      reason === "UNKNOWN"

    if (!isTemporary) {
      log.warn("Not marking as rate-limited: error reason is not temporary", {
        providerId,
        modelId,
        reason,
      })
      debugCheckpoint("rotation.judge", "markRateLimited:skip_not_temporary", {
        providerId,
        accountId,
        modelID: modelId,
        reason,
      })
      return null
    }

    // Calculate backoff
    const dailyFailures = rateLimitTracker.incrementDailyFailureCount(accountId, providerId, modelId)
    const consecutiveFailures = getHealthTracker().getConsecutiveFailures(accountId, providerId, modelId)
    let backoffMs = calculateBackoffMs(reason, consecutiveFailures, retryAfterMs, dailyFailures)
    let source: JudgeResult["source"] = "error-response"

    // Apply provider-specific strategy
    const strategy = getBackoffStrategy(providerId)

    if (strategy === "cockpit" && reason !== "TOKEN_REFRESH_FAILED") {
      const cockpitResult = await fetchCockpitBackoff(providerId, accountId, modelId, backoffMs)
      if (cockpitResult.fromCockpit) {
        backoffMs = cockpitResult.backoffMs
        source = "cockpit"
      }
    }

    if (strategy === "counter" || strategy === "passive") {
      const inference = inferFromRequestLog(providerId, accountId, modelId, reason, backoffMs)
      if (inference.adjusted) {
        backoffMs = inference.backoffMs
        source = inference.source
      }
    }

    // Apply guardrails
    if (
      (reason === "SERVICE_UNAVAILABLE_503" ||
        reason === "SITE_OVERLOADED_529" ||
        reason === "MODEL_CAPACITY_EXHAUSTED") &&
      backoffMs < MODEL_CAPACITY_MIN_BACKOFF_MS
    ) {
      backoffMs = MODEL_CAPACITY_MIN_BACKOFF_MS
    }

    // Mark in tracker
    rateLimitTracker.markRateLimited(accountId, providerId, reason, backoffMs, modelId)

    if (shouldPromoteToProviderCooldown(reason, backoffMs)) {
      const providerCooldownMs = Math.max(backoffMs, PROVIDER_COOLDOWN_MIN_MS)
      log.warn("Promoting to provider-level cooldown", {
        providerId,
        accountId,
        modelId,
        reason,
        providerCooldownMs,
      })
      // Intentionally omit modelId — provider cooldown blocks ALL models for this account/provider.
      rateLimitTracker.markRateLimited(accountId, providerId, reason, providerCooldownMs)
    }

    log.info("Marked current vector as rate-limited", {
      providerId,
      accountId,
      modelId,
      reason,
      backoffMs,
      source,
    })

    debugCheckpoint("rotation.judge", "markRateLimited:result", {
      providerId,
      accountId,
      modelID: modelId,
      reason,
      backoffMs,
      source,
      dailyFailures,
      strategy,
      retryAfterMs,
      consecutiveFailures,
    })

    const result: JudgeResult = { reason, backoffMs, source, dailyFailures }

    // Broadcast event
    Bus.publish(RateLimitEvent.Detected, {
      providerId,
      accountId,
      modelId,
      reason,
      backoffMs,
      source,
      dailyFailures,
      timestamp: Date.now(),
    }).catch(() => {})

    return result
  }
}

// ============================================================================
// Internal: OpenAI live quota strategy
// ============================================================================

/**
 * Query live OpenAI quota state and convert it to a conservative backoff window.
 *
 * This consolidates the cockpit query logic that was previously duplicated
 * 3 times in llm.ts (onError, handleRateLimitFallback×2).
 *
 * The function:
 * 1. Loads account info
 * 2. Reads fresh OpenAI quota state when possible
 * 3. Converts exhausted hourly/weekly windows into a conservative cooldown
 * 4. Returns the quota-sourced backoff or the fallback value
 */
async function fetchCockpitBackoff(
  providerId: string,
  accountId: string,
  modelId: string,
  fallbackBackoffMs: number,
): Promise<{ backoffMs: number; fromCockpit: boolean }> {
  try {
    if (providerId !== "openai") {
      return { backoffMs: fallbackBackoffMs, fromCockpit: false }
    }

    const { getOpenAIQuota } = await import("./quota/openai")
    const quota = await getOpenAIQuota(accountId, { waitFresh: true })
    if (!quota) {
      return { backoffMs: fallbackBackoffMs, fromCockpit: false }
    }

    let backoffMs = fallbackBackoffMs
    let fromCockpit = false

    if (quota.weeklyRemaining <= 0) {
      backoffMs = Math.max(backoffMs, 7 * 24 * 60 * 60 * 1000)
      fromCockpit = true
    } else if (quota.hasHourlyWindow !== false && quota.hourlyRemaining <= 0) {
      backoffMs = Math.max(backoffMs, 5 * 60 * 60 * 1000)
      fromCockpit = true
    }

    if (fromCockpit) {
      log.info("Got backoff from OpenAI quota", {
        providerId,
        accountId,
        modelId,
        backoffMs,
      })
    }

    return { backoffMs, fromCockpit }
  } catch (e) {
    log.warn("Failed to fetch OpenAI quota backoff", {
      providerId,
      accountId,
      modelId,
      error: e instanceof Error ? e.message : String(e),
    })
    return { backoffMs: fallbackBackoffMs, fromCockpit: false }
  }
}

// ============================================================================
// Internal: Counter/Passive strategy (gemini-cli, google-api, others)
// ============================================================================

/**
 * Infer rate limit type from RequestMonitor stats.
 *
 * Logic: If we get a rate limit error but our RPM is well below the RPM limit,
 * it's likely an RPD (daily) violation, not an RPM (per-minute) violation.
 * In that case, set backoff to the next quota day reset (16:00 Taipei).
 *
 * This consolidates the RPD inference logic that was duplicated in:
 * - llm.ts onError (L406-421)
 * - llm.ts handleRateLimitFallback (L799-814)
 */
function inferFromRequestLog(
  providerId: string,
  accountId: string,
  modelId: string,
  reason: RateLimitReason,
  currentBackoffMs: number,
): { backoffMs: number; source: "rpm-inference" | "rpd-inference"; adjusted: boolean } {
  const monitor = RequestMonitor.get()
  const stats = monitor.getStats(providerId, accountId, modelId)
  const limits = monitor.getModelLimits(providerId, modelId)
  const isNotRPMViolation = stats.rpm < limits.rpm

  if (isNotRPMViolation && reason !== "RATE_LIMIT_SHORT") {
    const msUntilReset = getNextQuotaReset() - Date.now()
    const adjustedBackoff = Math.max(msUntilReset, 60_000)

    log.info("Detected RPD violation (RPM below limit), cooling down until quota reset", {
      providerId,
      accountId,
      modelId,
      rpm: stats.rpm,
      rpmLimit: limits.rpm,
      backoffMinutes: Math.round(adjustedBackoff / 60_000),
    })

    return { backoffMs: adjustedBackoff, source: "rpd-inference", adjusted: true }
  }

  return { backoffMs: currentBackoffMs, source: "rpm-inference", adjusted: false }
}

// ============================================================================
// Utility: Format rate limit reason for display
// ============================================================================

export function formatRateLimitReason(reason: RateLimitReason): string {
  switch (reason) {
    case "QUOTA_EXHAUSTED":
      return "Quota exhausted"
    case "RATE_LIMIT_EXCEEDED":
      return "Rate limit exceeded"
    case "RATE_LIMIT_SHORT":
      return "RPM/TPM limit"
    case "RATE_LIMIT_LONG":
      return "Daily limit"
    case "SERVICE_UNAVAILABLE_503":
      return "Service unavailable (503)"
    case "SITE_OVERLOADED_529":
      return "Site overloaded (529)"
    case "MODEL_CAPACITY_EXHAUSTED":
      return "Model at capacity"
    case "SERVER_ERROR":
      return "Server error"
    case "AUTH_FAILED":
      return "Authentication failed"
    case "TOKEN_REFRESH_FAILED":
      return "Token refresh failed"
    default:
      return "Rate limited"
  }
}
