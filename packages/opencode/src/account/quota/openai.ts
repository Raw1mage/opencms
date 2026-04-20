/**
 * OpenAI Codex quota — single source of truth for Codex usage / token refresh.
 *
 * @event_20260216_quota_consolidation
 * Moved from account/openai_quota.ts and exported Codex helpers that were
 * duplicated in dialog-admin.tsx (90+ lines of identical code).
 *
 * Consumers:
 *  - rotation3d.ts   → getOpenAIQuotas()
 *  - dialog-admin.tsx → refreshCodexAccessToken(), extractAccountIdFromTokens(),
 *                        parseCodexUsage(), clampPercentage(), CODEX_USAGE_URL
 */

import { Account } from "../index"
import { Log } from "../../util/log"
import z from "zod"

const log = Log.create({ service: "openai-quota" })

// ============================================================================
// Constants (exported for dialog-admin reuse)
// ============================================================================

export const CODEX_ISSUER = "https://auth.openai.com"
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

// ============================================================================
// Types
// ============================================================================

export interface OpenAIQuota {
  hourlyRemaining: number
  weeklyRemaining: number
  hasHourlyWindow?: boolean
}

export type CodexTokenResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

export type CodexIdTokenClaims = {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

// ============================================================================
// Schemas
// ============================================================================

export const CodexUsageSchema = z
  .object({
    rate_limit: z
      .object({
        primary_window: z
          .object({
            used_percent: z.number().optional(),
            limit_window_seconds: z.number().optional(),
          })
          .nullable()
          .optional(),
        secondary_window: z
          .object({
            used_percent: z.number().optional(),
            limit_window_seconds: z.number().optional(),
          })
          .nullable()
          .optional(),
      })
      .optional(),
  })
  .passthrough()

export type CodexUsage = z.infer<typeof CodexUsageSchema>

// ============================================================================
// Utilities (exported to eliminate duplication in dialog-admin.tsx)
// ============================================================================

export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return Math.round(value)
}

export function parseCodexUsage(value: unknown): CodexUsage | undefined {
  const parsed = CodexUsageSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Normalize Codex usage windows across plan types.
 *
 * Paid plans usually expose:
 * - primary_window   => 5-hour bucket
 * - secondary_window => weekly bucket
 *
 * Free plans currently expose only one weekly bucket:
 * - primary_window(limit_window_seconds=604800)
 * - secondary_window=null
 */
export function computeCodexRemaining(usage: CodexUsage | undefined): {
  hourlyRemaining?: number
  weeklyRemaining?: number
  hasHourlyWindow: boolean
} {
  const primary = usage?.rate_limit?.primary_window ?? undefined
  const secondary = usage?.rate_limit?.secondary_window ?? undefined

  const primaryUsed = typeof primary?.used_percent === "number" ? primary.used_percent : undefined
  const secondaryUsed = typeof secondary?.used_percent === "number" ? secondary.used_percent : undefined

  // Paid plans: primary=5H, secondary=WK
  if (secondaryUsed !== undefined) {
    return {
      hourlyRemaining: primaryUsed !== undefined ? clampPercentage(100 - primaryUsed) : undefined,
      weeklyRemaining: clampPercentage(100 - secondaryUsed),
      hasHourlyWindow: true,
    }
  }

  // Single-window plans (e.g. free): decide whether primary is weekly by window size
  if (primaryUsed !== undefined) {
    const windowSeconds = primary?.limit_window_seconds
    const isWeeklyWindow = typeof windowSeconds === "number" && windowSeconds >= 6 * 24 * 60 * 60
    if (isWeeklyWindow) {
      return {
        weeklyRemaining: clampPercentage(100 - primaryUsed),
        hasHourlyWindow: false,
      }
    }
    return {
      hourlyRemaining: clampPercentage(100 - primaryUsed),
      hasHourlyWindow: true,
    }
  }

  return { hasHourlyWindow: true }
}

export function parseCodexJwtClaims(token: string): CodexIdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: CodexIdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountIdFromTokens(tokens: CodexTokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseCodexJwtClaims(tokens.id_token)
    if (claims) {
      const accountId = extractAccountIdFromClaims(claims)
      if (accountId) return accountId
    }
  }
  const claims = parseCodexJwtClaims(tokens.access_token)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

export async function refreshCodexAccessToken(refreshToken: string): Promise<CodexTokenResponse> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Codex token refresh failed: ${response.status}`)
  }
  return response.json()
}

// ============================================================================
// Cache
// ============================================================================

const quotaCache = new Map<string, { quota: OpenAIQuota | null; timestamp: number }>()
export const OPENAI_QUOTA_DISPLAY_TTL_MS = 60_000
const CACHE_TTL_MS = OPENAI_QUOTA_DISPLAY_TTL_MS

function isQuotaExhausted(quota: OpenAIQuota | null | undefined): boolean {
  if (!quota) return false
  if (quota.weeklyRemaining <= 0) return true
  if (quota.hasHourlyWindow !== false && quota.hourlyRemaining <= 0) return true
  return false
}

function writeQuotaCache(id: string, quota: OpenAIQuota | null, timestamp: number, providerId?: string) {
  const previous = quotaCache.get(id)
  if (quota === null) {
    if (previous?.quota) {
      quotaCache.set(id, { quota: previous.quota, timestamp })
      return
    }
  }
  quotaCache.set(id, { quota, timestamp })

  // Proactive rotation trigger: when cockpit quota transitions healthy → exhausted,
  // mark the account as rate-limited immediately so the next pre-flight short-circuits
  // to rotation instead of burning a 429 request. @rate-limit-judge.ts owns the
  // corresponding post-error path; this is the pre-error twin.
  if (providerId && quota && !isQuotaExhausted(previous?.quota) && isQuotaExhausted(quota)) {
    notifyQuotaExhausted(providerId, id, quota).catch(() => {})
  }
}

async function notifyQuotaExhausted(providerId: string, accountId: string, quota: OpenAIQuota): Promise<void> {
  try {
    const [{ getRateLimitTracker, calculateBackoffMs }, { Bus }, { RateLimitEvent }] = await Promise.all([
      import("../rotation"),
      import("../../bus"),
      import("../rate-limit-judge"),
    ])
    const tracker = getRateLimitTracker()
    if (tracker.isRateLimited(accountId, providerId)) return
    const backoffMs = calculateBackoffMs("QUOTA_EXHAUSTED", 0, undefined, 0)
    tracker.markRateLimited(accountId, providerId, "QUOTA_EXHAUSTED", backoffMs)
    log.info("cockpit quota exhausted — proactively marked rate-limited", {
      providerId,
      accountId,
      hourlyRemaining: quota.hourlyRemaining,
      weeklyRemaining: quota.weeklyRemaining,
      backoffMs,
    })
    Bus.publish(RateLimitEvent.Detected, {
      providerId,
      accountId,
      modelId: "",
      reason: "QUOTA_EXHAUSTED",
      backoffMs,
      source: "cockpit",
      dailyFailures: 0,
      timestamp: Date.now(),
    }).catch(() => {})
  } catch (e) {
    log.warn("failed to broadcast proactive quota exhaustion", {
      providerId,
      accountId,
      error: String(e),
    })
  }
}

// ============================================================================
// Main API
// ============================================================================

const refreshingOpenAI = new Set<string>()
const refreshingPromises = new Map<string, Promise<void>>()

function ensureOpenAIQuotaRefresh(id: string, info: Account.Info, providerId: string) {
  if (info.type !== "subscription") return
  if (refreshingOpenAI.has(id)) return

  const refreshPromise = refreshOpenAIAccountQuota(id, info, providerId)
    .catch(() => {
      // refreshOpenAIAccountQuota already writes cache and logs
    })
    .finally(() => {
      refreshingOpenAI.delete(id)
      refreshingPromises.delete(id)
    })

  refreshingOpenAI.add(id)
  refreshingPromises.set(id, refreshPromise)
  void refreshPromise
}

/**
 * Get quota information for all OpenAI subscription accounts.
 * Handles token refreshing and caching.
 *
 * Uses Stale-While-Revalidate: Returns cached data immediately (even if expired)
 * and triggers background refresh if needed.
 */
export async function getOpenAIQuotas(): Promise<Record<string, OpenAIQuota | null>> {
  try {
    const openaiAccounts = await Account.list("openai")
    const codexAccounts = await Account.list("codex").catch(() => ({}))
    const entries: Array<[string, Account.Info, string]> = [
      ...Object.entries(openaiAccounts).map(([id, info]) => [id, info, "openai"] as [string, Account.Info, string]),
      ...Object.entries(codexAccounts).map(([id, info]) => [id, info, "codex"] as [string, Account.Info, string]),
    ]
    const results: Record<string, OpenAIQuota | null> = {}
    const now = Date.now()

    for (const [id, info, providerId] of entries) {
      if (info.type !== "subscription") continue

      const cached = quotaCache.get(id)
      const isStale = !cached || now - cached.timestamp >= CACHE_TTL_MS

      if (cached) {
        results[id] = cached.quota
      } else {
        // Keep stable shape for first read before background refresh completes.
        results[id] = null
      }

      if (isStale) ensureOpenAIQuotaRefresh(id, info, providerId)
    }

    return results
  } catch (error) {
    log.error("Failed to get OpenAI quotas", { error: String(error) })
    return {}
  }
}

export async function getOpenAIQuota(
  accountId: string,
  options?: {
    waitFresh?: boolean
  },
): Promise<OpenAIQuota | null | undefined> {
  const quotas = await getOpenAIQuotas()
  const current = quotas[accountId]
  if (current !== null || !options?.waitFresh) return current

  const openaiAcct = await Account.list("openai")
  const codexAcct = await Account.list("codex").catch(() => ({}))
  const providerId = accountId in openaiAcct ? "openai" : "codex"
  const accounts = { ...openaiAcct, ...codexAcct }
  const info = accounts[accountId]
  if (!info || info.type !== "subscription") return null

  const inflight = refreshingPromises.get(accountId)
  if (inflight) {
    await inflight.catch(() => {})
  } else {
    const promise = refreshOpenAIAccountQuota(accountId, info, providerId)
      .catch(() => {})
      .finally(() => {
        refreshingOpenAI.delete(accountId)
        refreshingPromises.delete(accountId)
      })
    refreshingOpenAI.add(accountId)
    refreshingPromises.set(accountId, promise)
    await promise
  }

  return quotaCache.get(accountId)?.quota ?? null
}

export async function getOpenAIQuotaForDisplay(accountId: string): Promise<OpenAIQuota | null | undefined> {
  const cached = quotaCache.get(accountId)
  const now = Date.now()

  if (cached) {
    if (cached.quota === null) {
      // Treat failed/unknown display data as recoverable: a real display request
      // (/admin or footer) should try to hydrate fresh data instead of reusing
      // a full-TTL null placeholder.
      return getOpenAIQuota(accountId, { waitFresh: true })
    }

    const isStale = now - cached.timestamp >= CACHE_TTL_MS
    if (isStale) {
      const oa = await Account.list("openai")
      const ca = await Account.list("codex").catch(() => ({}))
      const providerId = accountId in oa ? "openai" : "codex"
      const info = { ...oa, ...ca }[accountId]
      if (info?.type === "subscription") ensureOpenAIQuotaRefresh(accountId, info, providerId)
    }
    return cached.quota
  }

  return getOpenAIQuota(accountId, { waitFresh: true })
}

async function refreshOpenAIAccountQuota(id: string, info: Account.Info, providerId: string): Promise<void> {
  if (info.type !== "subscription") return
  const now = Date.now()

  let access = info.accessToken
  let expires = info.expiresAt
  let refresh = info.refreshToken
  let accountId = info.accountId

  // Refresh token if needed
  if (!access || !expires || expires < now) {
    try {
      const tokens = await refreshCodexAccessToken(refresh)
      access = tokens.access_token
      refresh = tokens.refresh_token ?? refresh
      expires = now + (tokens.expires_in ?? 3600) * 1000
      accountId = accountId ?? extractAccountIdFromTokens(tokens)

      // Update account in storage
      await Account.update("openai", id, {
        refreshToken: refresh,
        accessToken: access,
        expiresAt: expires,
        accountId,
      })
    } catch (e) {
      log.warn("Token refresh failed for OpenAI account", { id, error: String(e) })
      writeQuotaCache(id, null, now)
      return
    }
  }

  // Fetch usage
  try {
    const headers = new Headers({ Authorization: `Bearer ${access}`, Accept: "application/json" })
    if (accountId) headers.set("ChatGPT-Account-Id", accountId)

    const response = await fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(10000) })
    if (!response.ok) {
      log.warn("Failed to fetch OpenAI usage", { id, status: response.status })
      writeQuotaCache(id, null, now)
      return
    }

    const usage = parseCodexUsage(await response.json())
    const normalized = computeCodexRemaining(usage)
    const hourlyRemaining = normalized.hourlyRemaining ?? 100
    const weeklyRemaining = normalized.weeklyRemaining ?? normalized.hourlyRemaining ?? 100

    const quota = { hourlyRemaining, weeklyRemaining, hasHourlyWindow: normalized.hasHourlyWindow }
    writeQuotaCache(id, quota, now, providerId)
  } catch (e) {
    log.warn("Error fetching OpenAI usage", { id, error: String(e) })
    writeQuotaCache(id, null, now)
  }
}
