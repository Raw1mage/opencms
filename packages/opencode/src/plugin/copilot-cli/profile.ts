import { Log } from "../../util/log"
import type { CopilotUser, CopilotEndpoints } from "./types"

const log = Log.create({ service: "copilot-cli.profile" })

const DEFAULT_API_BASE = "https://api.githubcopilot.com"

/**
 * Fetch the Copilot user profile from /copilot_internal/user.
 * This returns endpoints, feature flags, subscription info, and org memberships.
 */
export async function fetchProfile(
  accessToken: string,
  domain: string = "github.com",
): Promise<CopilotUser | null> {
  const apiBase = domain === "github.com" ? "https://api.github.com" : `https://${domain}/api/v3`
  const url = `${apiBase}/copilot_internal/user`

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "opencode-copilot-cli",
      },
    })

    if (!resp.ok) {
      log.warn("profile fetch failed", { status: resp.status, url })
      return null
    }

    const data = (await resp.json()) as Record<string, any>

    const endpoints: CopilotEndpoints = {
      api: data.endpoints?.api ?? DEFAULT_API_BASE,
      telemetry: data.endpoints?.telemetry,
    }

    // Parse feature flags: keys starting with copilot_cli_ that have boolean-ish values
    const featureFlags: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("copilot_cli_") && typeof value === "boolean") {
        featureFlags[key] = value
      }
    }
    // Also check nested feature_flags or copilot_features object if present
    const nested = data.feature_flags ?? data.copilot_features
    if (nested && typeof nested === "object") {
      for (const [key, value] of Object.entries(nested)) {
        if (typeof value === "boolean") {
          featureFlags[key] = value
        }
      }
    }

    return {
      login: data.login,
      email: data.email,
      endpoints,
      featureFlags,
      subscription: data.copilotPlan ?? data.plan,
      organizationLoginList: data.organization_login_list,
      isMcpEnabled: data.is_mcp_enabled,
      restrictedTelemetry: data.restricted_telemetry,
    }
  } catch (err) {
    log.warn("profile fetch error", { error: err, url })
    return null
  }
}
