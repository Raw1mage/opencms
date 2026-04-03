export type ModelKey = { providerID: string; modelID: string }

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

export function normalizePreferenceProviderFamily(id: unknown): string {
  if (typeof id !== "string") return ""
  const raw = id.trim().toLowerCase()
  if (!raw) return ""
  if (raw.includes(":")) return normalizePreferenceProviderFamily(raw.split(":")[0]!)
  if (EXCLUDED_PROVIDER_FAMILIES.has(raw)) return ""

  for (const provider of KNOWN_PROVIDER_FAMILIES) {
    if (raw === provider || raw.startsWith(`${provider}-`)) return provider
  }

  const apiMatch = raw.match(/^(.+)-api-/)
  if (apiMatch) return apiMatch[1]!
  const subscriptionMatch = raw.match(/^(.+)-subscription-/)
  if (subscriptionMatch) return subscriptionMatch[1]!
  return EXCLUDED_PROVIDER_FAMILIES.has(raw) ? "" : raw
}

export function normalizePreferenceModel(model: ModelKey): ModelKey {
  const providerID = normalizePreferenceProviderFamily(model.providerID) || String(model.providerID ?? "")
  return {
    providerID,
    modelID: String(model.modelID ?? ""),
  }
}

export function preferenceModelKey(model: ModelKey) {
  return `${normalizePreferenceProviderFamily(model.providerID)}:${model.modelID ?? ""}`
}

/** Build the hidden set from server hidden[] array. */
export function buildHiddenSetFromRemote(hidden: Array<{ providerId: string; modelID: string }>): Set<string> {
  return new Set(
    hidden.map((item) => `${normalizePreferenceProviderFamily(item.providerId)}:${item.modelID}`),
  )
}
