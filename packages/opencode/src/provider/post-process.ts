import { mapValues, mergeDeep, omit, pickBy } from "remeda"
import { ProviderTransform } from "./transform"
import { Flag } from "@/flag/flag"

type PostProcessDeps = {
  providers: Record<string, any>
  config: any
  ignoredProviderIDs: Set<string>
  isProviderAllowed: (providerId: string) => boolean
  isModelIgnored: (providerId: string, modelID: string) => boolean
  onProviderDisabled?: (providerId: string) => void
  onProviderStart?: (providerId: string) => void
  onModelError?: (providerId: string, modelID: string, error: unknown) => void
  onProviderPruned?: (providerId: string, modelCount: number) => void
  onProviderReady?: (providerId: string) => void
}

export function postProcessProviders(deps: PostProcessDeps): void {
  const {
    providers,
    config,
    ignoredProviderIDs,
    isProviderAllowed,
    isModelIgnored,
    onProviderDisabled,
    onProviderStart,
    onModelError,
    onProviderPruned,
    onProviderReady,
  } = deps

  for (const [providerId, provider] of Object.entries(providers)) {
    onProviderStart?.(providerId)
    if (!isProviderAllowed(providerId)) {
      onProviderDisabled?.(providerId)
      delete providers[providerId]
      continue
    }

    const configProvider = config.provider?.[providerId]

    for (const [modelID, model] of Object.entries(provider.models as Record<string, any>)) {
      try {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerId === "openrouter" && modelID === "openai/gpt-5-chat")) {
          delete provider.models[modelID]
          continue
        }
        if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) {
          delete provider.models[modelID]
          continue
        }
        if (model.status === "deprecated") {
          delete provider.models[modelID]
          continue
        }
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        ) {
          delete provider.models[modelID]
          continue
        }

        model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !(v as any).disabled),
            (v) => omit(v as any, ["disabled"]),
          )
        }
      } catch (error) {
        onModelError?.(providerId, modelID, error)
        delete provider.models[modelID]
      }
    }

    for (const modelID of Object.keys(provider.models)) {
      if (isModelIgnored(providerId, modelID)) {
        delete provider.models[modelID]
      }
    }

    const count = Object.keys(provider.models).length
    if (count === 0 || ignoredProviderIDs.has(providerId)) {
      onProviderPruned?.(providerId, count)
      delete providers[providerId]
      continue
    }

    onProviderReady?.(providerId)
  }
}
