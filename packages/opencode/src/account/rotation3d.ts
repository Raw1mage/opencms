/**
 * 3D Model Rotation System
 *
 * Generalizes rotation across three dimensions:
 * - Provider: Different API providers (openai, anthropic, google, etc.)
 * - Account: Different accounts within a provider boundary
 * - Model: Different models within a provider
 *
 * When a rate limit is hit on (P1, A1, M1), the system can:
 * 1. Try same model with different account: (P1, A2, M1)
 * 2. Try different model with same account: (P1, A1, M2)
 * 3. Try different provider entirely: (P2, A?, M1-equivalent)
 *
 * The rotation strategy is configurable and can prioritize any dimension.
 */

import { Log } from "../util/log"
import { getRateLimitTracker, getHealthTracker, getSameProviderRotationGuard } from "./rotation"
import { debugCheckpoint } from "../util/debug"
import {
  loadInstructionBlock,
  loadInstructionJSON,
  parseRotationPriorityText,
  type RotationPriorityRule,
} from "../session/instruction-policy"
import z from "zod"

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
  | "account-first" // Try other accounts within the same provider first, then other models, then other providers
  | "model-first" // Try other models first, then other accounts, then other providers
  | "provider-first" // Try other providers first (maximizes diversity)
  | "any-available" // Take first available regardless of dimension

/**
 * Configuration for the 3D rotation system
 */
export interface Rotation3DConfig {
  /** Fallback strategy */
  strategy: FallbackStrategy
  /** Whether rate-limit fallback may stay on same provider */
  allowSameProviderFallback: boolean
  /** Whether to include models from different capability tiers */
  allowTierDowngrade: boolean
  /** Maximum candidates to consider */
  maxCandidates: number
  /** Minimum health score for candidates */
  minHealthScore: number
  /** Provider priority list (first = highest priority) */
  providerPriority: string[]
  /** Score weight per provider priority step */
  providerPriorityWeight: number
  /** Optional ordered rule list for (provider, account, model) */
  priorityRules?: RotationPriorityRule[]
}

export const DEFAULT_ROTATION3D_CONFIG: Rotation3DConfig = {
  strategy: "account-first",
  allowSameProviderFallback: true,
  allowTierDowngrade: true,
  maxCandidates: 50, // Allow many candidates to find a working model
  minHealthScore: 30,
  providerPriority: [],
  providerPriorityWeight: 120,
  priorityRules: undefined,
}

const ROTATION_POLICY_SCHEMA = z.object({
  strategy: z.enum(["account-first", "model-first", "provider-first", "any-available"]).optional(),
  allowSameProviderFallback: z.boolean().optional(),
  allowTierDowngrade: z.boolean().optional(),
  maxCandidates: z.number().int().min(1).max(200).optional(),
  minHealthScore: z.number().min(0).max(100).optional(),
  providerPriority: z.array(z.string()).optional(),
  providerPriorityWeight: z.number().min(0).max(1000).optional(),
  priorityRules: z
    .array(
      z.object({
        providerId: z.string(),
        accountId: z.string().optional(),
        modelID: z.string().optional(),
        providerTokens: z.array(z.string()).optional(),
        accountTokens: z.array(z.string()).optional(),
        modelTokens: z.array(z.string()).optional(),
      }),
    )
    .optional(),
})

const ROTATION_PRIORITY_TEXT_BLOCK = "opencode-rotation-priority"

const ROTATION_POLICY_CACHE_TTL_MS = 10_000
const rotationPolicyCache: { value?: Partial<Rotation3DConfig>; at: number } = { value: undefined, at: 0 }

async function loadRotationPolicyFromInstructions(): Promise<Partial<Rotation3DConfig> | undefined> {
  const jsonBlock = await loadInstructionJSON("opencode-rotation3d", ROTATION_POLICY_SCHEMA)
  if (jsonBlock) return jsonBlock

  const textBlock = await loadInstructionBlock(ROTATION_PRIORITY_TEXT_BLOCK)
  if (!textBlock?.raw) return undefined

  const policy = parseRotationPriorityText(textBlock.raw)
  if (!policy?.rules?.length) return undefined

  return {
    providerPriority: policy.providerPriority ?? [],
    priorityRules: policy.rules,
  }
}

export async function resolveRotation3DConfig(overrides?: Partial<Rotation3DConfig>): Promise<Rotation3DConfig> {
  const now = Date.now()
  if (!rotationPolicyCache.value || now - rotationPolicyCache.at > ROTATION_POLICY_CACHE_TTL_MS) {
    rotationPolicyCache.value = await loadRotationPolicyFromInstructions()
    rotationPolicyCache.at = now
  }

  return {
    ...DEFAULT_ROTATION3D_CONFIG,
    ...rotationPolicyCache.value,
    ...overrides,
  }
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

/**
 * @plans/codex-rotation-hotfix Phase 2 — families whose candidate quota is
 * read from the wham/usage endpoint. `getOpenAIQuotas()` already bundles
 * both openai and codex subscription accounts into one result dict (see
 * packages/opencode/src/account/quota/openai.ts:247-249), so the gate here
 * just has to recognise both families.
 */
export const WHAM_USAGE_FAMILIES = new Set<string>(["openai", "codex"])

export interface QuotaEvaluation {
  exhausted: boolean
  hourlyRemaining?: number
  weeklyRemaining?: number
}

/**
 * Decide whether a candidate's wham/usage-sourced quota is exhausted.
 * Exported so Phase 2 tests can validate the gate without spinning up the
 * full `buildFallbackCandidates` integration harness.
 */
export function evaluateWhamUsageQuota(
  providerId: string,
  accountId: string,
  quotas: Record<string, { hourlyRemaining: number; weeklyRemaining: number } | null | undefined>,
): QuotaEvaluation {
  if (!WHAM_USAGE_FAMILIES.has(providerId)) return { exhausted: false }
  const quota = quotas[accountId]
  if (!quota) return { exhausted: false }
  const exhausted = quota.hourlyRemaining <= 0 || quota.weeklyRemaining <= 0
  return {
    exhausted,
    hourlyRemaining: quota.hourlyRemaining,
    weeklyRemaining: quota.weeklyRemaining,
  }
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
  config: Rotation3DConfig,
  purpose: RotationPurpose = "generic",
): number {
  const strategy = config.strategy
  const isSameProvider = candidate.providerId === current.providerId
  const isSameAccount = candidate.accountId === current.accountId
  const isSameModel = candidate.modelID === current.modelID

  // Base score from health
  let score = candidate.healthScore

  // @spec specs/provider-account-decoupling DD-5 follow-up (2026-05-04)
  // Soft same-family preference: when codex (or any family) hits a 429,
  // prefer rotating to ANOTHER account in the same family before crossing to
  // gemini-cli / anthropic / etc. Replaces the deleted enforceCodexFamilyOnly
  // hard gate with a scoring weight — cross-family fallback is still allowed
  // when same-family is genuinely empty, but it's never picked over a healthy
  // same-family candidate. +1000 dominates the +100..+500 dimension/purpose
  // bonuses below so this preference holds even when the cross-family
  // candidate has a marginally higher healthScore.
  if (isSameProvider && !isSameAccount) {
    score += 1000
  }

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

  // Provider priority weighting (higher = better)
  if (config.providerPriority.length > 0 && config.providerPriorityWeight > 0) {
    const index = config.providerPriority.indexOf(candidate.providerId)
    if (index >= 0) {
      const rankScore = (config.providerPriority.length - index) * config.providerPriorityWeight
      score += rankScore
    }
  }

  // Priority rules weighting (supports fuzzy tokens; more specific rules get larger boost)
  if (config.priorityRules && config.priorityRules.length > 0) {
    const normalizeTokens = (value: string): string[] =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)

    const candidateProviderTokens = normalizeTokens(candidate.providerId)
    const candidateAccountTokens = normalizeTokens(candidate.accountId)
    const candidateModelTokens = normalizeTokens(candidate.modelID)

    for (let i = 0; i < config.priorityRules.length; i++) {
      const rule = config.priorityRules[i]

      const providerTokens = rule.providerTokens ?? normalizeTokens(rule.providerId)
      const accountTokens = rule.accountTokens ?? (rule.accountId ? normalizeTokens(rule.accountId) : undefined)
      const modelTokens = rule.modelTokens ?? (rule.modelID ? normalizeTokens(rule.modelID) : undefined)

      const providerMatch = providerTokens.every((token) => candidateProviderTokens.includes(token))
      if (!providerMatch) continue

      if (accountTokens && !accountTokens.every((token) => candidateAccountTokens.includes(token))) continue
      if (modelTokens && !modelTokens.every((token) => candidateModelTokens.includes(token))) continue

      const specificity = (accountTokens ? 1 : 0) + (modelTokens ? 1 : 0)
      const base = (config.priorityRules.length - i) * 1000
      const specificityBoost = specificity * 250
      score += base + specificityBoost
      break
    }
  }

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
  const sameProviderRotationGuard = getSameProviderRotationGuard()
  // Diagnostic-only: record whether any same-family rotation cooldown is
  // armed for this provider. Historically this returned wait time was used
  // as a hard filter that stripped every same-provider candidate for 5 min
  // after any single rotation, which (with 30+ codex accounts) forced
  // cross-family fallback even when healthy codex accounts were available.
  // Cascade prevention is now owned exclusively by coalesce.ts's per-provider
  // 5s min-interval guard; the +1000 same-family scoring bonus in
  // scoreCandidateByStrategy enforces the "stay on the in-use provider"
  // preference, with cross-family still selectable when same-family is empty.
  const sameProviderRotateWaitMs = sameProviderRotationGuard.getProviderWaitTime(current.providerId)
  let blockedBySameProviderGuard = 0

  // Filter to available candidates
  const available = candidates.filter((c) => {
    const key = makeKey(c)
    // Exclude already-tried vectors
    if (triedKeys?.has(key)) {
      return false
    }

    // Relax health score requirement when switching providers.
    // If we're considering a candidate from a different provider than the
    // current one, prefer any non-rate-limited candidate regardless of
    // its health score. This avoids situations where a provider-wide
    // outage (e.g. github-copilot exhausted) prevents rotation to other
    // providers because their health score hasn't reached the configured
    // threshold yet.
    const meetsHealth = c.providerId === current.providerId ? c.healthScore >= config.minHealthScore : true

    const isExactCurrent =
      c.providerId === current.providerId && c.accountId === current.accountId && c.modelID === current.modelID
    const isSameProviderRotateCandidate =
      c.providerId === current.providerId &&
      !isExactCurrent &&
      (c.accountId !== current.accountId || c.modelID !== current.modelID)

    if (!config.allowSameProviderFallback && isSameProviderRotateCandidate) {
      blockedBySameProviderGuard++
      return false
    }

    return (
      !c.isRateLimited &&
      meetsHealth &&
      // Don't return the exact same vector
      !isExactCurrent
    )
  })

  if (!config.allowSameProviderFallback) {
    debugCheckpoint("rotation3d", "Same-provider fallback disabled; forcing cross-provider fallback", {
      providerId: current.providerId,
      current: makeKey(current),
      blockedCandidates: blockedBySameProviderGuard,
      totalCandidates: candidates.length,
      triedCount: triedKeys?.size ?? 0,
      purpose,
    })
  }

  if (available.length === 0) {
    log.warn("No fallback candidate available; rotation stopped", {
      current: makeKey(current),
      totalCandidates: candidates.length,
      triedCount: triedKeys?.size ?? 0,
      purpose,
      sameProviderRotateWaitMs,
      blockedBySameProviderGuard,
    })
    return null
  }

  // Score and sort
  const scored = available
    .map((c) => ({
      ...c,
      priority: scoreCandidateByStrategy(c, current, config, purpose),
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, config.maxCandidates)

  const best = scored[0]
  if (best) {
    // CHECKPOINT: ivon0829 tracker — fire when rotation selects this account
    if (best.accountId && best.accountId.includes("ivon0829")) {
      debugCheckpoint("syslog.ivon0829", "⚠ ivon0829 selected by rotation3d fallback", {
        from: makeKey(current),
        to: makeKey(best),
        reason: best.reason,
        priority: best.priority,
        healthScore: best.healthScore,
        purpose,
        candidatesCount: candidates.length,
        availableCount: available.length,
        topScored: scored.slice(0, 5).map((c) => ({
          key: makeKey(c),
          priority: c.priority,
          healthScore: c.healthScore,
          reason: c.reason,
        })),
      })
    }

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
      sameProviderRotateWaitMs,
      blockedBySameProviderGuard,
    })
  } else {
    debugCheckpoint("rotation3d", "No fallback available", {
      from: makeKey(current),
      purpose,
      totalCandidates: candidates.length,
      availableCount: available.length,
      triedCount: triedKeys?.size ?? 0,
      sameProviderRotateWaitMs,
      blockedBySameProviderGuard,
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
  const { getOpenAIQuotas } = await import("./openai_quota")
  const path = await import("path")

  const candidates: FallbackCandidate[] = []
  const CROSS_PROVIDER_MODELS_PER_PROVIDER = 3
  const healthTracker = getHealthTracker()
  const rateLimitTracker = getRateLimitTracker()

  let providers: Record<string, any> = {}
  try {
    providers = await Provider.list()
  } catch (e) {
    log.warn("Failed to list providers", { error: e })
  }

  let openaiQuotas: any = {}
  try {
    openaiQuotas = await getOpenAIQuotas()
  } catch (e) {
    log.warn("Failed to get OpenAI quotas for fallback", { error: e })
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

    const quotaEval = evaluateWhamUsageQuota(vector.providerId, vector.accountId, openaiQuotas)
    const isQuotaLimited = quotaEval.exhausted
    if (quotaEval.exhausted) {
      // One line per candidate skip so operators can trace the pool
      // filter decision in the daemon log (AGENTS.md 第一條).
      log.info("rotation candidate skipped — quota exhausted", {
        providerId: vector.providerId,
        accountId: vector.accountId,
        modelID: vector.modelID,
        hourlyRemaining: quotaEval.hourlyRemaining,
        weeklyRemaining: quotaEval.weeklyRemaining,
      })
    }

    const baseWaitTime = rateLimitTracker.getWaitTime(vector.accountId, vector.providerId, vector.modelID)

    return {
      ...vector,
      healthScore: healthTracker.getScore(vector.accountId, vector.providerId),
      isRateLimited:
        rateLimitTracker.isRateLimited(vector.accountId, vector.providerId, vector.modelID) || isQuotaLimited,
      waitTimeMs: baseWaitTime,
      priority: 0,
      reason,
      capabilities: extractCapabilities(model),
    }
  }

  // Per-step counters — surface each rotation phase's hit count so when
  // CodexFamilyExhausted (or any "no fallback") fires, the daemon log
  // shows exactly which step starved the pool.
  const stepCounts = { step1: 0, step2: 0, step3: 0, step3b: 0, step4: 0 }
  const before = () => candidates.length

  // 1. Get all accounts in the same family (same provider, different accounts)
  // Always allowed as it's the same model the user is already using
  const family = await Account.resolveFamily(current.providerId)
  {
    const start = before()
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
    stepCounts.step1 = candidates.length - start
  }

  // 2. Get alternative models from same provider (different model, same account)
  // Use favorites list directly (do not require provider.models listing)
  {
    const start = before()
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
    stepCounts.step2 = candidates.length - start
  }

  // 3. Get favorite models from model.json (different providers)
  // We already loaded modelData for filtering, let's reuse it if possible or just parse again
  const step3Start = candidates.length
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

        const favFamily = await Account.resolveFamily(fav.providerId)
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
              if (tag in candidate.capabilities) {
                ;(candidate.capabilities as Record<string, boolean>)[tag] = true
              }
            }
          }
          candidates.push(candidate)
        }
      }
    }
  } catch (e) {
    log.warn("Failed to read favorites for fallback", { error: e })
  }
  stepCounts.step3 = candidates.length - step3Start

  // 3b. Broaden cross-provider rescue beyond favorites.
  // Favorites remain the strongest signal, but runtime rate-limit fallback must
  // still be able to discover other connected providers (e.g. github-copilot -> openai)
  // even when the operator has not explicitly favorited a model there.
  //
  // @spec specs/provider-account-decoupling DD-1, DD-5
  // Post-refactor the registry only holds family entries. The
  // `providerId === current.providerId` guard now correctly excludes the
  // current family in one shot — no need for the 2026-05-02 hotfix that
  // resolved candidateFamily and skipped same-family duplicates (those
  // duplicates were a symptom of per-account providerIds being registered
  // as separate provider entries, which is gone now).
  const step3bStart = candidates.length
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!providerId || providerId === current.providerId) continue
    if (hiddenProviders.has(providerId)) continue

    const candidateFamily = await Account.resolveFamily(providerId)
    if (!candidateFamily) continue

    const accounts = await Account.list(candidateFamily)
    if (Object.keys(accounts).length === 0) continue

    const models = Provider.sort(Object.values(provider.models ?? {})).filter((model) => model.status !== "deprecated")
    for (const model of models.slice(0, CROSS_PROVIDER_MODELS_PER_PROVIDER)) {
      for (const [accountId] of Object.entries(accounts)) {
        const vector = {
          providerId,
          accountId,
          modelID: model.id,
        }
        if (isHidden(vector)) continue
        candidates.push(enrich(vector, "diff-provider"))
      }
    }
  }

  stepCounts.step3b = candidates.length - step3bStart

  // 4. Get inherent free opencode zen models as rescue fallback
  const step4Start = candidates.length
  const opencodeProvider = providers["opencode"]
  if (opencodeProvider?.models) {
    for (const [modelId, model] of Object.entries(
      opencodeProvider.models as Record<string, { cost: { input: number; output: number } }>,
    )) {
      if (model.cost.input > 0 || model.cost.output > 0) continue

      let accountId = "public"
      const family = await Account.resolveFamily("opencode")
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
  stepCounts.step4 = candidates.length - step4Start

  // Deduplicate by key
  const seen = new Set<string>()
  const unique = candidates.filter((c) => {
    const key = makeKey(c)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // @spec specs/provider-account-decoupling DD-5
  // Pure family equality: candidate.providerId === current.providerId is the
  // ONLY family check we need, and it already happens in the per-step skips
  // above (e.g. step 3b at the top of the cross-provider loop). The legacy
  // enforceCodexFamilyOnly hard-coded "codex never crosses families" via
  // candidate.providerId === "codex" string comparison — that policy is
  // intentionally dropped (DD-5). Codex now follows the same rotation
  // policy as every other family. CodexFamilyExhausted in
  // session/llm.ts:handleRateLimitFallback still fires when findFallback
  // returns null (nothing usable across the WHOLE registry), but that is a
  // genuinely-empty pool, not a string-shape filter.

  log.info("Built fallback candidates", {
    current: makeKey(current),
    total: unique.length,
    available: unique.filter((c) => !c.isRateLimited).length,
    stepCounts,
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
  const fullConfig = await resolveRotation3DConfig(config)
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
