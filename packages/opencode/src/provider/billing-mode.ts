import z from "zod"
import { normalizeCanonicalProviderKey } from "./canonical-family-source"

export const ProviderBillingMode = z.enum(["token", "request", "unknown"])
export type ProviderBillingMode = z.infer<typeof ProviderBillingMode>

const DEFAULT_PROVIDER_BILLING_MODE: Partial<Record<string, ProviderBillingMode>> = {
  openai: "token",
  "google-api": "token",
  openrouter: "token",
  vercel: "token",
  gmicloud: "token",
  "github-copilot": "request",
  "copilot-cli": "request",
}

export function normalizeProviderBillingKey(providerId: string) {
  return normalizeCanonicalProviderKey(providerId) ?? providerId
}

export function defaultProviderBillingMode(providerId: string): ProviderBillingMode {
  return DEFAULT_PROVIDER_BILLING_MODE[normalizeProviderBillingKey(providerId)] ?? "unknown"
}

export function resolveProviderBillingMode(
  config: { provider?: Record<string, { billingMode?: ProviderBillingMode }> } | undefined,
  providerId: string,
): ProviderBillingMode {
  const key = normalizeProviderBillingKey(providerId)
  return config?.provider?.[key]?.billingMode ?? defaultProviderBillingMode(key)
}
