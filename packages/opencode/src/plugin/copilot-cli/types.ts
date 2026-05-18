/** Shared types for the copilot-cli provider plugin (DD-8: self-contained). */

export interface CopilotEndpoints {
  api: string
  telemetry?: string
}

export interface CopilotUser {
  login?: string
  email?: string
  endpoints: CopilotEndpoints
  featureFlags: Record<string, boolean>
  subscription?: string
  organizationLoginList?: string[]
  isMcpEnabled?: boolean
  restrictedTelemetry?: boolean
}

export interface CopilotTokenState {
  /** Short-lived Copilot API bearer token (capiSessionToken). */
  capiSessionToken: string | null
  /** Unix ms when capiSessionToken expires. 0 = unknown/never (raw token mode). */
  expiresAt: number
  /** Original GitHub OAuth access_token (always available). */
  rawAccessToken: string
  /** Integration identifier for telemetry headers. */
  integrationId?: string
}

export interface CopilotQuotaSnapshot {
  isUnlimitedEntitlement: boolean
  entitlementRequests: number
  usedRequests: number
  usageAllowedWithExhaustedQuota: boolean
  remainingPercentage?: number
  overage?: number
  overageAllowedWithExhaustedQuota?: boolean
  resetDate?: string
}

export interface CopilotQuotaResult {
  quotaSnapshots: Record<string, CopilotQuotaSnapshot>
}

export interface CircuitBreakerConfig {
  failureThreshold: number
  resetTimeoutMs: number
  probeTimeoutMs: number
  statusCodes: number[]
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  probeTimeoutMs: 30_000,
  statusCodes: [500, 502, 503, 504],
}
