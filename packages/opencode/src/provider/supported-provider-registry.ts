export type SupportedProviderKey =
  | "openai"
  | "claude-cli"
  | "google-api"
  | "gemini-cli"
  | "github-copilot"
  | "gmicloud"
  | "openrouter"
  | "vercel"
  | "gitlab"
  | "opencode"
  | "codex"

export type SupportedProviderMeta = {
  key: SupportedProviderKey
  label: string
  runtimeOnly?: false
}

export const SUPPORTED_PROVIDER_REGISTRY: Record<SupportedProviderKey, SupportedProviderMeta> = {
  openai: {
    key: "openai",
    label: "OpenAI",
  },
  "claude-cli": {
    key: "claude-cli",
    label: "Claude CLI",
  },
  "google-api": {
    key: "google-api",
    label: "Google-API",
  },
  "gemini-cli": {
    key: "gemini-cli",
    label: "Gemini CLI",
  },
  "github-copilot": {
    key: "github-copilot",
    label: "GitHub Copilot",
  },
  gmicloud: {
    key: "gmicloud",
    label: "GMICloud",
  },
  openrouter: {
    key: "openrouter",
    label: "OpenRouter",
  },
  vercel: {
    key: "vercel",
    label: "Vercel",
  },
  gitlab: {
    key: "gitlab",
    label: "GitLab",
  },
  opencode: {
    key: "opencode",
    label: "OpenCode",
  },
  codex: {
    key: "codex",
    label: "Codex",
  },
}

export const SUPPORTED_PROVIDER_KEYS = Object.freeze(Object.keys(SUPPORTED_PROVIDER_REGISTRY) as SupportedProviderKey[])

export function isSupportedProviderKey(value: string): value is SupportedProviderKey {
  return value in SUPPORTED_PROVIDER_REGISTRY
}

export function getSupportedProviderMeta(value: string) {
  if (!isSupportedProviderKey(value)) return undefined
  return SUPPORTED_PROVIDER_REGISTRY[value]
}

export function getSupportedProviderLabel(value: string) {
  return getSupportedProviderMeta(value)?.label
}
