/**
 * Shared types and time utilities for the rotation system.
 *
 * @event_20260216_rotation_split — extracted from rotation.ts
 */

import { Global } from "../../global"
import path from "path"

// ============================================================================
// File Paths
// ============================================================================

/** Unified state file for all rotation tracking */
export const UNIFIED_STATE_FILE = path.join(Global.Path.state, "rotation-state.json")

/** Legacy file paths (kept for backward compatibility migration) */
export const LEGACY_RATE_LIMITS_FILE = path.join(Global.Path.state, "rate-limits.json")
export const LEGACY_ACCOUNT_HEALTH_FILE = path.join(Global.Path.state, "account-health.json")

// ============================================================================
// Rate Limit Reason
// ============================================================================

export type RateLimitReason =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMIT_EXCEEDED"
  | "RATE_LIMIT_SHORT"
  | "RATE_LIMIT_LONG"
  | "SERVICE_UNAVAILABLE_503"
  | "SITE_OVERLOADED_529"
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "AUTH_FAILED"
  | "TOKEN_REFRESH_FAILED"
  | "UNKNOWN"

// ============================================================================
// State Interfaces
// ============================================================================

/** Health score state for a single account/provider/model */
export interface HealthScoreState {
  score: number
  lastUpdated: number
  lastSuccess: number
  consecutiveFailures: number
}

/** Rate limit state for a single account */
export interface RateLimitState {
  resetTime: number
  reason: RateLimitReason
  model?: string
}

/** Same-provider rotate guard state for a provider */
export interface SameProviderRotationCooldownState {
  until: number
  rotatedAt: number
  fromAccountId: string
  toAccountId: string
  modelID: string
}

/** Unified state structure for cross-process rotation tracking */
export interface UnifiedRotationState {
  version: number
  accountHealth: Record<string, HealthScoreState>
  rateLimits: Record<string, Record<string, RateLimitState>>
  dailyRateLimitCounts: Record<string, { count: number; lastReset: number }>
  sameProviderRotationCooldowns: Record<string, SameProviderRotationCooldownState>
}

// ============================================================================
// Health Score Config
// ============================================================================

export interface HealthScoreConfig {
  initial: number
  successReward: number
  rateLimitPenalty: number
  failurePenalty: number
  recoveryRatePerHour: number
  minUsable: number
  maxScore: number
}

export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
  initial: 70,
  successReward: 1,
  rateLimitPenalty: -10,
  failurePenalty: -20,
  recoveryRatePerHour: 2,
  minUsable: 50,
  maxScore: 100,
}

// ============================================================================
// Account Selection Types
// ============================================================================

export interface AccountCandidate {
  id: string
  lastUsed: number
  healthScore: number
  isRateLimited: boolean
  isCoolingDown?: boolean
}

// ============================================================================
// Error Metadata Type
// ============================================================================

export type ErrorWithMetadata = {
  status?: number
  statusCode?: number
  code?: number | string
  message?: string
  error?: { type?: string }
  type?: string
  headers?: Record<string, string | number | undefined>
  retryAfter?: number | string
}

export function asErrorWithMetadata(error: unknown): ErrorWithMetadata | undefined {
  return error && typeof error === "object" ? (error as ErrorWithMetadata) : undefined
}

// ============================================================================
// Quota Time Utilities
// ============================================================================

/**
 * Get the timestamp of the next quota reset (16:00 Asia/Taipei).
 */
export function getNextQuotaReset(): number {
  const now = new Date()
  const resetHourUTC = 8 // 16:00 Taipei is 08:00 UTC
  const nextReset = new Date(now)
  nextReset.setUTCHours(resetHourUTC, 0, 0, 0)

  if (now.getTime() >= nextReset.getTime()) {
    // Already passed today's reset, next one is tomorrow
    nextReset.setUTCDate(nextReset.getUTCDate() + 1)
  }
  return nextReset.getTime()
}

/**
 * Get the start of the current quota day (16:00 Asia/Taipei = 08:00 UTC).
 * RPD limits reset at this exact time.
 */
export function getQuotaDayStart(): number {
  const now = new Date()
  const resetHourUTC = 8 // 16:00 Taipei is 08:00 UTC
  const todayReset = new Date(now)
  todayReset.setUTCHours(resetHourUTC, 0, 0, 0)

  if (now.getTime() < todayReset.getTime()) {
    // Before 16:00 today, the "day" started at 16:00 yesterday
    const yesterdayReset = new Date(todayReset)
    yesterdayReset.setUTCDate(yesterdayReset.getUTCDate() - 1)
    return yesterdayReset.getTime()
  }
  return todayReset.getTime()
}
