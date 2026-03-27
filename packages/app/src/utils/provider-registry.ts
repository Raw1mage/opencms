export const SUPPORTED_PROVIDER_LABELS = {
  openai: "OpenAI",
  "claude-cli": "Claude CLI",
  "google-api": "Google-API",
  "gemini-cli": "Gemini CLI",
  "github-copilot": "GitHub Copilot",
  gmicloud: "GMICloud",
  openrouter: "OpenRouter",
  vercel: "Vercel",
  gitlab: "GitLab",
  opencode: "OpenCode",
} as const

export type SupportedProviderKey = keyof typeof SUPPORTED_PROVIDER_LABELS

export const SUPPORTED_PROVIDER_KEYS = Object.keys(SUPPORTED_PROVIDER_LABELS) as SupportedProviderKey[]

const supportedProviderKeySet = new Set<string>(SUPPORTED_PROVIDER_KEYS)

export function isSupportedProviderKey(value: string | undefined | null): value is SupportedProviderKey {
  return !!value && supportedProviderKeySet.has(value)
}

export function getSupportedProviderLabel(value: string | undefined | null) {
  if (!isSupportedProviderKey(value)) return undefined
  return SUPPORTED_PROVIDER_LABELS[value]
}
