import { ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_HEADERS, ANTIGRAVITY_PROVIDER_ID } from "../constants"
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth"
import { ensureProjectContext } from "./project"
import { refreshAccessToken } from "./token"
import { resolveAntigravityQuotaGroup } from "./quota-group"
import type { PluginClient, OAuthAuthDetails } from "./types"
import type { AccountMetadataV3 } from "./storage"
import { debugCheckpoint } from "../../../util/debug"

const FETCH_TIMEOUT_MS = 10000

export type QuotaGroup = "claude" | "gemini-pro" | "gemini-flash"

export interface QuotaGroupSummary {
  remainingFraction?: number
  resetTime?: string
  modelCount: number
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>
  modelCount: number
  error?: string
}

export type AccountQuotaStatus = "ok" | "disabled" | "error"

export interface AccountQuotaResult {
  index: number
  email?: string
  status: AccountQuotaStatus
  error?: string
  disabled?: boolean
  quota?: QuotaSummary
  updatedAccount?: AccountMetadataV3
}

interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>
}

interface FetchAvailableModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  }
}

function normalizeRemainingFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null
  const timestamp = Date.parse(resetTime)
  if (!Number.isFinite(timestamp)) {
    return null
  }
  return timestamp
}

function classifyQuotaGroup(modelName: string, displayName?: string): QuotaGroup | null {
  return resolveAntigravityQuotaGroup(modelName, displayName)
}

function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {}
  if (!models) {
    return { groups, modelCount: 0 }
  }

  const now = Date.now()
  let totalCount = 0
  for (const [modelName, entry] of Object.entries(models)) {
    const group = classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName)
    if (!group) {
      continue
    }
    const quotaInfo = entry.quotaInfo
    let remainingFraction = quotaInfo ? normalizeRemainingFraction(quotaInfo.remainingFraction) : undefined
    const resetTime = quotaInfo?.resetTime
    const resetTimestamp = parseResetTime(resetTime)

    // IMPORTANT: For Claude models, cockpit often returns resetTime without remainingFraction.
    // If resetTime is in the future and remainingFraction is undefined, treat as exhausted (0).
    if (remainingFraction === undefined && resetTimestamp !== null && resetTimestamp > now) {
      remainingFraction = 0
    }

    totalCount += 1

    const existing = groups[group]
    const nextCount = (existing?.modelCount ?? 0) + 1
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction)

    let nextResetTime = existing?.resetTime
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime)
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime
        }
      }
    }

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
    }
  }

  return { groups, modelCount: totalCount }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchAvailableModels(accessToken: string, projectId: string): Promise<FetchAvailableModelsResponse> {
  const endpoint = ANTIGRAVITY_ENDPOINT_PROD
  const quotaUserAgent = ANTIGRAVITY_HEADERS["User-Agent"] || "antigravity/windows/amd64"
  const errors: string[] = []

  const body = projectId ? { project: projectId } : {}
  const response = await fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": quotaUserAgent,
    },
    body: JSON.stringify(body),
  })

  if (response.ok) {
    return (await response.json()) as FetchAvailableModelsResponse
  }

  const message = await response.text().catch(() => "")
  const snippet = message.trim().slice(0, 200)
  errors.push(`fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`)

  throw new Error(errors.join("; ") || "fetchAvailableModels failed")
}

function applyAccountUpdates(account: AccountMetadataV3, auth: OAuthAuthDetails): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh)
  if (!parts.refreshToken) {
    return undefined
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
  }

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId

  return changed ? updated : undefined
}

/**
 * Result of fetching model-specific quota reset time from cockpit.
 */
export interface ModelQuotaResetResult {
  /** Reset time as milliseconds since epoch, or null if not available */
  resetTimeMs: number | null
  /** Remaining fraction (0-1), or null if not available */
  remainingFraction: number | null
  /** Whether the quota is exhausted (remainingFraction <= 0) */
  isExhausted: boolean
  /** Error message if the fetch failed */
  error?: string
}

/**
 * Fetch the quota reset time for a specific model from cockpit.
 * This provides the REAL reset time instead of hardcoded backoff values.
 *
 * @param accessToken - Valid access token for the account
 * @param projectId - Project ID for the account
 * @param modelName - Model name to query (e.g., "claude-sonnet-4-5", "gemini-3-pro-high")
 * @returns ModelQuotaResetResult with real reset time from cockpit
 */
export async function fetchModelQuotaResetTime(
  accessToken: string,
  projectId: string,
  modelName: string,
): Promise<ModelQuotaResetResult> {
  try {
    debugCheckpoint("quota", "fetchModelQuotaResetTime:start", { modelName, projectId: projectId.slice(0, 10) })
    const response = await fetchAvailableModels(accessToken, projectId)
    if (!response.models) {
      debugCheckpoint("quota", "fetchModelQuotaResetTime:no_models", { modelName })
      return { resetTimeMs: null, remainingFraction: null, isExhausted: false }
    }

    const modelKeys = Object.keys(response.models)
    debugCheckpoint("quota", "fetchModelQuotaResetTime:models_received", {
      modelName,
      availableModels: modelKeys.slice(0, 20), // Log first 20 models
      totalCount: modelKeys.length,
    })

    // Try exact match first
    let entry = response.models[modelName]
    let matchedKey = modelName

    // If not found, try partial match (model name might have different format)
    if (!entry) {
      const modelLower = modelName.toLowerCase()
      for (const [key, value] of Object.entries(response.models)) {
        if (key.toLowerCase().includes(modelLower) || modelLower.includes(key.toLowerCase())) {
          entry = value
          matchedKey = key
          break
        }
      }
    }

    if (!entry) {
      debugCheckpoint("quota", "fetchModelQuotaResetTime:model_not_found", {
        modelName,
        availableModels: modelKeys.filter((k) => k.toLowerCase().includes("claude")).slice(0, 10),
      })
      return { resetTimeMs: null, remainingFraction: null, isExhausted: false }
    }

    if (!entry.quotaInfo) {
      debugCheckpoint("quota", "fetchModelQuotaResetTime:no_quota_info", { modelName, matchedKey })
      return { resetTimeMs: null, remainingFraction: null, isExhausted: false }
    }

    const remainingFraction = normalizeRemainingFraction(entry.quotaInfo.remainingFraction) ?? null
    const resetTimeMs = parseResetTime(entry.quotaInfo.resetTime)
    const isExhausted = remainingFraction !== null && remainingFraction <= 0

    debugCheckpoint("quota", "fetchModelQuotaResetTime:success", {
      modelName,
      matchedKey,
      remainingFraction,
      resetTimeMs,
      resetTimeStr: entry.quotaInfo.resetTime,
      isExhausted,
    })

    return {
      resetTimeMs,
      remainingFraction,
      isExhausted,
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    debugCheckpoint("quota", "fetchModelQuotaResetTime:error", { modelName, error: errMsg })
    return {
      resetTimeMs: null,
      remainingFraction: null,
      isExhausted: false,
      error: errMsg,
    }
  }
}

/**
 * Calculate the real backoff time using cockpit's reset time.
 * Falls back to provided fallbackMs if cockpit query fails.
 *
 * @param accessToken - Valid access token for the account
 * @param projectId - Project ID for the account
 * @param modelName - Model name to query
 * @param fallbackMs - Fallback backoff time if cockpit query fails
 * @param minBackoffMs - Minimum backoff time (default 5000ms)
 * @returns Backoff time in milliseconds
 */
export async function getCockpitBackoffMs(
  accessToken: string,
  projectId: string,
  modelName: string,
  fallbackMs: number,
  minBackoffMs: number = 5000,
): Promise<{ backoffMs: number; fromCockpit: boolean; resetTimeMs?: number }> {
  const result = await fetchModelQuotaResetTime(accessToken, projectId, modelName)

  if (result.resetTimeMs !== null) {
    const now = Date.now()
    const backoffMs = Math.max(minBackoffMs, result.resetTimeMs - now)
    return { backoffMs, fromCockpit: true, resetTimeMs: result.resetTimeMs }
  }

  return { backoffMs: fallbackMs, fromCockpit: false }
}

const antigravityQuotaCache = new Map<string, { result: AccountQuotaResult; timestamp: number }>()
const refreshingAntigravity = new Set<string>()
const inflightAntigravity = new Map<string, Promise<AccountQuotaResult>>()
const ANTIGRAVITY_CACHE_TTL_MS = 60_000 // 1 minute

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  const now = Date.now()
  const finalResults: AccountQuotaResult[] = new Array(accounts.length)

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]
    const cacheKey = account.email || `index-${i}`
    const cached = antigravityQuotaCache.get(cacheKey)
    const isStale = !cached || now - cached.timestamp >= ANTIGRAVITY_CACHE_TTL_MS

    if (cached) {
      finalResults[i] = cached.result
    }

    if (!isStale) continue

    if (!cached) {
      const result = await startQuotaRefresh(cacheKey, account, i, client, providerId)
      finalResults[i] = result
      continue
    }

    // SWR: stale cache returns immediately while refresh runs in background
    if (!refreshingAntigravity.has(cacheKey)) {
      void startQuotaRefresh(cacheKey, account, i, client, providerId)
    }
  }

  return finalResults
}

function startQuotaRefresh(
  cacheKey: string,
  account: AccountMetadataV3,
  index: number,
  client: PluginClient,
  providerId: string,
): Promise<AccountQuotaResult> {
  const existing = inflightAntigravity.get(cacheKey)
  if (existing) return existing

  refreshingAntigravity.add(cacheKey)
  const promise = refreshSingleAccountQuota(account, index, client, providerId)
    .then((result) => {
      antigravityQuotaCache.set(cacheKey, { result, timestamp: Date.now() })
      return result
    })
    .finally(() => {
      refreshingAntigravity.delete(cacheKey)
      inflightAntigravity.delete(cacheKey)
    })

  inflightAntigravity.set(cacheKey, promise)
  return promise
}

async function refreshSingleAccountQuota(
  account: AccountMetadataV3,
  index: number,
  client: PluginClient,
  providerId: string,
): Promise<AccountQuotaResult> {
  const disabled = account.enabled === false
  let auth = buildAuthFromAccount(account)

  try {
    if (accessTokenExpired(auth)) {
      const refreshed = await refreshAccessToken(auth, client, providerId)
      if (!refreshed) {
        throw new Error("Token refresh failed")
      }
      auth = refreshed
    }

    const projectContext = await ensureProjectContext(auth)
    auth = projectContext.auth
    const updatedAccount = applyAccountUpdates(account, auth)

    let quotaResult: QuotaSummary
    try {
      const response = await fetchAvailableModels(auth.access ?? "", projectContext.effectiveProjectId)

      // Debug: Log raw model data from cockpit
      const modelKeys = response.models ? Object.keys(response.models) : []
      const claudeModels = modelKeys.filter((k) => k.toLowerCase().includes("claude"))
      debugCheckpoint("quota", "refreshSingleAccountQuota:raw_models", {
        email: account.email,
        totalModels: modelKeys.length,
        claudeModels,
        sampleModels: modelKeys.slice(0, 10),
        claudeQuotaInfo: claudeModels.map((k) => ({
          model: k,
          remainingFraction: response.models?.[k]?.quotaInfo?.remainingFraction,
          resetTime: response.models?.[k]?.quotaInfo?.resetTime,
        })),
      })

      quotaResult = aggregateQuota(response.models)
    } catch (error) {
      quotaResult = {
        groups: {},
        modelCount: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    return {
      index,
      email: account.email,
      status: "ok" as const,
      disabled,
      quota: quotaResult,
      updatedAccount,
    }
  } catch (error) {
    return {
      index,
      email: account.email,
      status: "error" as const,
      disabled,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
