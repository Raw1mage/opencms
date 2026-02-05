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
import { debugCheckpoint } from "../util/debug"

const log = Log.create({ service: "rotation3d" })

// ============================================================================
// TYPES
// ============================================================================

/**
 * A point in the 3D model space
 */
export interface ModelVector {
  providerId: string
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
  reason: "same-model-diff-account" | "diff-model-same-account" | "diff-provider" | "fallback" | "capability" | "task"
  /** Original vector this is a fallback for */
  from?: ModelVector
  /** Special capabilities of this model from metadata */
  capabilities?: {
    image?: boolean
    audio?: boolean
    video?: boolean
    reasoning?: boolean
    pdf?: boolean
    coding?: boolean
    longContext?: boolean
  }
}

/**
 * Purpose of the rotation
 */
export type RotationPurpose = "coding" | "reasoning" | "image" | "docs" | "audio" | "video" | "long-context" | "generic"

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
  return `${vector.providerId}:${vector.accountId}:${vector.modelID}`
}

/**
 * Check if a specific (provider, account, model) combination is rate limited
 */
export function isVectorRateLimited(vector: ModelVector): boolean {
  const tracker = getRateLimitTracker()
  return tracker.isRateLimited(vector.accountId, vector.providerId, vector.modelID)
}

/**
 * Get wait time for a specific vector
 */
export function getVectorWaitTime(vector: ModelVector): number {
  const tracker = getRateLimitTracker()
  return tracker.getWaitTime(vector.accountId, vector.providerId, vector.modelID)
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
  purpose: RotationPurpose = "generic",
): number {
  const isSameProvider = candidate.providerId === current.providerId
  const isSameAccount = candidate.accountId === current.accountId
  const isSameModel = candidate.modelID === current.modelID

  // Base score from health
  let score = candidate.healthScore

  // 1. Dimension Score (Account/Model/Provider)
  switch (strategy) {
    case "account-first":
      if (isSameModel && !isSameAccount && isSameProvider) score += 300
      else if (isSameProvider && !isSameModel) score += 200
      else if (!isSameProvider) score += 100
      break
    case "model-first":
      if (!isSameModel && isSameAccount && isSameProvider) score += 300
      else if (isSameProvider && !isSameAccount) score += 200
      else if (!isSameProvider) score += 100
      break
    case "provider-first":
      if (!isSameProvider) score += 300
      else if (isSameProvider && !isSameAccount) score += 200
      else if (isSameProvider && !isSameModel) score += 100
      break
    case "any-available":
      break
  }

  // 2. Purpose Weighting (Phase 2)
  // If the candidate matches the requested purpose, give it a significant boost
  if (purpose !== "generic") {
    let purposeMatch = false
    const caps = candidate.capabilities
    if (caps) {
      switch (purpose) {
        case "coding":
          purposeMatch = !!caps.coding
          break
        case "reasoning":
          purposeMatch = !!caps.reasoning
          break
        case "image":
          purposeMatch = !!caps.image
          break
        case "docs":
          purposeMatch = !!caps.longContext || !!caps.pdf
          break
        case "long-context":
          purposeMatch = !!caps.longContext
          break
        case "audio":
          purposeMatch = !!caps.audio
          break
        case "video":
          purposeMatch = !!caps.video
          break
      }
    }

    if (purposeMatch) {
      score += 500 // Significant boost for matching purpose
    }
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
  purpose: RotationPurpose = "generic",
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
      !(c.providerId === current.providerId && c.accountId === current.accountId && c.modelID === current.modelID)
    )
  })

  if (available.length === 0) {
    log.warn("No available fallback candidates", {
      current: makeKey(current),
      totalCandidates: candidates.length,
      triedCount: triedKeys?.size ?? 0,
      purpose,
    })
    return null
  }

  // Score and sort
  const scored = available
    .map((c) => ({
      ...c,
      priority: scoreCandidateByStrategy(c, current, config.strategy, purpose),
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, config.maxCandidates)

  const best = scored[0]
  if (best) {
    best.from = current
    log.info("Selected fallback", {
      from: makeKey(current),
      to: makeKey(best),
      reason: best.reason,
      priority: best.priority,
      healthScore: best.healthScore,
      purpose,
    })
    debugCheckpoint("rotation3d", "Fallback selected", {
      from: makeKey(current),
      to: makeKey(best),
      reason: best.reason,
      priority: best.priority,
      healthScore: best.healthScore,
      purpose,
      candidatesCount: candidates.length,
      availableCount: available.length,
      triedCount: triedKeys?.size ?? 0,
    })
  } else {
    debugCheckpoint("rotation3d", "No fallback available", {
      from: makeKey(current),
      purpose,
      totalCandidates: candidates.length,
      availableCount: available.length,
      triedCount: triedKeys?.size ?? 0,
      reasons: available
        .map((c) => ({
          key: makeKey(c),
          isRateLimited: c.isRateLimited,
          healthScore: c.healthScore,
        }))
        .slice(0, 5), // log top 5 rejections
    })
  }

  return best ?? null
}

// ============================================================================
// CANDIDATE GENERATION
// ============================================================================

/**
 * Extract capabilities from a provider model info
 */
function extractCapabilities(model: any): FallbackCandidate["capabilities"] {
  if (!model) return {}
  const modalities = model.modalities || { input: [], output: [] }
  const id = (model.id || "").toLowerCase()

  return {
    image: modalities.input.includes("image"),
    audio: modalities.input.includes("audio"),
    video: modalities.input.includes("video"),
    pdf: modalities.input.includes("pdf"),
    reasoning: !!model.reasoning || id.includes("deepseek-r") || id.includes("o1") || id.includes("o3"),
    coding: id.includes("codex") || id.includes("coder") || id.includes("coding"),
    longContext: (model.limit?.context || 0) >= 128000,
  }
}

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

  let providers: Record<string, any> = {}
  try {
    providers = await Provider.list()
  } catch (e) {
    log.warn("Failed to list providers", { error: e })
  }

  // Load favorites/hidden sets for filtering
  let allowedModels = new Set<string>()
  let hiddenModels = new Set<string>()
  let hiddenProviders = new Set<string>()
  try {
    const modelFile = Bun.file(path.join(Global.Path.state, "model.json"))
    if (await modelFile.exists()) {
      const modelData = await modelFile.json()
      const favorites: Array<{ providerId: string; modelID: string }> = modelData.favorite ?? []
      const hidden: Array<{ providerId: string; modelID: string }> = modelData.hidden ?? []
      const hiddenProviderList: string[] = modelData.hiddenProviders ?? []
      allowedModels = new Set(favorites.map((f) => `${f.providerId}/${f.modelID}`))
      hiddenModels = new Set(hidden.map((h) => `${h.providerId}/${h.modelID}`))
      hiddenProviders = new Set(hiddenProviderList)
    }
  } catch (e) {
    log.warn("Failed to read favorites for filtering", { error: e })
  }

  const isHidden = (vector: ModelVector) =>
    hiddenProviders.has(vector.providerId) || hiddenModels.has(`${vector.providerId}/${vector.modelID}`)

  // Helper to enrich candidate with capabilities
  const enrich = (vector: ModelVector, reason: FallbackCandidate["reason"]): FallbackCandidate => {
    const model = providers[vector.providerId]?.models?.[vector.modelID]
    return {
      ...vector,
      healthScore: healthTracker.getScore(vector.accountId),
      isRateLimited: rateLimitTracker.isRateLimited(vector.accountId, vector.providerId, vector.modelID),
      waitTimeMs: rateLimitTracker.getWaitTime(vector.accountId, vector.providerId, vector.modelID),
      priority: 0,
      reason,
      capabilities: extractCapabilities(model),
    }
  }

  // 1. Get all accounts in the same family (same provider, different accounts)
  // Always allowed as it's the same model the user is already using
  const family = Account.parseFamily(current.providerId)
  if (family) {
    const accounts = await Account.list(family)
    for (const [accountId, info] of Object.entries(accounts)) {
      if (accountId === current.accountId) continue
      const vector = {
        providerId: current.providerId,
        accountId,
        modelID: current.modelID,
      }
      if (isHidden(vector)) continue
      candidates.push(enrich(vector, "same-model-diff-account"))
    }
  }

  // 2. Get alternative models from same provider (different model, same account)
  // Use favorites list directly (do not require provider.models listing)
  for (const fav of allowedModels) {
    const [providerId, modelId] = fav.split("/")
    if (providerId !== current.providerId) continue
    if (modelId === current.modelID) continue

    const vector = {
      providerId: current.providerId,
      accountId: current.accountId,
      modelID: modelId,
    }
    if (isHidden(vector)) continue
    candidates.push(enrich(vector, "diff-model-same-account"))
  }

  // 3. Get favorite models from model.json (different providers)
  // We already loaded modelData for filtering, let's reuse it if possible or just parse again
  try {
    const modelFile = Bun.file(path.join(Global.Path.state, "model.json"))
    if (await modelFile.exists()) {
      const modelData = await modelFile.json()
      const favorites: Array<{ providerId: string; modelID: string; tags?: string[] }> = modelData.favorite ?? []
      const hiddenProviders: string[] = modelData.hiddenProviders ?? []
      const hidden: Array<{ providerId: string; modelID: string }> = modelData.hidden ?? []
      const hiddenModelKeys = new Set(hidden.map((h) => `${h.providerId}/${h.modelID}`))

      for (const fav of favorites) {
        if (!fav.providerId) continue
        if (hiddenProviders.includes(fav.providerId)) continue
        if (hiddenModelKeys.has(`${fav.providerId}/${fav.modelID}`)) continue
        if (fav.providerId === current.providerId && fav.modelID === current.modelID) continue

        const favFamily = Account.parseFamily(fav.providerId)
        if (!favFamily) continue

        const accounts = await Account.list(favFamily)
        for (const [accountId, info] of Object.entries(accounts)) {
          const vector = {
            providerId: fav.providerId,
            accountId,
            modelID: fav.modelID,
          }
          if (isHidden(vector)) continue
          const candidate = enrich(
            vector,
            fav.providerId === current.providerId ? "diff-model-same-account" : "diff-provider",
          )

          // Apply manual tags if present
          if (fav.tags && candidate.capabilities) {
            for (const tag of fav.tags) {
              // @ts-ignore
              candidate.capabilities[tag] = true
            }
          }
          candidates.push(candidate)
        }
      }
    }
  } catch (e) {
    log.warn("Failed to read favorites for fallback", { error: e })
  }

  // 4. Get inherent free opencode zen models as rescue fallback
  const opencodeProvider = providers["opencode"]
  if (opencodeProvider?.models) {
    for (const [modelId, model] of Object.entries(opencodeProvider.models)) {
      const m = model as any
      if (m.cost.input > 0 || m.cost.output > 0) continue

      let accountId = "public"
      const family = Account.parseFamily("opencode")
      if (family) {
        const active = await Account.getActive(family)
        if (active) accountId = active
      }

      const vector: ModelVector = { providerId: "opencode", accountId, modelID: modelId }
      if (isHidden(vector)) continue
      if (
        vector.providerId === current.providerId &&
        vector.modelID === current.modelID &&
        vector.accountId === current.accountId
      )
        continue

      candidates.push(enrich(vector, "fallback"))
    }
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
 */
export async function findFallback(
  current: ModelVector,
  config?: Partial<Rotation3DConfig> & { purpose?: RotationPurpose },
  triedKeys?: Set<string>,
): Promise<FallbackCandidate | null> {
  const fullConfig = { ...DEFAULT_ROTATION3D_CONFIG, ...config }
  const candidates = await buildFallbackCandidates(current, fullConfig)
  return selectBestFallback(candidates, current, fullConfig, triedKeys, config?.purpose || "generic")
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
      providerId: fallback.providerId,
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
