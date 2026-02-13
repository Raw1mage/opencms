import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { Account } from "../../account"
import { Provider } from "../../provider/provider"
import { getHealthTracker, getRateLimitTracker, getModelHealthRegistry } from "../../account/rotation"
import {
  getRotation3DStatus,
  buildFallbackCandidates,
  selectBestFallback,
  type ModelVector,
  type FallbackCandidate,
  DEFAULT_ROTATION3D_CONFIG,
} from "../../account/rotation3d"

// Schema for ModelVector
const ModelVectorSchema = z.object({
  providerId: z.string(),
  accountId: z.string(),
  modelID: z.string(),
})

// Schema for account status
const AccountStatusSchema = z.object({
  id: z.string(),
  provider: z.string(),
  family: z.string(),
  type: z.enum(["subscription", "api", "oauth"]),
  healthScore: z.number(),
  isRateLimited: z.boolean(),
  rateLimitResetAt: z.number().optional(),
  consecutiveFailures: z.number(),
  lastSuccess: z.number().optional(),
})

// Schema for rotation status response
const RotationStatusSchema = z.object({
  accounts: z.array(AccountStatusSchema),
  modelHealth: z.record(
    z.string(),
    z.object({
      healthScore: z.number(),
      isAvailable: z.boolean(),
      lastRateLimit: z.number().optional(),
    }),
  ),
  recommended: z.object({
    dialog: ModelVectorSchema.optional(),
    task: ModelVectorSchema.optional(),
    background: ModelVectorSchema.optional(),
  }),
  timestamp: z.number(),
})

export const RotationRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get rotation status",
        description: "Get real-time status of all accounts, rate limits, and model health for the 3D rotation system.",
        operationId: "rotation.status",
        responses: {
          200: {
            description: "Rotation status",
            content: {
              "application/json": {
                schema: resolver(RotationStatusSchema),
              },
            },
          },
        },
      }),
      async (c) => {
        const healthTracker = getHealthTracker()
        const rateLimitTracker = getRateLimitTracker()
        const modelRegistry = getModelHealthRegistry()

        // Get all accounts with their status
        const accounts: z.infer<typeof AccountStatusSchema>[] = []
        const allFamilies = await Account.listAll()

        for (const [family, familyData] of Object.entries(allFamilies)) {
          for (const [accountId, info] of Object.entries(familyData.accounts)) {
            const healthScore = healthTracker.getScore(accountId, family)
            const isRateLimited = rateLimitTracker.isRateLimited(accountId, family)

            // Determine account type
            let type: "subscription" | "api" | "oauth" = "api"
            if (info.type === "subscription" || (info.type as string) === "oauth") {
              type = info.type === "subscription" ? "subscription" : "oauth"
            }

            accounts.push({
              id: accountId,
              provider: family,
              family,
              type,
              healthScore,
              isRateLimited,
              rateLimitResetAt: isRateLimited
                ? Date.now() + rateLimitTracker.getWaitTime(accountId, family)
                : undefined,
              consecutiveFailures: healthTracker.getConsecutiveFailures(accountId, family),
              lastSuccess: undefined, // Could add if needed
            })
          }
        }

        // Get model health from registry
        const modelHealth: Record<string, { healthScore: number; isAvailable: boolean; lastRateLimit?: number }> = {}
        const registrySnapshot = modelRegistry.getSnapshot()
        for (const [key, data] of registrySnapshot) {
          const typedData = data as { score?: number; lastRateLimit?: number }
          const score = typedData.score ?? 100
          modelHealth[key] = {
            healthScore: score,
            isAvailable: score >= 50,
            lastRateLimit: typedData.lastRateLimit,
          }
        }

        // Get recommended models for different use cases
        const recommended = await getRecommendedModels(accounts)

        return c.json({
          accounts,
          modelHealth,
          recommended,
          timestamp: Date.now(),
        })
      },
    )
    .post(
      "/recommend",
      describeRoute({
        summary: "Get model recommendation",
        description: "Get the best model vector recommendation for a specific task type.",
        operationId: "rotation.recommend",
        responses: {
          200: {
            description: "Recommended model vector",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    vector: ModelVectorSchema.optional(),
                    candidates: z.array(
                      z.object({
                        vector: ModelVectorSchema,
                        score: z.number(),
                        reason: z.string(),
                      }),
                    ),
                    fallbackChain: z.array(ModelVectorSchema),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          taskType: z.enum(["dialog", "task", "background", "coding", "review"]).default("dialog"),
          preferSubscription: z.boolean().default(true),
          currentVector: ModelVectorSchema.optional(),
        }),
      ),
      async (c) => {
        const { taskType, preferSubscription, currentVector } = c.req.valid("json")

        // Get the best model for this task type
        const result = await getRecommendationForTask(taskType, preferSubscription, currentVector)

        return c.json(result)
      },
    )
    .post(
      "/fallback",
      describeRoute({
        summary: "Get fallback for rate-limited model",
        description: "When a model is rate-limited, get the best fallback option.",
        operationId: "rotation.fallback",
        responses: {
          200: {
            description: "Fallback recommendation",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    fallback: ModelVectorSchema.optional(),
                    reason: z.string(),
                    waitTimeMs: z.number().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          current: ModelVectorSchema,
          strategy: z
            .enum(["account-first", "model-first", "provider-first", "any-available"])
            .default("account-first"),
        }),
      ),
      async (c) => {
        const { current, strategy } = c.req.valid("json")

        const candidates = await buildFallbackCandidates(current, {
          ...DEFAULT_ROTATION3D_CONFIG,
          strategy,
        })

        const fallback = selectBestFallback(candidates, current, {
          ...DEFAULT_ROTATION3D_CONFIG,
          strategy,
        })

        if (fallback) {
          return c.json({
            fallback: {
              providerId: fallback.providerId,
              accountId: fallback.accountId,
              modelID: fallback.modelID,
            },
            reason: fallback.reason,
            waitTimeMs: fallback.waitTimeMs,
          })
        }

        return c.json({
          fallback: undefined,
          reason: "no-available-fallback",
          waitTimeMs: undefined,
        })
      },
    ),
)

// Helper: Get recommended models for different use cases
async function getRecommendedModels(accounts: z.infer<typeof AccountStatusSchema>[]) {
  const healthyAccounts = accounts.filter((a) => a.healthScore >= 50 && !a.isRateLimited)
  const subscriptionAccounts = healthyAccounts.filter((a) => a.type === "subscription" || a.type === "oauth")

  // Priority order for dialog model
  const dialogPriority = ["opencode", "claude-cli", "openai", "google-api"]
  // Priority order for background tasks (prefer cheaper)
  const backgroundPriority = ["opencode", "claude-cli", "openai"]

  const recommended: {
    dialog?: ModelVector
    task?: ModelVector
    background?: ModelVector
  } = {}

  // Find best dialog model
  for (const priority of dialogPriority) {
    const account =
      subscriptionAccounts.find((a) => a.provider === priority) || healthyAccounts.find((a) => a.provider === priority)
    if (account) {
      const model = await getDefaultModelForProvider(account.provider)
      if (model) {
        recommended.dialog = {
          providerId: account.provider,
          accountId: account.id,
          modelID: model,
        }
        break
      }
    }
  }

  // For task, use same as dialog or slightly cheaper
  recommended.task = recommended.dialog

  // For background, prefer haiku/mini models
  for (const priority of backgroundPriority) {
    const account =
      subscriptionAccounts.find((a) => a.provider === priority) || healthyAccounts.find((a) => a.provider === priority)
    if (account) {
      const model = await getSmallModelForProvider(account.provider)
      if (model) {
        recommended.background = {
          providerId: account.provider,
          accountId: account.id,
          modelID: model,
        }
        break
      }
    }
  }

  return recommended
}

// Helper: Get default model for a provider
async function getDefaultModelForProvider(providerId: string): Promise<string | undefined> {
  try {
    const providers = await Provider.list()
    const provider = providers[providerId]
    if (!provider?.models) return undefined

    // Priority models by provider
    const modelPriority: Record<string, string[]> = {
      "claude-cli": ["claude-sonnet-4", "claude-opus-4-5", "claude-3-5-sonnet-20241022"],
      openai: ["gpt-4o", "gpt-5", "o3-mini"],
      google: ["gemini-2.0-flash", "gemini-2.5-pro"],
      opencode: ["big-pickle", "claude-sonnet-4"],
    }

    const priorities = modelPriority[providerId] || []
    for (const model of priorities) {
      if (provider.models[model]) return model
    }

    // Fallback to first available
    const models = Object.keys(provider.models)
    return models[0]
  } catch {
    return undefined
  }
}

// Helper: Get small/cheap model for a provider
async function getSmallModelForProvider(providerId: string): Promise<string | undefined> {
  try {
    const providers = await Provider.list()
    const provider = providers[providerId]
    if (!provider?.models) return undefined

    const smallModels: Record<string, string[]> = {
      "claude-cli": ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307"],
      openai: ["gpt-4o-mini", "gpt-3.5-turbo"],
      google: ["gemini-2.0-flash-lite", "gemini-1.5-flash"],
      opencode: ["gpt-5-nano"],
    }

    const priorities = smallModels[providerId] || []
    for (const model of priorities) {
      if (provider.models[model]) return model
    }

    return await getDefaultModelForProvider(providerId)
  } catch {
    return undefined
  }
}

// Helper: Get recommendation for specific task type
async function getRecommendationForTask(taskType: string, preferSubscription: boolean, currentVector?: ModelVector) {
  const allFamilies = await Account.listAll()
  const healthTracker = getHealthTracker()
  const rateLimitTracker = getRateLimitTracker()

  const candidates: Array<{
    vector: ModelVector
    score: number
    reason: string
  }> = []

  // Task type to model tier mapping
  const taskTiers: Record<string, number> = {
    dialog: 1,
    coding: 2,
    review: 2,
    task: 2,
    background: 3,
  }
  const tier = taskTiers[taskType] || 2

  for (const [family, familyData] of Object.entries(allFamilies)) {
    for (const [accountId, info] of Object.entries(familyData.accounts)) {
      const healthScore = healthTracker.getScore(accountId, family)
      const isRateLimited = rateLimitTracker.isRateLimited(accountId, family)

      if (isRateLimited || healthScore < 30) continue

      const isSubscription = info.type === "subscription" || (info.type as string) === "oauth"
      const model = tier === 3 ? await getSmallModelForProvider(family) : await getDefaultModelForProvider(family)

      if (!model) continue

      let score = healthScore

      // Boost subscription accounts if preferred
      if (preferSubscription && isSubscription) {
        score += 50
      }

      // Boost if same provider as current (stickiness)
      if (currentVector && family === currentVector.providerId) {
        score += 20
      }

      candidates.push({
        vector: {
          providerId: family,
          accountId,
          modelID: model,
        },
        score,
        reason: isSubscription ? "subscription" : "api",
      })
    }
  }

  // Sort by score
  candidates.sort((a, b) => b.score - a.score)

  return {
    vector: candidates[0]?.vector,
    candidates: candidates.slice(0, 5),
    fallbackChain: candidates.slice(1, 4).map((c) => c.vector),
  }
}
