import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { type ModelVector } from "../account/rotation3d"
import { getRateLimitTracker, getHealthTracker } from "../account/rotation"

// Score Interfaces
export interface ModelScore {
  modelID: string
  providerID: string
  score: number
  breakdown: {
    domain: number
    capability: number
    cost: number
  }
}

// Configuration for scoring
const WEIGHTS = {
  domain: 0.4,
  capability: 0.3,
  cost: 0.3,
}

// Hardcoded scores from AGENTS.md (can be moved to a loader later)
const DOMAIN_SCORES: Record<string, Record<string, number>> = {
  coding: {
    "openai/gpt-5.2-codex": 100,
    "anthropic/claude-opus-4-5": 90,
    "google/gemini-2.5-pro": 85,
    "google/gemini-3-pro-preview": 80,
    "anthropic/claude-sonnet-4-5": 95,
  },
  review: {
    "openai/gpt-5.2-codex": 90,
    "anthropic/claude-opus-4-5": 95,
    "google/gemini-2.5-pro": 85,
    "google/gemini-3-pro-preview": 80,
    "anthropic/claude-sonnet-4-5": 90,
  },
  testing: {
    "openai/gpt-5.2-codex": 95,
    "anthropic/claude-opus-4-5": 90,
    "google/gemini-2.5-pro": 85,
    "google/gemini-3-pro-preview": 80,
    "anthropic/claude-sonnet-4-5": 90,
  },
  docs: {
    "openai/gpt-5.2-codex": 80,
    "anthropic/claude-opus-4-5": 100,
    "google/gemini-2.5-pro": 85,
    "google/gemini-3-pro-preview": 80,
    "anthropic/claude-sonnet-4-5": 95,
  },
}

const CAPABILITY_SCORES: Record<string, number> = {
  "openai/gpt-5.2-codex": 95,
  "anthropic/claude-opus-4-5": 98,
  "google/gemini-2.5-pro": 90,
  "google/gemini-3-pro-preview": 95,
  "anthropic/claude-sonnet-4-5": 92,
}

const COST_SCORES: Record<string, number> = {
  "google/gemini-2.5-pro": 90,
  "google/gemini-3-pro-preview": 80,
  "anthropic/claude-sonnet-4-5": 70,
  "openai/gpt-5.2-codex": 60,
  "anthropic/claude-opus-4-5": 50,
}

export namespace ModelScoring {
  /**
   * Rank models for a specific task domain
   */
  export async function rank(domain: string): Promise<ModelScore[]> {
    const candidates = new Set([...Object.keys(DOMAIN_SCORES[domain] || {}), ...Object.keys(CAPABILITY_SCORES)])

    const results: ModelScore[] = []

    for (const modelKey of candidates) {
      const [providerID, ...rest] = modelKey.split("/")
      const modelID = rest.join("/")

      // Default scores if missing
      const domainScore = DOMAIN_SCORES[domain]?.[modelKey] ?? 70
      const capabilityScore = CAPABILITY_SCORES[modelKey] ?? 70
      const costScore = COST_SCORES[modelKey] ?? 50

      const total = domainScore * WEIGHTS.domain + capabilityScore * WEIGHTS.capability + costScore * WEIGHTS.cost

      results.push({
        modelID,
        providerID,
        score: total,
        breakdown: {
          domain: domainScore,
          capability: capabilityScore,
          cost: costScore,
        },
      })
    }

    return results.sort((a, b) => b.score - a.score)
  }

  /**
   * Select the best available model for a task
   */
  export async function select(domain: string): Promise<ModelVector | null> {
    const ranking = await rank(domain)
    const rateLimitTracker = getRateLimitTracker()
    const healthTracker = getHealthTracker()
    const { Account } = await import("../account/index")

    for (const candidate of ranking) {
      // Find active account for this provider
      const family = Account.parseFamily(candidate.providerID)
      if (!family) continue

      const accounts = await Account.list(family).catch(() => ({}))

      // Check each account for availability
      for (const [accountId, _] of Object.entries(accounts)) {
        // Skip if unhealthy
        if (healthTracker.getScore(accountId) < 30) continue

        // Skip if rate limited
        if (rateLimitTracker.isRateLimited(accountId, candidate.providerID, candidate.modelID)) continue

        return {
          providerID: candidate.providerID,
          modelID: candidate.modelID,
          accountId,
        }
      }
    }

    // If no specific ranking match found, fallback to defaults
    return null
  }
}
