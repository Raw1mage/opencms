import { Log } from "../../util/log"
import { Installation } from "../../installation"
import { fetchProfile } from "./profile"
import type { CopilotUser, CopilotTokenState, CopilotEndpoints } from "./types"

const log = Log.create({ service: "copilot-cli.auth" })

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

// ---------------------------------------------------------------------------
// Token Exchange (DD-2: fallback to raw token with warning on failure)
// ---------------------------------------------------------------------------

/** Attempt to exchange a GitHub OAuth token for a short-lived Copilot API token. */
async function exchangeToken(
  accessToken: string,
  endpoints: CopilotEndpoints,
): Promise<{ token: string; expiresAt: number } | null> {
  // The CLI binary exchanges the OAuth token via an internal endpoint.
  // The exact URL is obfuscated in the minified binary, but the pattern
  // observed is: POST to the API base with the OAuth token as Bearer.
  // The Copilot API also accepts the raw OAuth token directly as Bearer
  // (which is what OpenCMS has been doing), so if exchange fails we fall back.
  try {
    const base = endpoints.api.replace(/\/$/, "")
    // Try the known copilot_internal endpoint pattern
    const resp = await fetch(`${base}/copilot_internal/v2/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": `opencode/${Installation.VERSION}`,
      },
    })

    if (resp.ok) {
      const data = (await resp.json()) as Record<string, any>
      if (data.token) {
        const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 1800
        return {
          token: data.token,
          expiresAt: Date.now() + expiresIn * 1000,
        }
      }
    }

    log.warn("token exchange responded non-ok, falling back to raw token (DD-2)", {
      status: resp.status,
    })
    return null
  } catch (err) {
    log.warn("token exchange failed, falling back to raw token (DD-2)", { error: err })
    return null
  }
}

// ---------------------------------------------------------------------------
// Token State Management
// ---------------------------------------------------------------------------

let _tokenState: CopilotTokenState | null = null
let _profile: CopilotUser | null = null
let _domain: string = "github.com"

export function getProfile(): CopilotUser | null {
  return _profile
}

export function getTokenState(): CopilotTokenState | null {
  return _tokenState
}

/** Initialize auth state after OAuth login. Fetches profile + attempts token exchange. */
export async function initAuth(accessToken: string, domain: string): Promise<CopilotTokenState> {
  _domain = normalizeDomain(domain)

  // Step 1: Fetch user profile (R2)
  _profile = await fetchProfile(accessToken, _domain)
  if (_profile) {
    log.info("copilot profile fetched", {
      login: _profile.login,
      subscription: _profile.subscription,
      flagCount: Object.keys(_profile.featureFlags).length,
    })
  }

  // Step 2: Attempt token exchange (R1)
  const endpoints = _profile?.endpoints ?? { api: "https://api.githubcopilot.com" }
  const exchanged = await exchangeToken(accessToken, endpoints)

  _tokenState = {
    capiSessionToken: exchanged?.token ?? null,
    expiresAt: exchanged?.expiresAt ?? 0,
    rawAccessToken: accessToken,
  }

  if (exchanged) {
    log.info("copilot token exchanged", { expiresIn: Math.round((exchanged.expiresAt - Date.now()) / 1000) })
  }

  return _tokenState
}

/** Get a valid bearer token, auto-refreshing if expired (DD-4: refresh also updates profile). */
export async function getBearer(): Promise<string> {
  if (!_tokenState) throw new Error("copilot-cli auth not initialized")

  // If we have a capiSessionToken and it's not expired, use it
  if (_tokenState.capiSessionToken && _tokenState.expiresAt > Date.now() + 60_000) {
    return _tokenState.capiSessionToken
  }

  // Token expired or missing — try to refresh (DD-4: also refreshes profile)
  if (_tokenState.capiSessionToken) {
    log.info("copilot token expired, refreshing")
    const refreshed = await initAuth(_tokenState.rawAccessToken, _domain)
    if (refreshed.capiSessionToken) {
      return refreshed.capiSessionToken
    }
  }

  // Fallback: raw OAuth token (DD-2)
  return _tokenState.rawAccessToken
}

// ---------------------------------------------------------------------------
// OAuth Device Flow (moved from old copilot.ts, self-contained)
// ---------------------------------------------------------------------------

export interface DeviceFlowResult {
  url: string
  instructions: string
  method: "auto"
  callback(): Promise<
    | { type: "success"; refresh: string; access: string; expires: number; username?: string; email?: string; provider?: string; enterpriseUrl?: string }
    | { type: "failed" }
  >
}

export async function startDeviceFlow(inputs: Record<string, string | undefined> = {}): Promise<DeviceFlowResult> {
  const deploymentType = inputs.deploymentType || "github.com"

  let domain = "github.com"
  let actualProvider = "copilot-cli"

  if (deploymentType === "enterprise") {
    domain = normalizeDomain(inputs.enterpriseUrl!)
    actualProvider = "copilot-cli" // same family for enterprise
  }

  const urls = getUrls(domain)

  const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `opencode/${Installation.VERSION}`,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  })

  if (!deviceResponse.ok) {
    throw new Error("Failed to initiate device authorization")
  }

  const deviceData = (await deviceResponse.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
    expires_in?: number
  }

  return {
    url: deviceData.verification_uri,
    instructions: `Enter code: ${deviceData.user_code}`,
    method: "auto" as const,
    async callback() {
      const startedAt = Date.now()
      const expiresMs = deviceData.expires_in ? deviceData.expires_in * 1000 : undefined
      let pollIntervalMs = (deviceData.interval || 5) * 1000

      while (true) {
        if (expiresMs && Date.now() - startedAt > expiresMs) {
          return { type: "failed" as const }
        }

        let response: Response
        try {
          response = await fetch(urls.ACCESS_TOKEN_URL, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "User-Agent": `opencode/${Installation.VERSION}`,
            },
            body: JSON.stringify({
              client_id: CLIENT_ID,
              device_code: deviceData.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          })
        } catch {
          await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
          continue
        }

        let data: any
        try {
          data = await response.json()
        } catch {
          if (!response.ok) return { type: "failed" as const }
          await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
          continue
        }

        if (typeof data.interval === "number" && data.interval > 0) {
          pollIntervalMs = data.interval * 1000
        }

        if (data.access_token) {
          // Fetch GitHub user identity
          const apiBase = domain === "github.com" ? "https://api.github.com" : `https://${domain}/api/v3`
          let username: string | undefined
          let email: string | undefined
          try {
            const userResp = await fetch(`${apiBase}/user`, {
              headers: {
                Authorization: `Bearer ${data.access_token}`,
                Accept: "application/json",
                "User-Agent": "opencode",
              },
            })
            if (userResp.ok) {
              const userData = (await userResp.json()) as { login?: string; email?: string }
              username = userData.login
              email = userData.email || undefined
            }
          } catch {
            // Non-fatal
          }

          // Initialize auth state (profile + token exchange)
          await initAuth(data.access_token, domain)

          const result: {
            type: "success"
            refresh: string
            access: string
            expires: number
            username?: string
            email?: string
            provider?: string
            enterpriseUrl?: string
          } = {
            type: "success",
            refresh: data.access_token,
            access: data.access_token,
            expires: 0,
            username,
            email,
          }

          if (deploymentType === "enterprise") {
            result.enterpriseUrl = domain
          }

          return result
        }

        if (data.error === "authorization_pending") {
          await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
          continue
        }

        if (data.error === "slow_down") {
          pollIntervalMs = pollIntervalMs + 5000
          await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
          continue
        }

        if (data.error === "access_denied" || data.error === "expired_token") {
          return { type: "failed" as const }
        }

        if (data.error) return { type: "failed" as const }

        await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
      }
    },
  }
}
