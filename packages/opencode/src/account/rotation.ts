/**
 * Global Account Rotation System
 *
 * Provider-agnostic account rotation with health scoring and rate limit tracking.
 * Adapted from Antigravity's rotation system for global use across all providers.
 *
 * Key Features:
 * - Health Score: Track account wellness based on success/failure
 * - LRU Selection: Prefer accounts with longest rest periods
 * - Token Bucket: Client-side rate limiting to prevent 429s
 * - Provider-aware: Tracks rate limits per provider family
 */

import { Log } from "../util/log"
import { debugCheckpoint } from "../util/debug"
import { Global } from "../global"
import path from "path"
import fs from "fs"

const log = Log.create({ service: "account-rotation" })

// File path for shared model health state across processes
const HEALTH_FILE = path.join(Global.Path.state, "model-health.json")
// File path for shared rate limit state across processes
const RATE_LIMIT_FILE = path.join(Global.Path.state, "rate-limits.json")

// ============================================================================
// HEALTH SCORE SYSTEM
// ============================================================================

export interface HealthScoreConfig {
  /** Initial score for new accounts (default: 70) */
  initial: number
  /** Points added on successful request (default: 1) */
  successReward: number
  /** Points removed on rate limit (default: -10) */
  rateLimitPenalty: number
  /** Points removed on failure (auth, network, etc.) (default: -20) */
  failurePenalty: number
  /** Points recovered per hour of rest (default: 2) */
  recoveryRatePerHour: number
  /** Minimum score to be considered usable (default: 50) */
  minUsable: number
  /** Maximum score cap (default: 100) */
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

interface HealthScoreState {
  score: number
  lastUpdated: number
  lastSuccess: number
  consecutiveFailures: number
}

/**
 * Tracks health scores for accounts by ID.
 * Higher score = healthier account = preferred for selection.
 */
export class HealthScoreTracker {
  private readonly scores = new Map<string, HealthScoreState>()
  private readonly config: HealthScoreConfig

  constructor(config: Partial<HealthScoreConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_SCORE_CONFIG, ...config }
  }

  /**
   * Get current health score for an account, applying time-based recovery.
   */
  getScore(accountId: string): number {
    const state = this.scores.get(accountId)
    if (!state) {
      return this.config.initial
    }

    // Apply passive recovery based on time since last update
    const now = Date.now()
    const hoursSinceUpdate = (now - state.lastUpdated) / (1000 * 60 * 60)
    const recoveredPoints = Math.floor(hoursSinceUpdate * this.config.recoveryRatePerHour)

    return Math.min(this.config.maxScore, state.score + recoveredPoints)
  }

  /**
   * Record a successful request - improves health score.
   */
  recordSuccess(accountId: string): void {
    const now = Date.now()
    const current = this.getScore(accountId)

    this.scores.set(accountId, {
      score: Math.min(this.config.maxScore, current + this.config.successReward),
      lastUpdated: now,
      lastSuccess: now,
      consecutiveFailures: 0,
    })
  }

  /**
   * Record a rate limit hit - moderate penalty.
   */
  recordRateLimit(accountId: string): void {
    const now = Date.now()
    const state = this.scores.get(accountId)
    const current = this.getScore(accountId)

    this.scores.set(accountId, {
      score: Math.max(0, current + this.config.rateLimitPenalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    })
  }

  /**
   * Record a failure (auth, network, etc.) - larger penalty.
   */
  recordFailure(accountId: string): void {
    const now = Date.now()
    const state = this.scores.get(accountId)
    const current = this.getScore(accountId)

    this.scores.set(accountId, {
      score: Math.max(0, current + this.config.failurePenalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    })
  }

  /**
   * Check if account is healthy enough to use.
   */
  isUsable(accountId: string): boolean {
    return this.getScore(accountId) >= this.config.minUsable
  }

  /**
   * Get consecutive failure count for an account.
   */
  getConsecutiveFailures(accountId: string): number {
    return this.scores.get(accountId)?.consecutiveFailures ?? 0
  }

  /**
   * Reset health state for an account (e.g., after removal).
   */
  reset(accountId: string): void {
    this.scores.delete(accountId)
  }

  /**
   * Get all scores for debugging/logging.
   */
  getSnapshot(): Map<string, { score: number; consecutiveFailures: number }> {
    const result = new Map<string, { score: number; consecutiveFailures: number }>()
    for (const [id] of this.scores) {
      result.set(id, {
        score: this.getScore(id),
        consecutiveFailures: this.getConsecutiveFailures(id),
      })
    }
    return result
  }
}

// ============================================================================
// RATE LIMIT TRACKING
// ============================================================================

export type RateLimitReason =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMIT_EXCEEDED"
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN"

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000] as const
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000
const MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF = 45_000
const MODEL_CAPACITY_EXHAUSTED_JITTER_MAX = 30_000
const SERVER_ERROR_BACKOFF = 20_000
const UNKNOWN_BACKOFF = 60_000
const MIN_BACKOFF_MS = 2_000

function generateJitter(maxJitterMs: number): number {
  return Math.random() * maxJitterMs - maxJitterMs / 2
}

/**
 * Parse rate limit reason from error details
 */
export function parseRateLimitReason(
  reason: string | undefined,
  message: string | undefined,
  status?: number,
): RateLimitReason {
  // Status Code Checks
  if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED"
  if (status === 500) return "SERVER_ERROR"

  // Explicit Reason String
  if (reason) {
    switch (reason.toUpperCase()) {
      case "QUOTA_EXHAUSTED":
        return "QUOTA_EXHAUSTED"
      case "RATE_LIMIT_EXCEEDED":
        return "RATE_LIMIT_EXCEEDED"
      case "MODEL_CAPACITY_EXHAUSTED":
        return "MODEL_CAPACITY_EXHAUSTED"
    }
  }

  // Message Text Scanning
  if (message) {
    const lower = message.toLowerCase()
    if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("resource exhausted")) {
      return "MODEL_CAPACITY_EXHAUSTED"
    }
    if (
      lower.includes("per minute") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests") ||
      lower.includes("token refresh failed")
    ) {
      return "RATE_LIMIT_EXCEEDED"
    }
    if (lower.includes("exhausted") || lower.includes("quota")) {
      return "QUOTA_EXHAUSTED"
    }
  }

  if (status === 429) {
    return "UNKNOWN"
  }

  return "UNKNOWN"
}

/**
 * Calculate backoff time based on rate limit reason
 */
export function calculateBackoffMs(
  reason: RateLimitReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null,
): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.max(retryAfterMs, MIN_BACKOFF_MS)
  }

  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1)
      return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF
    }
    case "RATE_LIMIT_EXCEEDED":
      return RATE_LIMIT_EXCEEDED_BACKOFF
    case "MODEL_CAPACITY_EXHAUSTED":
      return MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF + generateJitter(MODEL_CAPACITY_EXHAUSTED_JITTER_MAX)
    case "SERVER_ERROR":
      return SERVER_ERROR_BACKOFF
    case "UNKNOWN":
    default:
      return UNKNOWN_BACKOFF
  }
}

/**
 * Rate limit state for an account
 */
interface RateLimitState {
  resetTime: number
  reason: RateLimitReason
  model?: string
}

/**
 * Tracks rate limits per account per provider
 * With file persistence for cross-process sync
 */
export class RateLimitTracker {
  // Map: accountId -> provider -> model? -> RateLimitState
  private readonly limits = new Map<string, Map<string, RateLimitState>>()

  /**
   * Persist current state to shared file for cross-process access.
   */
  private persistToFile(): void {
    try {
      const data: Record<string, Record<string, RateLimitState>> = {}
      for (const [accountId, providerLimits] of this.limits) {
        data[accountId] = {}
        for (const [key, state] of providerLimits) {
          data[accountId][key] = state
        }
      }
      fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(data), "utf-8")
    } catch (e) {
      // Ignore write errors
    }
  }

  /**
   * Load state from shared file (for cross-process sync).
   */
  private loadFromFile(): void {
    try {
      if (!fs.existsSync(RATE_LIMIT_FILE)) return
      const content = fs.readFileSync(RATE_LIMIT_FILE, "utf-8")
      const data = JSON.parse(content) as Record<string, Record<string, RateLimitState>>
      this.limits.clear()
      for (const [accountId, providerData] of Object.entries(data)) {
        const providerLimits = new Map<string, RateLimitState>()
        for (const [key, state] of Object.entries(providerData)) {
          providerLimits.set(key, state)
        }
        this.limits.set(accountId, providerLimits)
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  /**
   * Mark an account as rate limited for a provider/model
   */
  markRateLimited(
    accountId: string,
    provider: string,
    reason: RateLimitReason,
    backoffMs: number,
    model?: string,
  ): void {
    // Load latest state from file first
    this.loadFromFile()

    const key = model ? `${provider}:${model}` : provider
    const now = Date.now()

    let providerLimits = this.limits.get(accountId)
    if (!providerLimits) {
      providerLimits = new Map()
      this.limits.set(accountId, providerLimits)
    }

    providerLimits.set(key, {
      resetTime: now + backoffMs,
      reason,
      model,
    })

    // Persist to file for cross-process access
    this.persistToFile()

    log.info("Account rate limited", {
      accountId,
      provider,
      model,
      reason,
      backoffMs,
      resetAt: new Date(now + backoffMs).toISOString(),
    })
  }

  /**
   * Check if an account is rate limited for a provider/model
   */
  isRateLimited(accountId: string, provider: string, model?: string): boolean {
    // Load latest state from file
    this.loadFromFile()
    this.clearExpired(accountId)

    const providerLimits = this.limits.get(accountId)
    if (!providerLimits) return false

    // Check model-specific limit first
    if (model) {
      const modelKey = `${provider}:${model}`
      const modelLimit = providerLimits.get(modelKey)
      if (modelLimit && Date.now() < modelLimit.resetTime) {
        return true
      }
    }

    // Check provider-level limit
    const providerLimit = providerLimits.get(provider)
    if (providerLimit && Date.now() < providerLimit.resetTime) {
      return true
    }

    return false
  }

  /**
   * Get remaining wait time for a rate limited account
   */
  getWaitTime(accountId: string, provider: string, model?: string): number {
    // Load latest state from file
    this.loadFromFile()

    const providerLimits = this.limits.get(accountId)
    if (!providerLimits) return 0

    const now = Date.now()
    let maxWait = 0

    // Check model-specific limit
    if (model) {
      const modelKey = `${provider}:${model}`
      const modelLimit = providerLimits.get(modelKey)
      if (modelLimit) {
        maxWait = Math.max(maxWait, modelLimit.resetTime - now)
      }
    }

    // Check provider-level limit
    const providerLimit = providerLimits.get(provider)
    if (providerLimit) {
      maxWait = Math.max(maxWait, providerLimit.resetTime - now)
    }

    return Math.max(0, maxWait)
  }

  /**
   * Clear rate limit for an account
   */
  clear(accountId: string, provider?: string, model?: string): void {
    // Load latest state from file
    this.loadFromFile()

    if (!provider) {
      this.limits.delete(accountId)
      this.persistToFile()
      return
    }

    const providerLimits = this.limits.get(accountId)
    if (!providerLimits) return

    if (model) {
      providerLimits.delete(`${provider}:${model}`)
    } else {
      providerLimits.delete(provider)
    }

    this.persistToFile()
  }

  /**
   * Clear expired rate limits for an account
   */
  private clearExpired(accountId: string): void {
    const providerLimits = this.limits.get(accountId)
    if (!providerLimits) return

    const now = Date.now()
    for (const [key, state] of providerLimits) {
      if (now >= state.resetTime) {
        providerLimits.delete(key)
      }
    }
  }

  /**
   * Get a 3D snapshot of all rate limits for dashboard display.
   * Returns array of { accountId, providerID, modelID, waitMs, reason }
   */
  getSnapshot3D(): Array<{
    accountId: string
    providerID: string
    modelID: string | undefined
    waitMs: number
    reason: RateLimitReason
  }> {
    // Load latest state from file
    this.loadFromFile()

    const now = Date.now()
    const result: Array<{
      accountId: string
      providerID: string
      modelID: string | undefined
      waitMs: number
      reason: RateLimitReason
    }> = []

    for (const [accountId, providerLimits] of this.limits) {
      for (const [key, state] of providerLimits) {
        // Skip expired entries
        if (now >= state.resetTime) continue

        // Parse key: either "provider" or "provider:model"
        const colonIdx = key.indexOf(":")
        const providerID = colonIdx >= 0 ? key.slice(0, colonIdx) : key
        const modelID = colonIdx >= 0 ? key.slice(colonIdx + 1) : state.model

        result.push({
          accountId,
          providerID,
          modelID,
          waitMs: state.resetTime - now,
          reason: state.reason,
        })
      }
    }

    return result
  }

  /**
   * Clear all rate limits (e.g., on manual reset).
   */
  clearAll(): void {
    this.limits.clear()
    this.persistToFile()
    log.info("All rate limits cleared")
  }
}

// ============================================================================
// ACCOUNT SELECTION
// ============================================================================

export interface AccountCandidate {
  id: string
  lastUsed: number
  healthScore: number
  isRateLimited: boolean
  isCoolingDown?: boolean
}

/** Stickiness bonus added to current account's score to prevent unnecessary switching */
const STICKINESS_BONUS = 150

/** Minimum score advantage required to switch away from current account */
const SWITCH_THRESHOLD = 100

/**
 * Sort accounts by LRU (least recently used first) with health score tiebreaker.
 */
export function sortByLruWithHealth(accounts: AccountCandidate[], minHealthScore: number = 50): AccountCandidate[] {
  return accounts
    .filter((acc) => !acc.isRateLimited && !acc.isCoolingDown && acc.healthScore >= minHealthScore)
    .sort((a, b) => {
      // Primary: LRU (oldest lastUsed first)
      const lruDiff = a.lastUsed - b.lastUsed
      if (lruDiff !== 0) return lruDiff

      // Tiebreaker: higher health score wins
      return b.healthScore - a.healthScore
    })
}

/**
 * Select account using hybrid strategy with stickiness:
 * 1. Filter available accounts (not rate-limited, not cooling down, healthy)
 * 2. Calculate priority score: health (2x) + freshness (0.1x)
 * 3. Apply stickiness bonus to current account
 * 4. Only switch if another account beats current by SWITCH_THRESHOLD
 */
export function selectBestAccount(
  accounts: AccountCandidate[],
  currentAccountId: string | null = null,
  minHealthScore: number = 50,
): string | null {
  const candidates = accounts.filter(
    (acc) => !acc.isRateLimited && !acc.isCoolingDown && acc.healthScore >= minHealthScore,
  )

  if (candidates.length === 0) {
    return null
  }

  const scored = candidates
    .map((acc) => {
      const healthComponent = acc.healthScore * 2 // 0-200
      const secondsSinceUsed = (Date.now() - acc.lastUsed) / 1000
      const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1 // 0-360
      const baseScore = Math.max(0, healthComponent + freshnessComponent)

      // Apply stickiness bonus to current account
      const stickinessBonus = acc.id === currentAccountId ? STICKINESS_BONUS : 0

      return {
        id: acc.id,
        baseScore,
        score: baseScore + stickinessBonus,
        isCurrent: acc.id === currentAccountId,
      }
    })
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (!best) {
    return null
  }

  // If current account is still a candidate, check if switch is warranted
  const currentCandidate = scored.find((s) => s.isCurrent)
  if (currentCandidate && !best.isCurrent) {
    const advantage = best.baseScore - currentCandidate.baseScore
    if (advantage < SWITCH_THRESHOLD) {
      return currentCandidate.id
    }
  }

  return best.id
}

// ============================================================================
// GLOBAL ROTATION API
// ============================================================================

let globalHealthTracker: HealthScoreTracker | null = null
let globalRateLimitTracker: RateLimitTracker | null = null

/**
 * Get the global health score tracker instance.
 */
export function getHealthTracker(): HealthScoreTracker {
  if (!globalHealthTracker) {
    globalHealthTracker = new HealthScoreTracker()
  }
  return globalHealthTracker
}

/**
 * Get the global rate limit tracker instance.
 */
export function getRateLimitTracker(): RateLimitTracker {
  if (!globalRateLimitTracker) {
    globalRateLimitTracker = new RateLimitTracker()
  }
  return globalRateLimitTracker
}

/**
 * Initialize global trackers with custom config.
 */
export function initGlobalTrackers(healthConfig?: Partial<HealthScoreConfig>): void {
  globalHealthTracker = new HealthScoreTracker(healthConfig)
  globalRateLimitTracker = new RateLimitTracker()
}

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
  if (!error || typeof error !== "object") return false

  // Check for explicit 429 status code
  const status = (error as any).status ?? (error as any).statusCode ?? (error as any).code

  // Only treat as rate limit if we have an EXPLICIT 429
  // Do not assume rate limit for errors without a status
  if (status === 429) {
    log.debug("isRateLimitError: matched by status code 429")
    return true
  }

  // If there's no status code at all, don't classify as rate limit
  // This prevents empty errors {} or generic errors from triggering rotation
  if (status === undefined || status === null) {
    return false
  }

  // Check for explicit rate limit message patterns (strict matching)
  const message = (error as any).message ?? ""
  if (typeof message === "string" && message.length > 0) {
    const lower = message.toLowerCase()
    // Only match very specific rate limit patterns, not generic "error" messages
    if (
      lower.includes("429") ||
      lower.includes("rate_limit_exceeded") ||
      lower.includes("too many requests") ||
      lower.includes("token refresh failed")
    ) {
      log.debug("isRateLimitError: matched by message pattern", { message: message.substring(0, 100) })
      return true
    }
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
  const errorObj = error as any
  const status = errorObj?.status ?? errorObj?.statusCode
  const message = errorObj?.message ?? ""
  const reasonHint = errorObj?.error?.type ?? errorObj?.code

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

  return { reason, retryAfterMs }
}

// ============================================================================
// GLOBAL MODEL HEALTH REGISTRY
// ============================================================================

/**
 * Model health state for global tracking across all providers.
 * Used by background tasks (title, summary) to avoid rate-limited models.
 */
interface ModelHealthState {
  available: boolean
  rateLimitedUntil: number
  reason: RateLimitReason
  lastSuccess: number
  consecutiveFailures: number
}

/**
 * Global registry tracking health status of all provider:model combinations.
 * Shared across foreground dialog and background tasks via file persistence.
 */
export class ModelHealthRegistry {
  // Unique instance ID for debugging singleton issues
  private readonly instanceId = Math.random().toString(36).substring(7)
  // Key: "provider:model" -> health state
  private readonly models = new Map<string, ModelHealthState>()

  private makeKey(provider: string, model: string): string {
    return `${provider}:${model}`
  }

  /**
   * Persist current state to shared file for cross-process access.
   */
  private persistToFile(): void {
    try {
      const data: Record<string, ModelHealthState> = {}
      for (const [key, state] of this.models) {
        data[key] = state
      }
      fs.writeFileSync(HEALTH_FILE, JSON.stringify(data), "utf-8")
    } catch (e) {
      // Ignore write errors
    }
  }

  /**
   * Load state from shared file (for cross-process sync).
   */
  private loadFromFile(): void {
    try {
      if (!fs.existsSync(HEALTH_FILE)) return
      const content = fs.readFileSync(HEALTH_FILE, "utf-8")
      const data = JSON.parse(content) as Record<string, ModelHealthState>
      this.models.clear()
      for (const [key, state] of Object.entries(data)) {
        this.models.set(key, state)
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  /**
   * Mark a model as rate limited.
   */
  markRateLimited(provider: string, model: string, reason: RateLimitReason, backoffMs: number): void {
    // Load latest state from file first (other process may have updated)
    this.loadFromFile()

    const key = this.makeKey(provider, model)
    const now = Date.now()
    const existing = this.models.get(key)

    this.models.set(key, {
      available: false,
      rateLimitedUntil: now + backoffMs,
      reason,
      lastSuccess: existing?.lastSuccess ?? 0,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
    })

    // Persist to file for cross-process access
    this.persistToFile()

    log.info("Model marked rate limited", {
      provider,
      model,
      reason,
      backoffMs,
      resetAt: new Date(now + backoffMs).toISOString(),
    })
  }

  /**
   * Mark a model as successfully used.
   */
  markSuccess(provider: string, model: string): void {
    // Load latest state from file first (other process may have updated)
    this.loadFromFile()

    const key = this.makeKey(provider, model)
    const now = Date.now()

    debugCheckpoint("health", "registry.markSuccess.before", {
      instanceId: this.instanceId,
      provider,
      model,
      key,
      currentSize: this.models.size,
    })

    this.models.set(key, {
      available: true,
      rateLimitedUntil: 0,
      reason: "UNKNOWN",
      lastSuccess: now,
      consecutiveFailures: 0,
    })

    // Persist to file for cross-process access
    this.persistToFile()

    debugCheckpoint("health", "registry.markSuccess.after", {
      instanceId: this.instanceId,
      provider,
      model,
      key,
      newSize: this.models.size,
    })

    log.info("Model marked success", {
      provider,
      model,
      key,
      totalModelsTracked: this.models.size,
    })
  }

  /**
   * Check if a model is currently available (not rate limited).
   */
  isAvailable(provider: string, model: string): boolean {
    // Load latest state from file (other process may have updated)
    this.loadFromFile()

    const key = this.makeKey(provider, model)
    const state = this.models.get(key)

    // Unknown model is assumed available
    if (!state) return true

    // Check if rate limit has expired
    if (state.rateLimitedUntil > 0 && Date.now() < state.rateLimitedUntil) {
      return false
    }

    return true
  }

  /**
   * Get remaining wait time until a model is available.
   */
  getWaitTime(provider: string, model: string): number {
    // Load latest state from file (other process may have updated)
    this.loadFromFile()

    const key = this.makeKey(provider, model)
    const state = this.models.get(key)

    if (!state || state.rateLimitedUntil === 0) return 0

    const remaining = state.rateLimitedUntil - Date.now()
    return Math.max(0, remaining)
  }

  /**
   * Get all available models from a list of candidates.
   */
  filterAvailable(candidates: Array<{ provider: string; model: string }>): Array<{ provider: string; model: string }> {
    return candidates.filter((c) => this.isAvailable(c.provider, c.model))
  }

  /**
   * Get health snapshot for debugging.
   */
  getSnapshot(): Map<string, { available: boolean; waitMs: number; reason: RateLimitReason }> {
    // Load latest state from file (other process may have updated)
    this.loadFromFile()

    const result = new Map<string, { available: boolean; waitMs: number; reason: RateLimitReason }>()
    const now = Date.now()

    debugCheckpoint("health", "registry.getSnapshot", {
      instanceId: this.instanceId,
      modelsCount: this.models.size,
      keys: Array.from(this.models.keys()),
    })

    log.debug("getSnapshot called", { modelsCount: this.models.size })

    for (const [key, state] of this.models) {
      const waitMs = state.rateLimitedUntil > now ? state.rateLimitedUntil - now : 0
      result.set(key, {
        available: waitMs === 0,
        waitMs,
        reason: state.reason,
      })
    }

    return result
  }

  /**
   * Clear rate limit for a specific model.
   */
  clear(provider: string, model: string): void {
    this.loadFromFile()
    const key = this.makeKey(provider, model)
    this.models.delete(key)
    this.persistToFile()
  }

  /**
   * Clear all rate limits (e.g., on restart).
   */
  clearAll(): void {
    this.models.clear()
    this.persistToFile()
  }
}

// Use globalThis to ensure true singleton across all module loads
const REGISTRY_KEY = Symbol.for("opencode.modelHealthRegistry")

/**
 * Get the global model health registry instance.
 * Uses Symbol.for to ensure singleton across module boundaries.
 */
export function getModelHealthRegistry(): ModelHealthRegistry {
  const g = globalThis as any
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new ModelHealthRegistry()
    debugCheckpoint("health", "registry.create", {
      message: "Created new ModelHealthRegistry singleton (globalThis)",
      instanceId: (g[REGISTRY_KEY] as any).instanceId,
    })
  }
  return g[REGISTRY_KEY]
}
