import { Account } from "../account"

export type CanonicalProviderFamilyRow = {
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

type RuntimeProviderLike = {
  id: string
}

type BuildCanonicalProviderFamilyRowsInput = {
  accountFamilies?: Record<string, Account.ProviderData>
  connectedProviderIds?: string[]
  modelsDevProviderIds?: string[]
  disabledProviderIds?: string[]
  excludedFamilies?: string[]
}

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
  const connectedByFamily = new Map<string, string[]>()
  const familyUniverse = new Set<string>()

  for (const family of Object.keys(input.accountFamilies ?? {})) {
    const normalized = normalizeCanonicalProviderFamily(family)
    if (!normalized || excludedFamilies.has(normalized)) continue
    familyUniverse.add(normalized)
  }

  for (const providerId of input.connectedProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderFamily(providerId)
    if (!normalized || excludedFamilies.has(normalized)) continue
    familyUniverse.add(normalized)
    const existing = connectedByFamily.get(normalized) ?? []
    existing.push(providerId)
    connectedByFamily.set(normalized, existing)
  }

  for (const providerId of input.modelsDevProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderFamily(providerId)
    if (!normalized || excludedFamilies.has(normalized)) continue
    familyUniverse.add(normalized)
  }

  for (const providerId of input.disabledProviderIds ?? []) {
    const normalized = normalizeCanonicalProviderFamily(providerId)
    if (!normalized || excludedFamilies.has(normalized)) continue
    familyUniverse.add(normalized)
  }

  return Array.from(familyUniverse)
    .map((family) => {
      const familyData = input.accountFamilies?.[family]
      const accountCount = familyData?.accounts ? Object.keys(familyData.accounts).length : 0
      const activeCount = familyData?.activeAccount ? 1 : 0
      const connectedIds = connectedByFamily.get(family) ?? []
      const inModelsDev = (input.modelsDevProviderIds ?? []).some(
        (id) => normalizeCanonicalProviderFamily(id) === family,
      )
      const inAccounts = !!familyData
      const inConnectedProviders = connectedIds.length > 0

      return {
        family,
        label: Account.getProviderLabel(family),
        accountCount,
        activeCount,
        enabled: !disabledFamilies.has(family),
        configured: inAccounts || inConnectedProviders,
        inAccounts,
        inConnectedProviders,
        inModelsDev,
      } satisfies CanonicalProviderFamilyRow
    })
    .sort((a, b) => a.family.localeCompare(b.family))
}

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
  const providerId = resolveCanonicalRuntimeProviderId({
    family: input.family,
    activeAccountId: input.activeAccountId,
    availableProviderIds: input.providers.map((provider) => provider.id),
  })
  if (!providerId) return undefined

  const provider = input.providers.find((item) => item.id === providerId)
  if (provider) return { id: providerId, provider }

  const family = normalizeCanonicalProviderFamily(input.family)
  if (!family) return undefined
  const fallback = input.providers.find((item) => normalizeCanonicalProviderFamily(item.id) === family)
  if (!fallback) return undefined
  return { id: fallback.id, provider: fallback }
}
