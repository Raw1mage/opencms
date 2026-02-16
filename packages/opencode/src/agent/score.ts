import { type ModelVector, isVectorRateLimited, findFallback, type RotationPurpose } from "../account/rotation3d"
import { loadInstructionJSON } from "../session/instruction-policy"
import { mergeDeep } from "remeda"
import z from "zod"
import { debugCheckpoint } from "@/util/debug"

// Score Interfaces
export interface ModelScore {
  modelID: string
  providerId: string
  score: number
  breakdown: {
    domain: number
    capability: number
    cost: number
  }
}

type Rule = {
  weights: {
    domain: number
    capability: number
    cost: number
  }
  domain: Record<string, Record<string, number>>
  capability: Record<string, number>
  cost: Record<string, number>
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
  const Schema = z.object({
    weights: z
      .object({
        domain: z.number(),
        capability: z.number(),
        cost: z.number(),
      })
      .optional(),
    domain: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    capability: z.record(z.string(), z.number()).optional(),
    cost: z.record(z.string(), z.number()).optional(),
  })

  async function load() {
    return loadInstructionJSON("opencode-model-scoring", Schema)
  }

  async function rules(): Promise<Rule> {
    const data = await load()
    const weights = data?.weights ? { ...WEIGHTS, ...data.weights } : WEIGHTS
    const domain = data?.domain ? mergeDeep(DOMAIN_SCORES, data.domain) : DOMAIN_SCORES
    const capability = data?.capability ? { ...CAPABILITY_SCORES, ...data.capability } : CAPABILITY_SCORES
    const cost = data?.cost ? { ...COST_SCORES, ...data.cost } : COST_SCORES
    return { weights, domain, capability, cost }
  }

  /**
   * Rank models for a specific task domain
   */
  export async function rank(domain: string): Promise<ModelScore[]> {
    const cfg = await rules()
    const key = domain === "explore" ? "reasoning" : domain
    const candidates = new Set([...(Object.keys(cfg.domain[key] || {}) ?? []), ...Object.keys(cfg.capability)])

    const results: ModelScore[] = []

    // Load favorites from model.json to filter candidates
    let allowed: Set<string> | undefined
    try {
      const { Global } = await import("../global")
      const path = await import("path")
      const modelFile = Bun.file(path.join(Global.Path.state, "model.json"))
      if (await modelFile.exists()) {
        const modelData = await modelFile.json()
        const favorites: Array<{ providerId: string; modelID: string }> = modelData.favorite ?? []
        allowed = new Set(favorites.map((f) => `${f.providerId}/${f.modelID}`))
      }
    } catch {
      // Ignore errors reading favorites
    }

    for (const modelKey of candidates) {
      // Skip if not in favorites (unless favorites list is empty/unreadable)
      if (allowed && !allowed.has(modelKey)) continue

      const [providerId, ...rest] = modelKey.split("/")
      const modelID = rest.join("/")

      // Default scores if missing
      const domainScore = cfg.domain[key]?.[modelKey] ?? 70
      const capabilityScore = cfg.capability[modelKey] ?? 70
      const costScore = cfg.cost[modelKey] ?? 50

      const total =
        domainScore * cfg.weights.domain + capabilityScore * cfg.weights.capability + costScore * cfg.weights.cost

      results.push({
        modelID,
        providerId,
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
   * Uses rotation3d for consistent rotation logic across the system
   */
  export async function select(domain: string): Promise<ModelVector | null> {
    const ranking = await rank(domain)
    const { Account } = await import("../account/index")
    const { Provider } = await import("../provider/provider")

    // Get current model preference if any
    const activeModel = await Provider.defaultModel()
    const activeFamily = Account.parseFamily(activeModel.providerId)
    const activeAccountId = activeFamily ? ((await Account.getActive(activeFamily)) ?? "public") : "public"

    const currentVector: ModelVector = {
      providerId: activeModel.providerId,
      modelID: activeModel.modelID,
      accountId: activeAccountId,
    }

    // Use 3D rotation to find the best candidate for this domain/purpose
    const fallback = await findFallback(currentVector, {
      purpose: domain as RotationPurpose,
      strategy: "model-first",
    })

    if (fallback) {
      debugCheckpoint("rotation3d", "Purpose-based selection", {
        domain,
        to: `${fallback.accountId}(${fallback.modelID})`,
        reason: fallback.reason,
      })
      return {
        providerId: fallback.providerId,
        modelID: fallback.modelID,
        accountId: fallback.accountId,
      }
    }

    // Fallback to top ranked if rotation3d didn't find a better match
    for (const candidate of ranking) {
      const family = Account.parseFamily(candidate.providerId)
      if (!family) continue
      const active = await Account.getActive(family)
      if (active) {
        return {
          providerId: candidate.providerId,
          modelID: candidate.modelID,
          accountId: active,
        }
      }
    }

    return null
  }
}
