import type { Config } from "@/config/config"
import { Account } from "@/account"
import type { Provider } from "./provider"
import { Global } from "@/global"
import path from "path"

type ProviderLike = { id: string; models: Record<string, Provider.Model> }

type DefaultModelDeps = {
  cfg: Config.Info
  list: () => Promise<Record<string, ProviderLike>>
  sort: (models: Provider.Model[]) => Provider.Model[]
  parseModel: (model: string) => { providerId: string; modelID: string }
  onSubscriptionSelected?: (input: { provider: string; accountId: string; model: string; healthScore: number }) => void
}

/**
 * Load user-enabled model set from model.json (favorites + recent).
 * Returns a Set of "providerId/modelID" keys, or undefined if file is missing/unreadable.
 */
async function loadEnabledModels(): Promise<Set<string> | undefined> {
  try {
    const modelFile = Bun.file(path.join(Global.Path.state, "model.json"))
    if (!(await modelFile.exists())) return undefined
    const data = await modelFile.json()
    const keys = new Set<string>()
    for (const entry of data.favorite ?? []) {
      if (entry.providerId && entry.modelID) keys.add(`${entry.providerId}/${entry.modelID}`)
    }
    for (const entry of data.recent ?? []) {
      if (entry.providerId && entry.modelID) keys.add(`${entry.providerId}/${entry.modelID}`)
    }
    const hidden = new Set<string>()
    for (const entry of data.hidden ?? []) {
      if (entry.providerId && entry.modelID) hidden.add(`${entry.providerId}/${entry.modelID}`)
    }
    // Remove hidden models from enabled set
    for (const key of hidden) keys.delete(key)
    return keys.size > 0 ? keys : undefined
  } catch {
    return undefined
  }
}

/**
 * Filter provider models to only those the user has enabled (favorites/recent, minus hidden).
 * Falls back to all models if no enabled set is available.
 */
function filterToEnabled(
  providerId: string,
  models: Provider.Model[],
  enabled: Set<string> | undefined,
): Provider.Model[] {
  if (!enabled) return models
  const filtered = models.filter((m) => enabled.has(`${providerId}/${m.id}`))
  return filtered.length > 0 ? filtered : models
}

/**
 * Keep default model selection logic isolated from provider registry initialization.
 */
export async function resolveDefaultModel(deps: DefaultModelDeps): Promise<{ providerId: string; modelID: string }> {
  const { cfg, parseModel, list, sort } = deps

  if (cfg.model) return parseModel(cfg.model)

  const subscriptionResult = await selectSubscriptionModel(deps)
  if (subscriptionResult) return subscriptionResult

  const enabled = await loadEnabledModels()
  const provider = await list()
    .then((val) => Object.values(val))
    .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))

  if (!provider) throw new Error("no providers found")
  const [model] = sort(filterToEnabled(provider.id, Object.values(provider.models), enabled))
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
  const enabled = await loadEnabledModels()

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

      const [model] = sort(filterToEnabled(family, Object.values(provider.models), enabled))
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
