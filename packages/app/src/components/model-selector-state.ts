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

export type ProviderListItem = {
  id: string
  name: string
}

export type AccountFamilyMap = Record<string, { accounts?: Record<string, unknown>; activeAccount?: string }>

export type ProviderRow = {
  id: string
  family: string
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

export function normalizeProviderFamily(id: string): string | undefined {
  if (!id) return undefined
  const raw = id.trim().toLowerCase()
  if (!raw) return undefined

  if (raw.includes(":")) return normalizeProviderFamily(raw.split(":")[0]!)
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

export function buildProviderRows(input: {
  providers: ProviderListItem[]
  accountFamilies?: AccountFamilyMap
  disabledProviders?: string[]
  popularProviderOrder?: string[]
}): ProviderRow[] {
  const popularProviderOrder = input.popularProviderOrder ?? DEFAULT_POPULAR_PROVIDER_ORDER
  const out = new Map<string, ProviderRow>()
  const familyUniverse = new Set<string>()

  for (const provider of input.providers) {
    const normalized = normalizeProviderFamily(provider.id)
    if (!normalized) continue
    familyUniverse.add(normalized)
  }

  if (input.accountFamilies) {
    for (const family of Object.keys(input.accountFamilies)) {
      const normalized = normalizeProviderFamily(family)
      if (!normalized) continue
      familyUniverse.add(normalized)
    }
  }

  for (const id of input.disabledProviders ?? []) {
    const normalized = normalizeProviderFamily(id)
    if (!normalized) continue
    familyUniverse.add(normalized)
  }

  for (const id of popularProviderOrder) {
    const normalized = normalizeProviderFamily(id)
    if (!normalized) continue
    familyUniverse.add(normalized)
  }

  const disabledFamilies = new Set(
    (input.disabledProviders ?? []).map((id) => normalizeProviderFamily(id)).filter((id): id is string => !!id),
  )

  for (const family of familyUniverse) {
    const familyAccounts = input.accountFamilies?.[family]
    const accountsCount = familyAccounts?.accounts ? Object.keys(familyAccounts.accounts).length : 0
    const providersInFamily = input.providers.filter(
      (provider) => (normalizeProviderFamily(provider.id) || provider.id) === family,
    )
    const familyProvider = providersInFamily.find((provider) => provider.id === family) ?? providersInFamily[0]

    out.set(family, {
      id: family,
      family,
      name: familyProvider?.name ?? PROVIDER_LABEL_MAP[family] ?? family,
      accounts: accountsCount,
      enabled: !disabledFamilies.has(family),
    })
  }

  return Array.from(out.values()).sort((a, b) => {
    const aIdx = popularProviderOrder.indexOf(a.family)
    const bIdx = popularProviderOrder.indexOf(b.family)
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
    if (aIdx !== -1) return -1
    if (bIdx !== -1) return 1
    return a.name.localeCompare(b.name)
  })
}

export function buildAccountRows(input: {
  selectedProviderFamily: string
  accountFamilies?: AccountFamilyMap
  now?: number
  formatCooldown: (minutes: number) => string
}): AccountRow[] {
  if (!input.selectedProviderFamily) return []
  const now = input.now ?? Date.now()
  const family = normalizeProviderFamily(input.selectedProviderFamily) ?? input.selectedProviderFamily
  const familyRow = input.accountFamilies?.[family]
  const activeAccount = typeof familyRow?.activeAccount === "string" ? familyRow.activeAccount : undefined
  const accounts = familyRow?.accounts && typeof familyRow.accounts === "object" ? familyRow.accounts : {}

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

  return rows.sort((a, b) => {
    if (a.active && !b.active) return -1
    if (!a.active && b.active) return 1
    return a.label.localeCompare(b.label)
  })
}

export function filterModelsForMode<T extends { id: string; provider: { id: string } }>(input: {
  models: T[]
  providerFamily: string
  mode: "favorites" | "all"
  isVisible: (key: { modelID: string; providerID: string }) => boolean
}) {
  return input.models
    .filter((model) => (normalizeProviderFamily(model.provider.id) || model.provider.id) === input.providerFamily)
    .filter((model) => {
      if (input.mode === "all") return true
      return input.isVisible({ modelID: model.id, providerID: model.provider.id })
    })
}
