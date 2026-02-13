import { mergeDeep } from "remeda"

type CreateProviderStateHelpersDeps = {
  disabledProviders: Set<string>
  database: Record<string, any>
  providers: Record<string, any>
}

export function createProviderStateHelpers(deps: CreateProviderStateHelpersDeps) {
  const { disabledProviders, database, providers } = deps

  function isProviderAllowed(providerId: string): boolean {
    return !disabledProviders.has(providerId)
  }

  function mergeProvider(providerId: string, provider: any) {
    const existing = providers[providerId]
    if (existing) {
      providers[providerId] = mergeDeep(existing, provider)
      return
    }

    const match = database[providerId]
    if (!match) return
    providers[providerId] = mergeDeep(match, provider)
  }

  return {
    isProviderAllowed,
    mergeProvider,
  }
}
