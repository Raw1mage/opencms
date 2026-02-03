/**
 * 3D Model Rotation System
 *
 * Generalizes rotation across three dimensions:
 * - Provider: Different API providers (openai, anthropic, google, etc.)
 * - Account: Different accounts within a provider family
 * - Model: Different models within a provider
 *
 * When a rate limit is hit on (P1, A1, M1), the system can:
 * 1. Try same model with different account: (P1, A2, M1)
 * 2. Try different model with same account: (P1, A1, M2)
 * 3. Try different provider entirely: (P2, A1, M1-equivalent)
 *
 * The rotation strategy is configurable and can prioritize any dimension.
 */

import { Log } from "../util/log"
import { getRateLimitTracker, getHealthTracker } from "./rotation"

const log = Log.create({ service: "rotation3d" })

// ============================================================================
// TYPES
// ============================================================================

/**
 * A point in the 3D model space
 */
export interface ModelVector {
  providerID: string
  accountId: string
  modelID: string
}

/**
 * A candidate for fallback with availability metadata
 */
export interface FallbackCandidate extends ModelVector {
  /** Health score of the account */
  healthScore: number
  /** Whether currently rate limited */
  isRateLimited: boolean
  /** Time until rate limit clears (0 if not limited) */
  waitTimeMs: number
  /** Priority score (higher = better) */
  priority: number
  /** Reason for this candidate */
  reason: "same-model-diff-account" | "diff-model-same-account" | "diff-provider" | "fallback"
}

/**
 * Strategy for fallback selection
 */
export type FallbackStrategy =
  | "account-first" // Try other accounts first, then other models, then other providers
  | "model-first" // Try other models first, then other accounts, then other providers
  | "provider-first" // Try other providers first (maximizes diversity)
  | "any-available" // Take first available regardless of dimension

/**
 * Configuration for the 3D rotation system
 */
export interface Rotation3DConfig {
  /** Fallback strategy */
  strategy: FallbackStrategy
  /** Whether to include models from different capability tiers */
  allowTierDowngrade: boolean
  /** Maximum candidates to consider */
  maxCandidates: number
  /** Minimum health score for candidates */
  minHealthScore: number
}

export const DEFAULT_ROTATION3D_CONFIG: Rotation3DConfig = {
  strategy: "account-first",
  allowTierDowngrade: true,
  maxCandidates: 50, // Allow many candidates to find a working model
  minHealthScore: 30,
}

// ============================================================================
// RATE LIMIT TRACKING (3D)
// ============================================================================

/**
 * Key for tracking rate limits in 3D space
 */
function makeKey(vector: ModelVector): string {
  return `${vector.providerID}:${vector.accountId}:${vector.modelID}`
}

/**
 * Check if a specific (provider, account, model) combination is rate limited
 */
export function isVectorRateLimited(vector: ModelVector): boolean {
  const tracker = getRateLimitTracker()
  return tracker.isRateLimited(vector.accountId, vector.providerID, vector.modelID)
}

/**
 * Get wait time for a specific vector
 */
export function getVectorWaitTime(vector: ModelVector): number {
  const tracker = getRateLimitTracker()
  return tracker.getWaitTime(vector.accountId, vector.providerID, vector.modelID)
}

// ============================================================================
// FALLBACK SELECTION
// ============================================================================

/**
 * Score a fallback candidate based on strategy
 */
function scoreCandidateByStrategy(
  candidate: FallbackCandidate,
  current: ModelVector,
  strategy: FallbackStrategy,
): number {
  const isSameProvider = candidate.providerID === current.providerID
  const isSameAccount = candidate.accountId === current.accountId
  const isSameModel = candidate.modelID === current.modelID

  // Base score from health
  let score = candidate.healthScore

  switch (strategy) {
    case "account-first":
      // Prefer: same model, different account > different model > different provider
      if (isSameModel && !isSameAccount && isSameProvider) score += 300
      else if (isSameProvider && !isSameModel) score += 200
      else if (!isSameProvider) score += 100
      break

    case "model-first":
      // Prefer: different model, same account > different account > different provider
      if (!isSameModel && isSameAccount && isSameProvider) score += 300
      else if (isSameProvider && !isSameAccount) score += 200
      else if (!isSameProvider) score += 100
      break

    case "provider-first":
      // Prefer: different provider > different account > different model
      if (!isSameProvider) score += 300
      else if (isSameProvider && !isSameAccount) score += 200
      else if (isSameProvider && !isSameModel) score += 100
      break

    case "any-available":
      // Just use health score - no dimension preference
      break
  }

  // Penalty for wait time (1 point per second of wait)
  score -= candidate.waitTimeMs / 1000

  return score
}

/**
 * Select the best fallback candidate from a list
 *
 * @param candidates - List of fallback candidates
 * @param current - Current model vector
 * @param config - Rotation configuration
 * @param triedKeys - Set of already-tried "provider:account:model" keys to exclude
 */
export function selectBestFallback(
  candidates: FallbackCandidate[],
  current: ModelVector,
  config: Rotation3DConfig = DEFAULT_ROTATION3D_CONFIG,
  triedKeys?: Set<string>,
): FallbackCandidate | null {
  // Filter to available candidates
  const available = candidates.filter((c) => {
    const key = makeKey(c)
    // Exclude already-tried vectors
    if (triedKeys?.has(key)) {
      return false
    }
    return (
      !c.isRateLimited &&
      c.healthScore >= config.minHealthScore &&
      // Don't return the exact same vector
      !(c.providerID === current.providerID && c.accountId === current.accountId && c.modelID === current.modelID)
    )
  })

  if (available.length === 0) {
    log.warn("No available fallback candidates", {
      current: makeKey(current),
      totalCandidates: candidates.length,
      triedCount: triedKeys?.size ?? 0,
    })
    return null
  }

  // Score and sort
  const scored = available
    .map((c) => ({
      ...c,
      priority: scoreCandidateByStrategy(c, current, config.strategy),
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, config.maxCandidates)

  const best = scored[0]
  if (best) {
    log.info("Selected fallback", {
      from: makeKey(current),
      to: makeKey(best),
      reason: best.reason,
      priority: best.priority,
      healthScore: best.healthScore,
    })
  }

  return best ?? null
}

// ============================================================================
// CANDIDATE GENERATION
// ============================================================================

/**
 * Build fallback candidates from available accounts and models
 */
export async function buildFallbackCandidates(
  current: ModelVector,
  config: Rotation3DConfig = DEFAULT_ROTATION3D_CONFIG,
): Promise<FallbackCandidate[]> {
  const { Account } = await import("./index")
  const { Provider } = await import("../provider/provider")
  const { Global } = await import("../global")
  const path = await import("path")

  const candidates: FallbackCandidate[] = []
  const healthTracker = getHealthTracker()
  const rateLimitTracker = getRateLimitTracker()

  // 1. Get all accounts in the same family (same provider, different accounts)
  const family = Account.parseFamily(current.providerID)
  if (family) {
    const accounts = await Account.list(family)
    for (const [accountId, info] of Object.entries(accounts)) {
      if (accountId === current.accountId) continue

      const vector: ModelVector = {
        providerID: current.providerID,
        accountId,
        modelID: current.modelID,
      }

      candidates.push({
        ...vector,
        healthScore: healthTracker.getScore(accountId),
        isRateLimited: rateLimitTracker.isRateLimited(accountId, current.providerID, current.modelID),
        waitTimeMs: rateLimitTracker.getWaitTime(accountId, current.providerID, current.modelID),
        priority: 0,
        reason: "same-model-diff-account",
      })
    }
  }

  // 2. Get alternative models from same provider (different model, same account)
  try {
    const providers = await Provider.list()
    const currentProvider = providers[current.providerID]
    if (currentProvider?.models) {
      for (const [modelId, model] of Object.entries(currentProvider.models)) {
        if (modelId === current.modelID) continue

        const vector: ModelVector = {
          providerID: current.providerID,
          accountId: current.accountId,
          modelID: modelId,
        }

        candidates.push({
          ...vector,
          healthScore: healthTracker.getScore(current.accountId),
          isRateLimited: rateLimitTracker.isRateLimited(current.accountId, current.providerID, modelId),
          waitTimeMs: rateLimitTracker.getWaitTime(current.accountId, current.providerID, modelId),
          priority: 0,
          reason: "diff-model-same-account",
        })
      }
    }
  } catch (e) {
    log.warn("Failed to get provider models for fallback", { error: e })
  }

  // 3. Get favorite models from model.json (different providers)
  // Try ALL accounts for each favorite, not just the active one
  try {
    const modelFile = Bun.file(path.join(Global.Path.state, "model.json"))
    if (await modelFile.exists()) {
      const modelData = await modelFile.json()
      const favorites: Array<{ providerID: string; modelID: string }> = modelData.favorite ?? []
      const hiddenProviders: string[] = modelData.hiddenProviders ?? []

      for (const fav of favorites) {
        if (hiddenProviders.includes(fav.providerID)) continue

        if (fav.providerID === current.providerID && fav.modelID === current.modelID) continue

        const favFamily = Account.parseFamily(fav.providerID)
        if (!favFamily) continue

        // Get ALL accounts for this provider family, not just the active one
        const accounts = await Account.list(favFamily)
        for (const [accountId, info] of Object.entries(accounts)) {
          const vector: ModelVector = {
            providerID: fav.providerID,
            accountId,
            modelID: fav.modelID,
          }

          candidates.push({
            ...vector,
            healthScore: healthTracker.getScore(accountId),
            isRateLimited: rateLimitTracker.isRateLimited(accountId, fav.providerID, fav.modelID),
            waitTimeMs: rateLimitTracker.getWaitTime(accountId, fav.providerID, fav.modelID),
            priority: 0,
            reason: fav.providerID === current.providerID ? "diff-model-same-account" : "diff-provider",
          })
        }
      }
    }
  } catch (e) {
    log.warn("Failed to read favorites for fallback", { error: e })
  }

  // 4. Get inherent free opencode zen models as rescue fallback
  try {
    const providers = await Provider.list()
    const opencodeProvider = providers["opencode"]
    if (opencodeProvider?.models) {
      for (const [modelId, model] of Object.entries(opencodeProvider.models)) {
        const m = model as any
        // Skip if not free
        if (m.cost.input > 0 || m.cost.output > 0) continue

        // For opencode provider, use "public" or active account if available
        let accountId = "public"
        const family = Account.parseFamily("opencode")
        if (family) {
          const active = await Account.getActive(family)
          if (active) accountId = active
        }

        const vector: ModelVector = {
          providerID: "opencode",
          accountId,
          modelID: modelId,
        }

        // Skip if this IS the current vector
        if (
          vector.providerID === current.providerID &&
          vector.modelID === current.modelID &&
          vector.accountId === current.accountId
        )
          continue

        candidates.push({
          ...vector,
          healthScore: healthTracker.getScore(vector.accountId),
          isRateLimited: rateLimitTracker.isRateLimited(vector.accountId, vector.providerID, vector.modelID),
          waitTimeMs: rateLimitTracker.getWaitTime(vector.accountId, vector.providerID, vector.modelID),
          priority: 0,
          reason: "fallback",
        })
      }
    }
  } catch (e) {
    log.warn("Failed to get zen models for fallback", { error: e })
  }

  // Deduplicate by key
  const seen = new Set<string>()
  const unique = candidates.filter((c) => {
    const key = makeKey(c)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  log.debug("Built fallback candidates", {
    current: makeKey(current),
    totalCandidates: unique.length,
    available: unique.filter((c) => !c.isRateLimited).length,
  })

  return unique
}

// ============================================================================
// HIGH-LEVEL API
// ============================================================================

/**
 * Find the best fallback for a rate-limited model vector.
 * Returns null if no fallback is available.
 *
 * @param current - The current model vector that hit rate limit
 * @param config - Optional rotation configuration
 * @param triedKeys - Set of already-tried "provider:account:model" keys to exclude
 */
export async function findFallback(
  current: ModelVector,
  config?: Partial<Rotation3DConfig>,
  triedKeys?: Set<string>,
): Promise<FallbackCandidate | null> {
  const fullConfig = { ...DEFAULT_ROTATION3D_CONFIG, ...config }
  const candidates = await buildFallbackCandidates(current, fullConfig)
  return selectBestFallback(candidates, current, fullConfig, triedKeys)
}

/**
 * Get the next available model vector, rotating if necessary.
 * Returns the current vector if it's available, otherwise finds a fallback.
 */
export async function getNextAvailableVector(
  current: ModelVector,
  config?: Partial<Rotation3DConfig>,
): Promise<ModelVector | null> {
  // Check if current is available
  if (!isVectorRateLimited(current)) {
    return current
  }

  // Find fallback
  const fallback = await findFallback(current, config)
  if (fallback) {
    return {
      providerID: fallback.providerID,
      accountId: fallback.accountId,
      modelID: fallback.modelID,
    }
  }

  return null
}

/**
 * Get status of all tracked rate limits in 3D space.
 * Useful for debugging and admin UI.
 */
export async function getRotation3DStatus(): Promise<{
  rateLimited: Array<{
    vector: ModelVector
    waitTimeMs: number
  }>
  healthy: Array<{
    accountId: string
    healthScore: number
  }>
}> {
  const { Account } = await import("./index")
  const rateLimitTracker = getRateLimitTracker()
  const healthTracker = getHealthTracker()

  const rateLimited: Array<{ vector: ModelVector; waitTimeMs: number }> = []
  const healthy: Array<{ accountId: string; healthScore: number }> = []

  // Get health scores for all known accounts
  const healthSnapshot = healthTracker.getSnapshot()
  for (const [accountId, data] of healthSnapshot) {
    healthy.push({
      accountId,
      healthScore: data.score,
    })
  }

  return { rateLimited, healthy }
}
