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
  /**
   * Set to `true` when the upstream refresh_token has been revoked by
   * auth.openai.com (4xx / invalid_grant / 401). Display layer should
   * surface this as a distinct "🔒 re-login required" state instead of
   * the "--" placeholder used for "not probed yet". Probe layer must NOT
   * route this through `isQuotaExhausted` / `notifyQuotaExhausted` — it
   * is an auth state, not a usage state.
   */
  authRevoked?: boolean
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

// Per-account "this refresh_token has already been proven dead by upstream"
// short-circuit. Map<accountId, refreshToken>. Once we see a 4xx (revoked /
// invalid_grant / 401) from auth.openai.com for `refreshToken`, we cache
// that exact token as dead and skip future probes for the same account
// until the stored refreshToken changes (i.e. user re-logins, which writes
// a new refresh_token to storage). Without this gate, the 60s probe TTL
// keeps hammering OpenAI's auth endpoint with known-dead tokens — which
// itself looks like an abuse pattern and risks revoking the entire
// (re-logged-in) account family. 2026-05-08 incident: 42-min run pre-fix
// = ~66 cache-miss refreshes per account → suspected trigger for OpenAI
// flagging 3 codex accounts simultaneously.
const deadRefreshTokens = new Map<string, string>()

function isQuotaExhausted(quota: OpenAIQuota | null | undefined): boolean {
  if (!quota) return false
  // authRevoked is an auth state, not a usage state — don't route through
  // the rate-limit / rotation trigger path. The account's refresh token is
  // dead; there's no usage cap to exhaust here.
  if (quota.authRevoked) return false
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

/**
 * Runloop-end proactive rotation: fetches fresh 5H quota for a
 * codex / openai subscription account and marks it rate-limited when
 * hourlyRemaining drops below `thresholdPercent`. Next turn's pre-flight
 * will rotate to a different account via the existing QUOTA_EXHAUSTED path.
 *
 * Threshold <= 0 disables the check. Accounts already marked rate-limited
 * or without a 5H window (free plans) are skipped.
 *
 * Returns true iff this call marked the account rate-limited.
 */
export async function checkCodexLowQuotaAndMark(
  providerId: string,
  accountId: string | undefined,
  thresholdPercent: number,
): Promise<boolean> {
  if (!accountId) return false
  if (providerId !== "codex" && providerId !== "openai") return false
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0) return false

  try {
    const { getRateLimitTracker, calculateBackoffMs } = await import("../rotation")
    const tracker = getRateLimitTracker()
    if (tracker.isRateLimited(accountId, providerId)) return false

    const quota = await getOpenAIQuota(accountId, { waitFresh: true })
    if (!quota) return false
    if (quota.hasHourlyWindow === false) return false
    if (!(quota.hourlyRemaining < thresholdPercent)) return false

    const backoffMs = calculateBackoffMs("QUOTA_EXHAUSTED", 0, undefined, 0)
    tracker.markRateLimited(accountId, providerId, "QUOTA_EXHAUSTED", backoffMs)
    log.info("runloop-end low quota — proactively marked rate-limited", {
      providerId,
      accountId,
      hourlyRemaining: quota.hourlyRemaining,
      weeklyRemaining: quota.weeklyRemaining,
      thresholdPercent,
      backoffMs,
    })

    try {
      const [{ Bus }, { RateLimitEvent }] = await Promise.all([
        import("../../bus"),
        import("../rate-limit-judge"),
      ])
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
      log.warn("failed to broadcast runloop-end low quota", {
        providerId,
        accountId,
        error: String(e),
      })
    }
    return true
  } catch (e) {
    log.warn("checkCodexLowQuotaAndMark failed", {
      providerId,
      accountId,
      error: String(e),
    })
    return false
  }
}

async function refreshOpenAIAccountQuota(id: string, info: Account.Info, providerId: string): Promise<void> {
  if (info.type !== "subscription") return
  const now = Date.now()

  let access = info.accessToken
  let expires = info.expiresAt
  let refresh = info.refreshToken
  let accountId = info.accountId

  // Skip probe entirely if there's nothing useful to send upstream.
  // (a) `refresh` is empty/missing — chat path's ensureValidToken cleared
  //     it after a 4xx (provider.ts:522). Calling oauth2 with an empty
  //     refresh_token just re-yields 4xx for no signal.
  // (b) the current refreshToken is already known dead — auto-recovers
  //     when user re-logins (storage refreshToken changes →
  //     info.refreshToken no longer matches the cached dead value).
  if (!refresh || deadRefreshTokens.get(id) === refresh) {
    return
  }

  // Refresh token if needed
  if (!access || !expires || expires < now) {
    try {
      const tokens = await refreshCodexAccessToken(refresh)
      access = tokens.access_token
      refresh = tokens.refresh_token ?? refresh
      expires = now + (tokens.expires_in ?? 3600) * 1000
      accountId = accountId ?? extractAccountIdFromTokens(tokens)

      // Update account in storage. Use the actual providerId (codex /
      // openai) — this function services both families, hardcoding
      // "openai" caused `Account not found: openai/codex-subscription-...`
      // for every codex account refresh, leaving tokens uncached and
      // forcing a full refresh on every quota probe.
      await Account.update(providerId, id, {
        refreshToken: refresh,
        accessToken: access,
        expiresAt: expires,
        accountId,
      })
    } catch (e) {
      const msg = String(e)
      // Detect permanent (4xx) failure — revoked / invalid_grant / 401.
      // refreshCodexAccessToken throws on any non-2xx today (line 188-189);
      // status code is in the message. The auth endpoint won't recover on
      // its own — only re-login produces a new refresh_token. Cache the
      // dead value so the next probe short-circuits.
      const isPermanentRevoke = /\b4\d\d\b|invalid_grant|revoked/i.test(msg)
      if (isPermanentRevoke && refresh) {
        deadRefreshTokens.set(id, refresh)
        log.warn("Token refresh suspended: refresh_token revoked, awaiting re-login", {
          providerId,
          id,
          error: msg,
        })
        // Surface the auth-dead state to the display layer with a synthetic
        // quota object — TUI / admin panel can render "🔒 re-login" instead
        // of "--" so the user sees the exact account that needs attention
        // instead of a generic "no data" placeholder. authRevoked=true
        // gates this out of isQuotaExhausted / notifyQuotaExhausted (it's
        // not a usage state).
        quotaCache.set(id, {
          quota: { hourlyRemaining: 0, weeklyRemaining: 0, authRevoked: true },
          timestamp: now,
        })
      } else {
        log.warn("Token refresh failed", { providerId, id, error: msg })
        writeQuotaCache(id, null, now)
      }
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
