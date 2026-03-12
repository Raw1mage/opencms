import { Account } from "../account"

export type CanonicalProviderKeyRow = {
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
  excludedFamilies?: string[]
}

/** @deprecated Use BuildCanonicalProviderKeyRowsInput instead */
type BuildCanonicalProviderFamilyRowsInput = BuildCanonicalProviderKeyRowsInput

const LEGACY_BLOCKLIST = new Set(["google"])
const GENERIC_RUNTIME_FAMILIES = new Set(["claude-cli", "github-copilot", "github-copilot-enterprise", "opencode"])

export function normalizeCanonicalProviderFamily(id: string | undefined | null): string | undefined {
  if (!id) return undefined
  const raw = id.trim().toLowerCase()
  if (!raw) return undefined
  if (raw.includes(":")) return normalizeCanonicalProviderFamily(raw.split(":")[0])

  const parsed = Account.parseProvider(raw) ?? raw
  if (!parsed || LEGACY_BLOCKLIST.has(parsed)) return undefined
  return parsed
}

export function buildCanonicalProviderFamilyRows(
  input: BuildCanonicalProviderFamilyRowsInput,
): CanonicalProviderFamilyRow[] {
  const excludedFamilies = new Set(
    (input.excludedFamilies ?? []).map((id) => normalizeCanonicalProviderFamily(id)).filter((id): id is string => !!id),
  )
  const disabledFamilies = new Set(
    (input.disabledProviderIds ?? [])
      .map((id) => normalizeCanonicalProviderFamily(id))
      .filter((id): id is string => !!id),
  )
  const connectedByProviderKey = new Map<string, string[]>()
  const providerKeyUniverse = new Set<string>()

  for (const providerKey of Object.keys(input.accountFamilies ?? {})) {
    const normalized = normalizeCanonicalProviderFamily(providerKey)
    if (!normalized || excludedFamilies.has(normalized)) continue
    providerKeyUniverse.add(normalized)
  }

  for (const providerId of input.connectedProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderFamily(providerId)
    if (!normalized || excludedFamilies.has(normalized)) continue
    providerKeyUniverse.add(normalized)
    const existing = connectedByProviderKey.get(normalized) ?? []
    existing.push(providerId)
    connectedByProviderKey.set(normalized, existing)
  }

  for (const providerId of input.modelsDevProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderFamily(providerId)
    if (!normalized || excludedFamilies.has(normalized)) continue
    providerKeyUniverse.add(normalized)
  }

  for (const providerId of input.disabledProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderFamily(providerId)
    if (!normalized || excludedFamilies.has(normalized)) continue
    providerKeyUniverse.add(normalized)
  }

  return Array.from(providerKeyUniverse)
    .map((providerKey) => {
      const providerData = input.accountFamilies?.[providerKey]
      const accountCount = providerData?.accounts ? Object.keys(providerData.accounts).length : 0
      const activeCount = providerData?.activeAccount ? 1 : 0
      const connectedIds = connectedByProviderKey.get(providerKey) ?? []
      const inModelsDev = (input.modelsDevProviderIds ?? []).some(
        (id) => normalizeCanonicalProviderFamily(id) === providerKey,
      )
      const inAccounts = !!providerData
      const inConnectedProviders = connectedIds.length > 0

      return {
        family: providerKey,
        label: Account.getProviderLabel(providerKey),
        accountCount,
        activeCount,
        enabled: !disabledFamilies.has(providerKey),
        configured: inAccounts || inConnectedProviders,
        inAccounts,
        inConnectedProviders,
        inModelsDev,
      } satisfies CanonicalProviderKeyRow
    })
    .sort((a, b) => a.family.localeCompare(b.family))
}

export const buildCanonicalProviderKeyRows = buildCanonicalProviderFamilyRows
export const buildCanonicalProviderRows = buildCanonicalProviderFamilyRows
export const normalizeCanonicalProviderKey = normalizeCanonicalProviderFamily
export const resolveCanonicalRuntimeProviderKey = resolveCanonicalRuntimeProviderId
export const resolveCanonicalRuntimeProviderByKey = resolveCanonicalRuntimeProviderId

export function resolveCanonicalRuntimeProviderId(input: {
  family: string
  activeAccountId?: string
  availableProviderIds?: string[]
}): string | undefined {
  const family = normalizeCanonicalProviderFamily(input.family)
  if (!family) return undefined

  const availableProviderIds = (input.availableProviderIds ?? []).filter(
    (id) => normalizeCanonicalProviderFamily(id) === family,
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
