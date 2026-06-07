/**
 * Copilot quota query (R3).
 *
 * Fetches per-type quota snapshots (chat, completions, premium_interactions)
 * from the Copilot API, aligned with the CLI's AccountGetQuotaResult schema.
 */

import { Log } from "../../util/log"
import { getBearer, getProfile } from "./auth"
import type { CopilotQuotaResult, CopilotQuotaSnapshot } from "./types"

const log = Log.create({ service: "copilot-cli.quota" })

// ---------------------------------------------------------------------------
// Cached premium-interactions snapshot (used by the `auto` model router to
// downshift to the cheapest model when the premium-request budget is nearly
// exhausted). TTL-bounded so the auto router never adds a network round-trip
// to the hot path more than once per minute. A null result (profile not
// loaded, network error, endpoint shape mismatch) means "no opinion" — the
// router proceeds on its size heuristic alone and never blocks on quota.
// ---------------------------------------------------------------------------

const QUOTA_TTL_MS = 60_000
let _premiumQuotaCache: { at: number; value: CopilotQuotaSnapshot | null } | null = null

export async function getCachedPremiumQuota(): Promise<CopilotQuotaSnapshot | null> {
  const now = Date.now()
  if (_premiumQuotaCache && now - _premiumQuotaCache.at < QUOTA_TTL_MS) {
    return _premiumQuotaCache.value
  }
  let snapshot: CopilotQuotaSnapshot | null = null
  try {
    const result = await getCopilotQuota()
    snapshot = result?.quotaSnapshots?.["premium_interactions"] ?? null
  } catch (err) {
    log.warn("cached premium quota fetch failed", { error: err })
    snapshot = null
  }
  _premiumQuotaCache = { at: now, value: snapshot }
  return snapshot
}

export async function getCopilotQuota(): Promise<CopilotQuotaResult | null> {
  const profile = getProfile()
  if (!profile) {
    log.warn("cannot query quota — profile not loaded")
    return null
  }

  const base = profile.endpoints.api.replace(/\/$/, "")
  const bearer = await getBearer()

  try {
    const resp = await fetch(`${base}/copilot_internal/v2/token`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        "User-Agent": "opencode-copilot-cli",
      },
    })

    if (!resp.ok) {
      // Try alternative endpoint pattern
      const altResp = await fetch(`${base}/account/quota`, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
          "User-Agent": "opencode-copilot-cli",
        },
      })

      if (!altResp.ok) {
        log.warn("quota query failed", { status: resp.status, altStatus: altResp.status })
        return null
      }

      return parseQuotaResponse(await altResp.json())
    }

    return parseQuotaResponse(await resp.json())
  } catch (err) {
    log.warn("quota query error", { error: err })
    return null
  }
}

function parseQuotaResponse(data: any): CopilotQuotaResult {
  // The CLI schema has quotaSnapshots keyed by type.
  // The actual API response format may vary — handle both shapes.
  if (data.quotaSnapshots) {
    return data as CopilotQuotaResult
  }

  // Fallback: if the response has flat quota fields, wrap them
  const snapshots: CopilotQuotaResult["quotaSnapshots"] = {}

  if (data.chat_token) {
    snapshots["chat"] = {
      isUnlimitedEntitlement: false,
      entitlementRequests: 0,
      usedRequests: 0,
      usageAllowedWithExhaustedQuota: true,
      ...data.chat_token,
    }
  }

  // If we got a token response with limits info, extract what we can
  if (data.limited !== undefined) {
    snapshots["premium_interactions"] = {
      isUnlimitedEntitlement: !data.limited,
      entitlementRequests: data.entitlement_count ?? 0,
      usedRequests: data.current_count ?? 0,
      usageAllowedWithExhaustedQuota: data.limited === false,
      remainingPercentage: data.entitlement_count
        ? ((data.entitlement_count - (data.current_count ?? 0)) / data.entitlement_count) * 100
        : undefined,
      resetDate: data.refresh_at,
    }
  }

  return { quotaSnapshots: snapshots }
}
