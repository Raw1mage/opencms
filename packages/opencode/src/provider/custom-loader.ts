type CustomLoaderResult = {
  autoload: boolean
  getModel?: unknown
  options?: Record<string, any>
}

type CustomLoader = (provider: any) => Promise<CustomLoaderResult>

type ApplyCustomLoadersDeps = {
  customLoaders: Record<string, CustomLoader>
  disabledProviders: Set<string>
  database: Record<string, any>
  providers: Record<string, any>
  modelLoaders: Record<string, any>
  mergeProvider: (providerId: string, patch: any) => void
  onMissingProvider?: (providerId: string) => void
  onStart?: (providerId: string) => void
  onEnd?: (providerId: string, result?: CustomLoaderResult) => void
}

type ApplyConfigProvidersDeps = {
  configProviders: Array<[string, any]>
  mergeProvider: (providerId: string, patch: any) => void
}

export async function applyCustomLoaders(deps: ApplyCustomLoadersDeps): Promise<void> {
  const {
    customLoaders,
    disabledProviders,
    database,
    providers,
    modelLoaders,
    mergeProvider,
    onMissingProvider,
    onStart,
    onEnd,
  } = deps

  for (const [providerId, fn] of Object.entries(customLoaders)) {
    if (disabledProviders.has(providerId)) continue
    const data = database[providerId]
    if (!data) {
      onMissingProvider?.(providerId)
      continue
    }

    onStart?.(providerId)
    const result = await fn(data)
    onEnd?.(providerId, result)

    if (result && (result.autoload || providers[providerId])) {
      if (result.getModel) modelLoaders[providerId] = result.getModel
      const opts = result.options ?? {}
      const patch = providers[providerId] ? { options: opts } : { source: "custom", options: opts }
      mergeProvider(providerId, patch)
    }
  }
}

export function applyConfigProviders(deps: ApplyConfigProvidersDeps): void {
  const { configProviders, mergeProvider } = deps
  for (const [providerId, provider] of configProviders) {
    const partial: Record<string, unknown> = { source: "config" }
    if (provider.env) partial.env = provider.env
    if (provider.name) partial.name = provider.name
    if (provider.options) partial.options = provider.options
    mergeProvider(providerId, partial)
  }
}
