/**
 * OAuth PKCE + token refresh, fully separated from transport.
 *
 * Phase 3: Extracted from anthropic.ts, compatible with existing credentials.
 */
import {
  CLIENT_ID,
  OAUTH,
  AUTHORIZE_SCOPES,
  REFRESH_SCOPES,
} from "./protocol.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeCredentials {
  type: "oauth" | "subscription"
  refresh: string
  access?: string
  expires?: number
  accountId?: string
  orgID?: string
  email?: string
}

export interface TokenSet {
  access: string
  expires: number
  refresh?: string
}

export interface Profile {
  email: string
  orgID?: string
}

// ---------------------------------------------------------------------------
// § 3.1  authorize — initiate OAuth PKCE flow
// ---------------------------------------------------------------------------

export async function authorize(
  mode: "max" | "console",
  generatePKCE: () => Promise<{ challenge: string; verifier: string }>,
): Promise<{ url: string; verifier: string }> {
  const pkce = await generatePKCE()
  const url = new URL(OAUTH.authorizeConsole)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", OAUTH.redirectUri)
  url.searchParams.set("scope", AUTHORIZE_SCOPES)
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return { url: url.toString(), verifier: pkce.verifier }
}

// ---------------------------------------------------------------------------
// § 3.2  exchange — exchange authorization code for tokens
// ---------------------------------------------------------------------------

export async function exchange(
  code: string,
  verifier: string,
): Promise<{ type: "success"; refresh: string; access: string; expires: number } | { type: "failed" }> {
  const splits = code.split("#")
  const result = await fetch(OAUTH.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: OAUTH.redirectUri,
      code_verifier: verifier,
    }),
  })
  if (!result.ok) return { type: "failed" }
  const json = await result.json()
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

// ---------------------------------------------------------------------------
// § 3.3  refreshToken — refresh an expired access token
// ---------------------------------------------------------------------------

export async function refreshToken(
  refreshTokenValue: string,
  clientId: string = CLIENT_ID,
): Promise<TokenSet> {
  const response = await fetch(OAUTH.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: clientId,
      scope: REFRESH_SCOPES.join(" "),
    }),
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error")
    throw new Error(
      `Token refresh failed (${response.status}): ${errorText}. Please re-authenticate.`,
    )
  }
  const json = await response.json()
  return {
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
    refresh: json.refresh_token, // may be rotated
  }
}

// ---------------------------------------------------------------------------
// § 3.4  fetchProfile — get user profile from access token
// ---------------------------------------------------------------------------

export async function fetchProfile(accessToken: string): Promise<Profile> {
  const response = await fetch(OAUTH.profile, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Profile fetch failed (${response.status})`)
  }
  const json = await response.json()
  return {
    email: json.emailAddress || json.email,
    orgID: json.organizationUuid || json.organization_uuid,
  }
}

// ---------------------------------------------------------------------------
// § 3.5  Token refresh mutex — prevent concurrent refresh races
// ---------------------------------------------------------------------------

let _refreshPromise: Promise<TokenSet> | null = null

/**
 * Ensure only one refresh happens at a time.
 * Concurrent callers await the same promise.
 */
export async function refreshTokenWithMutex(
  refreshTokenValue: string,
  clientId?: string,
): Promise<TokenSet> {
  if (_refreshPromise) return _refreshPromise

  _refreshPromise = refreshToken(refreshTokenValue, clientId).finally(() => {
    _refreshPromise = null
  })

  return _refreshPromise
}

// ---------------------------------------------------------------------------
// § 3.6  Credential schema validation — backward compatible
// ---------------------------------------------------------------------------

export function isClaudeCredentials(value: unknown): value is ClaudeCredentials {
  if (!value || typeof value !== "object") return false
  const type = (value as { type?: unknown }).type
  return type === "oauth" || type === "subscription"
}
