/**
 * Copilot quota query (R3).
 *
 * Fetches per-type quota snapshots (chat, completions, premium_interactions)
 * from the Copilot API, aligned with the CLI's AccountGetQuotaResult schema.
 */

import { Log } from "../../util/log"
import { getBearer, getProfile } from "./auth"
import type { CopilotQuotaResult } from "./types"

const log = Log.create({ service: "copilot-cli.quota" })

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
