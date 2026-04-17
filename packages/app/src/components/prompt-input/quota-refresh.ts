export function isPromptQuotaProviderKey(providerKey?: string) {
  return (
    providerKey === "openai" ||
    providerKey === "codex" ||
    providerKey === "google-api" ||
    providerKey === "gemini-cli"
  )
}

export function shouldRefreshProviderQuota(input: {
  providerKey?: string
  lastRefreshAt: number
  now?: number
  minIntervalMs?: number
}) {
  if (!isPromptQuotaProviderKey(input.providerKey)) return false
  const now = input.now ?? Date.now()
  // 5 s throttle: long runloops with multiple tool-call turns emit one
  // assistant-completed event per turn — we want each turn to refresh the
  // footer without spamming the usage endpoint. The upstream wham/usage
  // read does not cost tokens, so a low throttle here is safe.
  const minIntervalMs = input.minIntervalMs ?? 5_000
  return now - input.lastRefreshAt >= minIntervalMs
}
