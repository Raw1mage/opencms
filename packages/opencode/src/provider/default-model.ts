import type { Config } from "@/config/config"
import { Account } from "@/account"
import type { Provider } from "./provider"

type ProviderLike = { id: string; models: Record<string, Provider.Model> }

type DefaultModelDeps = {
  cfg: Config.Info
  list: () => Promise<Record<string, ProviderLike>>
  sort: (models: Provider.Model[]) => Provider.Model[]
  parseModel: (model: string) => { providerId: string; modelID: string }
  onSubscriptionSelected?: (input: { provider: string; accountId: string; model: string; healthScore: number }) => void
}

/**
 * Keep default model selection logic isolated from provider registry initialization.
 */
export async function resolveDefaultModel(deps: DefaultModelDeps): Promise<{ providerId: string; modelID: string }> {
  const { cfg, parseModel, list, sort } = deps

  if (cfg.model) return parseModel(cfg.model)

  const subscriptionResult = await selectSubscriptionModel(deps)
  if (subscriptionResult) return subscriptionResult

  const provider = await list()
    .then((val) => Object.values(val))
    .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))

  if (!provider) throw new Error("no providers found")
  const [model] = sort(Object.values(provider.models))
  if (!model) throw new Error("no models found")

  return {
    providerId: provider.id,
    modelID: model.id,
  }
}

async function selectSubscriptionModel(
  deps: DefaultModelDeps,
): Promise<{ providerId: string; modelID: string } | undefined> {
  const { cfg, list, sort, onSubscriptionSelected } = deps
  const { getHealthTracker, getRateLimitTracker } = await import("@/account/rotation")

  const subscriptionPriority = ["opencode", "claude-cli", "openai", "google-api", "github-copilot"]

  const healthTracker = getHealthTracker()
  const rateLimitTracker = getRateLimitTracker()
  const providers = await list()

  for (const family of subscriptionPriority) {
    if (cfg.disabled_providers?.includes(family)) continue

    const accounts = await Account.list(family).catch(() => ({}))
    if (Object.keys(accounts).length === 0) continue

    for (const [accountId, info] of Object.entries(accounts)) {
      if (info.type !== "subscription" && (info.type as string) !== "oauth") continue

      const healthScore = healthTracker.getScore(accountId, family)
      const isRateLimited = rateLimitTracker.isRateLimited(accountId, family)
      if (healthScore < 50 || isRateLimited) continue

      const provider = providers[family]
      if (!provider?.models) continue

      const [model] = sort(Object.values(provider.models))
      if (!model) continue

      onSubscriptionSelected?.({
        provider: family,
        accountId,
        model: model.id,
        healthScore,
      })

      return {
        providerId: family,
        modelID: model.id,
      }
    }
  }

  return undefined
}
