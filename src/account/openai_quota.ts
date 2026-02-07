import { Account } from "./index"
import { Log } from "../util/log"

const log = Log.create({ service: "openai-quota" })

const CODEX_ISSUER = "https://auth.openai.com"
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

export interface OpenAIQuota {
  hourlyRemaining: number
  weeklyRemaining: number
}

// Cache for quota results: accountId -> { quota, timestamp }
const quotaCache = new Map<string, { quota: OpenAIQuota | null; timestamp: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return Math.round(value)
}

type CodexTokenResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

type CodexIdTokenClaims = {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

function parseCodexJwtClaims(token: string): CodexIdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

function extractAccountIdFromClaims(claims: CodexIdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

function extractAccountIdFromTokens(tokens: CodexTokenResponse): string | undefined {
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

async function refreshCodexAccessToken(refreshToken: string): Promise<CodexTokenResponse> {
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

/**
 * Get quota information for all OpenAI accounts.
 * Handles token refreshing and caching.
 */
export async function getOpenAIQuotas(): Promise<Record<string, OpenAIQuota | null>> {
  try {
    const accounts = await Account.list("openai")
    const results: Record<string, OpenAIQuota | null> = {}
    const now = Date.now()

    for (const [id, info] of Object.entries(accounts)) {
      if (info.type !== "subscription") continue

      // Check cache first
      const cached = quotaCache.get(id)
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        results[id] = cached.quota
        continue
      }

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
          quotaCache.set(id, { quota: null, timestamp: now }) // Cache failure briefly?
          results[id] = null
          continue
        }
      }

      // Fetch usage
      try {
        const headers = new Headers({ Authorization: `Bearer ${access}`, Accept: "application/json" })
        if (accountId) headers.set("ChatGPT-Account-Id", accountId)

        const response = await fetch(CODEX_USAGE_URL, { headers })
        if (!response.ok) {
          log.warn("Failed to fetch OpenAI usage", { id, status: response.status })
          quotaCache.set(id, { quota: null, timestamp: now })
          results[id] = null
          continue
        }

        const usage = (await response.json()) as any
        const hourlyUsed = usage?.rate_limit?.primary_window?.used_percent ?? 0
        const weeklyUsed = usage?.rate_limit?.secondary_window?.used_percent ?? 0
        const hourlyRemaining = clampPercentage(100 - hourlyUsed)
        const weeklyRemaining = clampPercentage(100 - weeklyUsed)

        const quota = { hourlyRemaining, weeklyRemaining }
        quotaCache.set(id, { quota, timestamp: now })
        results[id] = quota
      } catch (e) {
        log.warn("Error fetching OpenAI usage", { id, error: String(e) })
        quotaCache.set(id, { quota: null, timestamp: now })
        results[id] = null
      }
    }
    return results
  } catch (error) {
    log.error("Failed to get OpenAI quotas", { error: String(error) })
    return {}
  }
}
