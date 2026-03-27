import { Account } from "../account"
import {
  getSupportedProviderLabel,
  isSupportedProviderKey,
  SUPPORTED_PROVIDER_KEYS,
} from "./supported-provider-registry"

export type CanonicalProviderKeyRow = {
  providerKey: string
  /** @deprecated Use providerKey instead */
  family: string
  label: string
  accountCount: number
  activeCount: number
  enabled: boolean
  configured: boolean
  inAccounts: boolean
  inConnectedProviders: boolean
  inModelsDev: boolean
}

export type CanonicalProviderRow = CanonicalProviderKeyRow

/** @deprecated Use CanonicalProviderKeyRow instead */
export type CanonicalProviderFamilyRow = CanonicalProviderKeyRow

type RuntimeProviderLike = {
  id: string
}

type BuildCanonicalProviderKeyRowsInput = {
  accountFamilies?: Record<string, Account.ProviderData>
  connectedProviderIds?: string[]
  modelsDevProviderIds?: string[]
  disabledProviderIds?: string[]
  excludedProviderKeys?: string[]
  excludedFamilies?: string[]
}

/** @deprecated Use BuildCanonicalProviderKeyRowsInput instead */
type BuildCanonicalProviderFamilyRowsInput = BuildCanonicalProviderKeyRowsInput

const LEGACY_BLOCKLIST = new Set(["google"])
const GENERIC_RUNTIME_FAMILIES = new Set(["claude-cli", "github-copilot", "github-copilot-enterprise", "opencode"])

export function normalizeCanonicalProviderKey(id: string | undefined | null): string | undefined {
  if (!id) return undefined
  const raw = id.trim().toLowerCase()
  if (!raw) return undefined
  if (raw.includes(":")) return normalizeCanonicalProviderKey(raw.split(":")[0])

  const parsed = Account.parseProvider(raw) ?? raw
  if (!parsed || LEGACY_BLOCKLIST.has(parsed)) return undefined
  return parsed
}

export function buildCanonicalProviderKeyRows(input: BuildCanonicalProviderKeyRowsInput): CanonicalProviderKeyRow[] {
  const excludedProviderKeys = new Set(
    [...(input.excludedProviderKeys ?? []), ...(input.excludedFamilies ?? [])]
      .map((id) => normalizeCanonicalProviderKey(id))
      .filter((id): id is string => !!id),
  )
  const disabledProviderKeys = new Set(
    (input.disabledProviderIds ?? []).map((id) => normalizeCanonicalProviderKey(id)).filter((id): id is string => !!id),
  )
  const connectedByProviderKey = new Map<string, string[]>()
  const providerKeyUniverse = new Set<string>()

  for (const providerKey of SUPPORTED_PROVIDER_KEYS) {
    const normalized = normalizeCanonicalProviderKey(providerKey)
    if (!normalized || !isSupportedProviderKey(normalized) || excludedProviderKeys.has(normalized)) continue
    providerKeyUniverse.add(normalized)
  }

  for (const providerId of input.connectedProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderKey(providerId)
    if (!normalized || !isSupportedProviderKey(normalized) || excludedProviderKeys.has(normalized)) continue
    const existing = connectedByProviderKey.get(normalized) ?? []
    existing.push(providerId)
    connectedByProviderKey.set(normalized, existing)
  }

  for (const providerId of input.modelsDevProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderKey(providerId)
    if (!normalized || !isSupportedProviderKey(normalized) || excludedProviderKeys.has(normalized)) continue
  }

  return Array.from(providerKeyUniverse)
    .map((providerKey) => {
      const providerData = input.accountFamilies?.[providerKey]
      const accountCount = providerData?.accounts ? Object.keys(providerData.accounts).length : 0
      const activeCount = providerData?.activeAccount ? 1 : 0
      const connectedIds = connectedByProviderKey.get(providerKey) ?? []
      const inModelsDev = (input.modelsDevProviderIds ?? []).some(
        (id) => normalizeCanonicalProviderKey(id) === providerKey,
      )
      const inAccounts = !!providerData
      const inConnectedProviders = connectedIds.length > 0

      return {
        providerKey,
        family: providerKey,
        label: getSupportedProviderLabel(providerKey) ?? Account.getProviderLabel(providerKey),
        accountCount,
        activeCount,
        enabled: !disabledProviderKeys.has(providerKey),
        configured: inAccounts || inConnectedProviders,
        inAccounts,
        inConnectedProviders,
        inModelsDev,
      } satisfies CanonicalProviderKeyRow
    })
    .sort((a, b) => a.providerKey.localeCompare(b.providerKey))
}

/** @deprecated Use buildCanonicalProviderKeyRows instead */
export const buildCanonicalProviderFamilyRows = buildCanonicalProviderKeyRows
export const buildCanonicalProviderRows = buildCanonicalProviderKeyRows
/** @deprecated Use normalizeCanonicalProviderKey instead */
export const normalizeCanonicalProviderFamily = normalizeCanonicalProviderKey
export const resolveCanonicalRuntimeProviderKey = resolveCanonicalRuntimeProviderId
export const resolveCanonicalRuntimeProviderByKey = resolveCanonicalRuntimeProviderId
export { isSupportedProviderKey }

export function resolveCanonicalRuntimeProviderId(input: {
  family: string
  activeAccountId?: string
  availableProviderIds?: string[]
}): string | undefined {
  const family = normalizeCanonicalProviderKey(input.family)
  if (!family) return undefined

  const availableProviderIds = (input.availableProviderIds ?? []).filter(
    (id) => normalizeCanonicalProviderKey(id) === family,
  )
  const exactFamily = availableProviderIds.find((id) => id === family)
  const activeAccountId = input.activeAccountId

  if (GENERIC_RUNTIME_FAMILIES.has(family)) {
    return exactFamily ?? activeAccountId ?? availableProviderIds[0] ?? family
  }

  if (activeAccountId && availableProviderIds.includes(activeAccountId)) {
    return activeAccountId
  }

  return exactFamily ?? activeAccountId ?? availableProviderIds[0] ?? family
}

export function resolveCanonicalRuntimeProvider<T extends RuntimeProviderLike>(input: {
  family: string
  activeAccountId?: string
  providers: T[]
}) {
  const providerId = resolveCanonicalRuntimeProviderByKey({
    family: input.family,
    activeAccountId: input.activeAccountId,
    availableProviderIds: input.providers.map((provider) => provider.id),
  })
  if (!providerId) return undefined

  const provider = input.providers.find((item) => item.id === providerId)
  if (provider) return { id: providerId, provider }

  const providerKey = normalizeCanonicalProviderKey(input.family)
  if (!providerKey) return undefined
  const fallback = input.providers.find((item) => normalizeCanonicalProviderKey(item.id) === providerKey)
  if (!fallback) return undefined
  return { id: fallback.id, provider: fallback }
}
