const KNOWN_PROVIDER_FAMILIES = [
  "opencode",
  "claude-cli",
  "openai",
  "github-copilot",
  "gemini-cli",
  "google-api",
  "gmicloud",
  "openrouter",
  "vercel",
  "gitlab",
] as const

const EXCLUDED_PROVIDER_FAMILIES = new Set(["google"])

const PROVIDER_LABEL_MAP: Record<string, string> = {
  "claude-cli": "Claude CLI",
  openai: "OpenAI",
  "google-api": "Google-API",
  "gemini-cli": "Gemini CLI",
  gmicloud: "GMICloud",
  "github-copilot": "GitHub Copilot",
  gitlab: "GitLab",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  vercel: "Vercel",
}

const DEFAULT_POPULAR_PROVIDER_ORDER = [
  "opencode",
  "claude-cli",
  "github-copilot",
  "openai",
  "gemini-cli",
  "google-api",
  "openrouter",
  "vercel",
]

export function buildCustomProviderEntries(providerConfig?: Record<string, unknown>) {
  if (!providerConfig) return [] as Array<{ id: string; name: string; models: Record<string, unknown> }>
  return Object.entries(providerConfig)
    .filter(([id, raw]) => {
      if (KNOWN_PROVIDER_FAMILIES.includes(id as (typeof KNOWN_PROVIDER_FAMILIES)[number])) return false
      if (!raw || typeof raw !== "object") return false
      const row = raw as { npm?: unknown; models?: unknown }
      if (row.npm !== "@ai-sdk/openai-compatible") return false
      if (!row.models || typeof row.models !== "object") return false
      return Object.keys(row.models as Record<string, unknown>).length > 0
    })
    .map(([id, raw]) => {
      const row = raw as { name?: unknown; models?: Record<string, unknown> }
      const models = Object.fromEntries(
        Object.entries(row.models ?? {}).map(([modelID, model]) => [
          modelID,
          {
            ...(model && typeof model === "object" ? model : {}),
            id: modelID,
            name:
              model && typeof model === "object" && typeof (model as { name?: unknown }).name === "string"
                ? (model as { name: string }).name
                : modelID,
          },
        ]),
      )
      return {
        id,
        name: typeof row.name === "string" && row.name.trim() ? row.name : id,
        models,
      }
    })
}

export type ProviderListItem = {
  id: string
  name: string
}

export type AccountFamilyMap = Record<string, { accounts?: Record<string, unknown>; activeAccount?: string }>
export type AccountProviderMap = AccountFamilyMap

export type ProviderRow = {
  id: string
  providerKey: string
  name: string
  accounts: number
  enabled: boolean
}

export type AccountRow = {
  id: string
  label: string
  active: boolean
  unavailable?: string
}

export type AccountFamilyRecord = {
  activeAccount?: string
  accounts?: Record<string, Record<string, unknown>>
}

export type AccountProviderRecord = AccountFamilyRecord

export type ModelSelectorSelection = {
  providerID: string
  modelID: string
  accountID?: string
}

export type ModelListItemLike = {
  id: string
  provider: { id: string }
}

export function parseHiddenProvidersStorageValue(value: string | null | undefined) {
  if (!value) return [] as string[]
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return [] as string[]
  }
}

export function loadHiddenProvidersFromStorage(storage: Pick<Storage, "getItem"> | undefined, key: string) {
  if (!storage) return [] as string[]
  return parseHiddenProvidersStorageValue(storage.getItem(key))
}

export function loadFavoriteProvidersFromStorage(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
  fallbackProviders: string[],
) {
  if (!storage) return [...fallbackProviders]
  const raw = storage.getItem(key)
  return raw === null ? [...fallbackProviders] : parseHiddenProvidersStorageValue(raw)
}

export function normalizeProviderKey(id: string): string | undefined {
  if (!id) return undefined
  const raw = id.trim().toLowerCase()
  if (!raw) return undefined

  if (raw.includes(":")) return normalizeProviderKey(raw.split(":")[0]!)
  if (raw === "anthropic") return "claude-cli"
  if (EXCLUDED_PROVIDER_FAMILIES.has(raw)) return undefined

  for (const provider of KNOWN_PROVIDER_FAMILIES) {
    if (raw === provider || raw.startsWith(`${provider}-`)) return provider
  }

  const apiMatch = raw.match(/^(.+)-api-/)
  if (apiMatch) return apiMatch[1]

  const subscriptionMatch = raw.match(/^(.+)-subscription-/)
  if (subscriptionMatch) return subscriptionMatch[1]

  if (!raw.includes("-")) return EXCLUDED_PROVIDER_FAMILIES.has(raw) ? undefined : raw
  if (!raw.includes("-api-") && !raw.includes("-subscription-"))
    return EXCLUDED_PROVIDER_FAMILIES.has(raw) ? undefined : raw
  return undefined
}

/** @deprecated Use normalizeProviderKey instead */
export const normalizeProviderFamily = normalizeProviderKey

export function buildProviderRows(input: {
  providers: ProviderListItem[]
  accountFamilies?: AccountFamilyMap
  popularProviderOrder?: string[]
  /** @deprecated Use hiddenProviders instead. If both are provided, hiddenProviders takes precedence. */
  favoriteProviders?: string[]
  /** Provider keys to hide. Visibility is computed from providerUniverse minus this set. */
  hiddenProviders?: Set<string> | string[]
}): ProviderRow[] {
  const popularProviderOrder = input.popularProviderOrder ?? DEFAULT_POPULAR_PROVIDER_ORDER
  const out = new Map<string, ProviderRow>()
  const providerUniverse = new Set<string>()

  for (const provider of input.providers) {
    const normalized = normalizeProviderKey(provider.id)
    if (!normalized) continue
    providerUniverse.add(normalized)
  }

  if (input.accountFamilies) {
    for (const providerKey of Object.keys(input.accountFamilies)) {
      const normalized = normalizeProviderKey(providerKey)
      if (!normalized) continue
      providerUniverse.add(normalized)
    }
  }

  for (const id of popularProviderOrder) {
    const normalized = normalizeProviderKey(id)
    if (!normalized) continue
    providerUniverse.add(normalized)
  }

  // Resolve visibility: hiddenProviders (blacklist) is the canonical API.
  // favoriteProviders (whitelist) is kept for backward compatibility with tests.
  const hiddenSet = input.hiddenProviders
    ? new Set(input.hiddenProviders)
    : undefined
  const favoriteSet = !hiddenSet && input.favoriteProviders
    ? new Set(input.favoriteProviders.map((p) => providerKeyOf(p)))
    : undefined

  for (const providerKey of providerUniverse) {
    const providerAccounts = input.accountFamilies?.[providerKey]
    const accountsCount = providerAccounts?.accounts ? Object.keys(providerAccounts.accounts).length : 0
    const providersInGroup = input.providers.filter(
      (provider) => (normalizeProviderKey(provider.id) || provider.id) === providerKey,
    )
    const canonicalProvider = providersInGroup.find((provider) => provider.id === providerKey) ?? providersInGroup[0]

    // hiddenSet: enabled = NOT hidden (blacklist model, default visible)
    // favoriteSet: enabled = IS favorite (whitelist model, default hidden) — legacy
    const enabled = hiddenSet
      ? !hiddenSet.has(providerKey)
      : favoriteSet
        ? favoriteSet.has(providerKey)
        : true  // no filter → all visible

    out.set(providerKey, {
      id: providerKey,
      providerKey,
      name: canonicalProvider?.name ?? PROVIDER_LABEL_MAP[providerKey] ?? providerKey,
      accounts: accountsCount,
      enabled,
    })
  }

  return Array.from(out.values()).sort((a, b) => {
    const aIdx = popularProviderOrder.indexOf(a.providerKey)
    const bIdx = popularProviderOrder.indexOf(b.providerKey)
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
    if (aIdx !== -1) return -1
    if (bIdx !== -1) return 1
    return a.name.localeCompare(b.name)
  })
}

export function buildAccountRows(input: {
  selectedProviderKey: string
  accountFamilies?: AccountFamilyMap
  now?: number
  formatCooldown: (minutes: number) => string
}): AccountRow[] {
  if (!input.selectedProviderKey) return []
  const now = input.now ?? Date.now()
  const providerKey = normalizeProviderKey(input.selectedProviderKey) ?? input.selectedProviderKey
  const providerRow = input.accountFamilies?.[providerKey]
  const activeAccount = typeof providerRow?.activeAccount === "string" ? providerRow.activeAccount : undefined
  const accounts = providerRow?.accounts && typeof providerRow.accounts === "object" ? providerRow.accounts : {}

  const rows = Object.entries(accounts).map(([id, value]) => {
    const item = value as Record<string, unknown>
    const name = (typeof item?.name === "string" && item.name) || (typeof item?.email === "string" && item.email) || id
    const until = typeof item?.coolingDownUntil === "number" ? item.coolingDownUntil : undefined
    const reason = typeof item?.cooldownReason === "string" ? item.cooldownReason : undefined
    const unavailable =
      until && until > now ? reason || input.formatCooldown(Math.max(1, Math.ceil((until - now) / 60000))) : undefined

    return {
      id,
      label: name,
      active: activeAccount === id,
      unavailable,
    }
  })

  return rows.sort((a, b) => a.label.localeCompare(b.label))
}

export function filterModelsForMode<T extends { id: string; provider: { id: string } }>(input: {
  models: T[]
  providerKey: string
  mode: "favorites" | "all"
  isVisible: (key: { modelID: string; providerID: string }) => boolean
}) {
  return input.models
    .filter((model) => (normalizeProviderKey(model.provider.id) || model.provider.id) === input.providerKey)
    .filter((model) => {
      if (input.mode === "all") return true
      return input.isVisible({ modelID: model.id, providerID: model.provider.id })
    })
}

export function providerKeyOf(providerId: string) {
  return normalizeProviderKey(providerId) || providerId
}

// Compatibility alias for older local call sites/tests that still use `family` wording.
export const familyOf = providerKeyOf

export function isAccountLikeProviderId(id: string) {
  return id.includes("@")
}

export function getActiveAccountForFamily(
  families: Record<string, { activeAccount?: unknown }> | undefined,
  providerKey: string,
) {
  const providerRow = families?.[providerKey]
  return typeof providerRow?.activeAccount === "string" ? providerRow.activeAccount : undefined
}

// Compatibility alias kept to avoid broad churn across existing helper call sites.
export const getActiveAccountForProviderKey = getActiveAccountForFamily

export function getModelUnavailableReason(input: {
  providerId: string
  accountId?: string
  providerStatus: Map<string, string>
  accountFamilies?: Record<string, { accounts?: Record<string, unknown> }>
  formatCooldown: (minutes: number) => string
  now?: number
}) {
  const direct = input.providerStatus.get(input.providerId)
  if (direct) return direct

  const providerKey = providerKeyOf(input.providerId)
  const providerStatus = input.providerStatus.get(providerKey)
  if (providerStatus) return providerStatus
  if (!input.accountId) return

  const now = input.now ?? Date.now()
  const providerRow = input.accountFamilies?.[providerKey]
  const account = providerRow?.accounts?.[input.accountId] as Record<string, unknown> | undefined
  const until = typeof account?.coolingDownUntil === "number" ? account.coolingDownUntil : undefined
  if (!until || until <= now) return
  const reason = typeof account?.cooldownReason === "string" ? account.cooldownReason : undefined
  return reason || input.formatCooldown(Math.max(1, Math.ceil((until - now) / 60000)))
}

export function pickSelectedProvider(input: {
  selectedProviderId: string
  preferredProviderId?: string
  providers: Array<{ id: string }>
}) {
  if (input.selectedProviderId && input.providers.some((provider) => provider.id === input.selectedProviderId)) {
    return input.selectedProviderId
  }
  if (input.preferredProviderId && input.providers.some((provider) => provider.id === input.preferredProviderId)) {
    return input.preferredProviderId
  }
  return input.providers[0]?.id ?? ""
}

export function pickSelectedAccount(input: {
  selectedAccountId: string
  preferredAccountId?: string
  accounts: Array<{ id: string; active: boolean }>
}) {
  if (input.accounts.length === 0) return ""
  if (input.selectedAccountId && input.accounts.some((row) => row.id === input.selectedAccountId)) {
    return input.selectedAccountId
  }
  if (input.preferredAccountId && input.accounts.some((row) => row.id === input.preferredAccountId)) {
    return input.preferredAccountId
  }
  return input.accounts.find((row) => row.active)?.id ?? input.accounts[0]?.id ?? ""
}

export function pickSelectedModel<T extends ModelListItemLike>(input: {
  selected?: { providerID?: string; modelID?: string }
  preferred?: { providerID?: string; modelID?: string }
  models: T[]
}) {
  if (input.models.length === 0) return undefined

  const matches = (candidate?: { providerID?: string; modelID?: string }) =>
    candidate &&
    input.models.find((model) => model.provider.id === candidate.providerID && model.id === candidate.modelID)

  return matches(input.selected) ?? matches(input.preferred) ?? input.models[0]
}

export function sameModelSelectorSelection(
  left?: Pick<ModelSelectorSelection, "providerID" | "modelID" | "accountID">,
  right?: Pick<ModelSelectorSelection, "providerID" | "modelID" | "accountID">,
) {
  return (
    left?.providerID === right?.providerID &&
    left?.modelID === right?.modelID &&
    (left?.accountID ?? undefined) === (right?.accountID ?? undefined)
  )
}

export function getFilteredModelsForSelection<T extends { id: string; provider: { id: string } }>(input: {
  models: T[]
  selectedProviderKey: string
  currentProviderID?: string
  mode: "favorites" | "all"
  isVisible: (key: { modelID: string; providerID: string }) => boolean
}) {
  if (!input.selectedProviderKey) return [] as T[]

  const providerScopedModels = input.models.filter(
    (model) => providerKeyOf(model.provider.id) === input.selectedProviderKey,
  )
  if (providerScopedModels.length === 0) return [] as T[]

  const resolvedProviderID =
    providerScopedModels.find((model) => model.provider.id === input.selectedProviderKey)?.provider.id ??
    (input.currentProviderID && providerScopedModels.some((model) => model.provider.id === input.currentProviderID)
      ? input.currentProviderID
      : undefined) ??
    providerScopedModels.find((model) => !isAccountLikeProviderId(model.provider.id))?.provider.id ??
    providerScopedModels[0]?.provider.id

  const scopedModels = resolvedProviderID
    ? providerScopedModels.filter((model) => model.provider.id === resolvedProviderID)
    : providerScopedModels

  return filterModelsForMode({
    models: scopedModels,
    providerKey: input.selectedProviderKey,
    mode: input.mode,
    isVisible: input.isVisible,
  })
}
