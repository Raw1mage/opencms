/**
 * RateLimitTracker — tracks rate limits per account per provider/model.
 *
 * @event_20260216_rotation_split — extracted from rotation.ts
 */

import { Log } from "../../util/log"
import { readUnifiedState, writeUnifiedState } from "./state"
import { type RateLimitReason, type RateLimitState, getQuotaDayStart } from "./types"

const log = Log.create({ service: "rate-limit-tracker" })

/**
 * Tracks rate limits per account per provider
 * With file persistence for cross-process sync
 */
export class RateLimitTracker {
  // Map: accountId -> provider -> model? -> RateLimitState
  private readonly limits = new Map<string, Map<string, RateLimitState>>()

  /**
   * Persist current state to unified state file for cross-process access.
   * @event_2026-02-06:rotation_unify - Now uses unified rotation-state.json
   */
  private persistToFile(): void {
    const state = readUnifiedState()
    const data: Record<string, Record<string, RateLimitState>> = {}
    for (const [key, providerLimits] of this.limits) {
      data[key] = {}
      for (const [innerKey, limitState] of providerLimits) {
        data[key][innerKey] = limitState
      }
    }
    state.rateLimits = data
    writeUnifiedState(state)
  }

  /**
   * Load state from unified state file (for cross-process sync).
   * @event_2026-02-06:rotation_unify - Now uses unified rotation-state.json
   */
  private loadFromFile(): void {
    const state = readUnifiedState()
    this.limits.clear()
    for (const [key, providerData] of Object.entries(state.rateLimits)) {
      const providerLimits = new Map<string, RateLimitState>()
      for (const [innerKey, limitState] of Object.entries(providerData)) {
        providerLimits.set(innerKey, limitState)
      }
      this.limits.set(key, providerLimits)
    }
  }

  private makeKey(provider: string, accountId: string): string {
    // If accountId already contains provider (legacy), don't double it
    if (accountId.startsWith(`${provider}:`) || accountId.startsWith(`${provider}-`)) return accountId
    return `${provider}:${accountId}`
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

    const key = this.makeKey(provider, accountId)
    const modelKey = model ? `${provider}:${model}` : provider
    const now = Date.now()

    let providerLimits = this.limits.get(key)
    if (!providerLimits) {
      providerLimits = new Map()
      this.limits.set(key, providerLimits)
    }

    providerLimits.set(modelKey, {
      resetTime: now + backoffMs,
      reason,
      model,
    })

    // Persist to file for cross-process access
    this.persistToFile()

    log.info("Account rate limited", {
      provider,
      accountId,
      model,
      reason,
      backoffMs,
      resetAt: new Date(now + backoffMs).toISOString(),
    })
  }

  /**
   * Get absolute daily failure count for a 3D vector, handles 16:00 Taipei reset.
   */
  getDailyFailureCount(accountId: string, provider: string, model?: string): number {
    const state = readUnifiedState()
    const quotaDayStart = getQuotaDayStart()
    const key = model ? `${provider}:${accountId}:${model}` : `${provider}:${accountId}`
    const counter = state.dailyRateLimitCounts[key]

    if (!counter || counter.lastReset < quotaDayStart) {
      return 0
    }
    return counter.count
  }

  /**
   * Increment absolute daily failure count for a 3D vector.
   */
  incrementDailyFailureCount(accountId: string, provider: string, model?: string): number {
    const state = readUnifiedState()
    const quotaDayStart = getQuotaDayStart()
    const now = Date.now()
    const key = model ? `${provider}:${accountId}:${model}` : `${provider}:${accountId}`

    let counter = state.dailyRateLimitCounts[key]
    if (!counter || counter.lastReset < quotaDayStart) {
      counter = { count: 1, lastReset: now }
    } else {
      counter.count++
      counter.lastReset = now
    }

    state.dailyRateLimitCounts[key] = counter
    writeUnifiedState(state)
    return counter.count
  }

  /**
   * Check if an account is rate limited for a provider/model
   */
  isRateLimited(accountId: string, provider: string, model?: string): boolean {
    // Load latest state from file
    this.loadFromFile()
    const key = this.makeKey(provider, accountId)
    this.clearExpired(key)

    const providerLimits = this.limits.get(key)
    if (!providerLimits) return false

    // Model-specific checks must still respect provider-level cooldowns.
    // Provider-wide exhaustion should block every model under that provider/account.
    if (model) {
      const modelKey = `${provider}:${model}`
      const modelLimit = providerLimits.get(modelKey)
      if (modelLimit !== undefined && Date.now() < modelLimit.resetTime) {
        return true
      }
    }

    const providerLimit = providerLimits.get(provider)
    return providerLimit !== undefined && Date.now() < providerLimit.resetTime
  }

  /**
   * Get the active rate-limit reason for a 3D vector, or undefined if not
   * currently rate-limited. Mirrors isRateLimited()'s precedence: a live
   * model-specific entry wins, otherwise the provider-level entry. Used by the
   * rotation event emitter so telemetry reports the *judged* reason
   * (MODEL_CAPACITY_EXHAUSTED, QUOTA_EXHAUSTED, …) instead of collapsing every
   * rotation to a generic RATE_LIMIT_EXCEEDED label.
   */
  getReason(accountId: string, provider: string, model?: string): RateLimitReason | undefined {
    this.loadFromFile()
    const key = this.makeKey(provider, accountId)
    this.clearExpired(key)

    const providerLimits = this.limits.get(key)
    if (!providerLimits) return undefined

    const now = Date.now()
    if (model) {
      const modelLimit = providerLimits.get(`${provider}:${model}`)
      if (modelLimit !== undefined && now < modelLimit.resetTime) return modelLimit.reason
    }

    const providerLimit = providerLimits.get(provider)
    if (providerLimit !== undefined && now < providerLimit.resetTime) return providerLimit.reason

    return undefined
  }

  /**
   * Get remaining wait time for a rate limited account
   */
  getWaitTime(accountId: string, provider: string, model?: string): number {
    // Load latest state from file
    this.loadFromFile()

    const key = this.makeKey(provider, accountId)
    this.clearExpired(key)

    const providerLimits = this.limits.get(key)
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
  clear(accountId: string, provider: string, model?: string): void {
    // Load latest state from file
    this.loadFromFile()

    const key = this.makeKey(provider, accountId)
    const providerLimits = this.limits.get(key)
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
  private clearExpired(key: string): boolean {
    const providerLimits = this.limits.get(key)
    if (!providerLimits) return false

    const now = Date.now()
    let changed = false
    for (const [innerKey, state] of providerLimits) {
      if (now >= state.resetTime) {
        providerLimits.delete(innerKey)
        changed = true
      }
    }

    if (providerLimits.size === 0) {
      this.limits.delete(key)
      changed = true
    }

    if (changed) {
      this.persistToFile()
    }

    return changed
  }

  /**
   * Get a 3D snapshot of all rate limits for dashboard display.
   * Returns array of { accountId, providerId, modelID, waitMs, reason }
   */
  getSnapshot3D(): Array<{
    accountId: string
    providerId: string
    modelID: string | undefined
    waitMs: number
    reason: RateLimitReason
  }> {
    // Load latest state from file
    this.loadFromFile()

    const now = Date.now()
    const result: Array<{
      accountId: string
      providerId: string
      modelID: string | undefined
      waitMs: number
      reason: RateLimitReason
    }> = []

    for (const [key, providerLimits] of this.limits) {
      this.clearExpired(key)

      for (const [innerKey, state] of providerLimits) {
        // Skip expired entries
        if (now >= state.resetTime) continue

        // Parse key: either "provider" or "provider:model"
        const colonIdx = innerKey.indexOf(":")
        const providerId = colonIdx >= 0 ? innerKey.slice(0, colonIdx) : innerKey
        const modelID = colonIdx >= 0 ? innerKey.slice(colonIdx + 1) : state.model

        // accountId might be the compound key provider:accountId
        const accColonIdx = key.indexOf(":")
        const accountId = accColonIdx >= 0 ? key.slice(accColonIdx + 1) : key

        result.push({
          accountId,
          providerId,
          modelID,
          waitMs: state.resetTime - now,
          reason: state.reason,
        })
      }
    }

    return result
  }

  /**
   * Clear every rate limit entry for an account (all models) — e.g. when the
   * account is removed. Without this, deleting an account leaves orphaned
   * rate-limit entries in the persisted rotation state forever.
   */
  clearAccount(accountId: string, provider: string): void {
    this.loadFromFile()
    const key = this.makeKey(provider, accountId)
    if (this.limits.delete(key)) {
      this.persistToFile()
      log.info("Cleared all rate limits for removed account", { provider, accountId })
    }
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
