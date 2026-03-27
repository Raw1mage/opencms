export type QuotaHintFormat = "admin" | "footer"

type QuotaHintCacheKeyInput = {
  baseURL: string
  providerId: string
  format: QuotaHintFormat
  accountId?: string
  modelID?: string
}

type QuotaHintFetcher = (input: string) => Promise<Response>

const QUOTA_HINT_CACHE_TTL_MS = 60_000
const quotaHintCache = new Map<string, { hint: string; timestamp: number }>()

function getQuotaHintCacheKey(input: QuotaHintCacheKeyInput) {
  return [input.baseURL, input.providerId, input.accountId ?? "", input.modelID ?? "", input.format].join(":")
}

export function peekQuotaHint(input: QuotaHintCacheKeyInput) {
  const cached = quotaHintCache.get(getQuotaHintCacheKey(input))
  const now = Date.now()
  return {
    hint: cached?.hint,
    stale: !cached || now - cached.timestamp >= QUOTA_HINT_CACHE_TTL_MS,
  }
}

export async function loadQuotaHint(
  fetcher: QuotaHintFetcher,
  input: QuotaHintCacheKeyInput,
  options?: { fresh?: boolean },
) {
  const cacheKey = getQuotaHintCacheKey(input)
  const cached = quotaHintCache.get(cacheKey)
  const params = new URLSearchParams({ providerId: input.providerId, format: input.format })
  if (input.accountId) params.set("accountId", input.accountId)
  if (input.modelID) params.set("modelID", input.modelID)
  if (options?.fresh) params.set("fresh", "1")

  const response = await fetcher(`${input.baseURL}/api/v2/account/quota?${params.toString()}`)
  if (!response.ok) return cached?.hint
  const data = (await response.json()) as { hint?: string }
  const hint = data.hint ?? ""
  quotaHintCache.set(cacheKey, { hint, timestamp: Date.now() })
  return hint
}

export function invalidateQuotaHint(input: QuotaHintCacheKeyInput) {
  quotaHintCache.delete(getQuotaHintCacheKey(input))
}
