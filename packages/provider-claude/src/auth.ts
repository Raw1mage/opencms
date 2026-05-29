/**
 * OAuth PKCE + token refresh, fully separated from transport.
 *
 * Phase 3: Extracted from anthropic.ts, compatible with existing credentials.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  CLIENT_ID,
  OAUTH,
  AUTHORIZE_SCOPES,
  SUBSCRIPTION_SCOPES,
  REFRESH_SCOPES,
  BETA_OAUTH,
} from "./protocol.js"

/**
 * User-Agent for the OAuth token endpoint.
 *
 * CRITICAL: do NOT send `claude-code/<ver>` here. The official CLI reserves
 * that UA for *inference* (api.anthropic.com); its OAuth calls (`Zn8`/refresh)
 * go through plain axios, so the token endpoint sees `axios/x`. Empirically
 * (probed 2026-05-30) `platform.claude.com/v1/oauth/token` throttles the
 * `claude-code/<ver>` UA on this endpoint — every request with it returns 429
 * `rate_limit_error` *before* credential validation, while `axios/*` (and in
 * fact any other UA) reaches validation (400 on a bad grant). Likely an
 * anti-impersonation throttle: the real client never uses `claude-code/<ver>`
 * here. So mirror upstream — present as axios. The exact version is not
 * validated server-side (any non-`claude-code` UA passes); we track the real
 * bundled version purely for fidelity.
 *
 * Value source: claude-code npm bundle ships axios `YPH = "1.13.6"`, and its
 * http adapter sends `"axios/" + YPH`. Re-sync this when refs/claude-code-npm
 * bumps axios (grep cli.js for `"axios/"+` then resolve the version var).
 */
const OAUTH_USER_AGENT = "axios/1.13.6"

/**
 * Headers for the OAuth token endpoint (exchange + refresh). Matches the
 * official CLI's per-request set on this call: just `Content-Type`, plus the
 * axios User-Agent the request would carry through claude-code's HTTP client.
 */
function oauthHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": OAUTH_USER_AGENT,
  }
}

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
  // Authorization SERVER differs by mode: subscription (Max/Pro) authorizes at
  // the Claude.ai server (claude.com/cai), the console (API-key) flow at
  // platform.claude.com. Upstream selects the same way via `loginWithClaudeAi`
  // (CLAUDE_AI_AUTHORIZE_URL vs CONSOLE_AUTHORIZE_URL). Sending a Max login to
  // the console authorize server yields a code that fails exchange (observed as
  // a 429 rate_limit_error at the token endpoint), even though redirect_uri and
  // the token endpoint itself are shared between both flows.
  const url = new URL(mode === "console" ? OAUTH.authorizeConsole : OAUTH.authorizeClaude)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", OAUTH.redirectUri)
  // Subscription (max) must NOT request org:create_api_key — only the console
  // (API-key) flow may. Upstream selects scopes by mode the same way.
  url.searchParams.set(
    "scope",
    mode === "console" ? AUTHORIZE_SCOPES : SUBSCRIPTION_SCOPES.join(" "),
  )
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
): Promise<{ type: "success"; refresh: string; access: string; expires: number }> {
  const splits = code.split("#")
  const result = await fetch(OAUTH.token, {
    method: "POST",
    headers: oauthHeaders(),
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: OAUTH.redirectUri,
      code_verifier: verifier,
    }),
  })
  if (!result.ok) {
    // Surface the real status + body — previously this swallowed everything and
    // returned a bare "failed", so a 429 (OAuth endpoint rate-limited) and a 400
    // (invalid_grant / scope mismatch) were indistinguishable to the user.
    const body = await result.text().catch(() => "unknown error")
    throw new Error(`Token exchange failed (${result.status}): ${body}`)
  }
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

/**
 * Refresh failure carrying the HTTP status and a `needsReauth` classifier.
 * 400/401/403 ⇒ the login is dead, re-authenticate (don't keep retrying).
 * 429 ⇒ the OAuth endpoint is rate-limiting us; back off (see the cooldown in
 * {@link refreshTokenWithMutex}) — retry-storming is what earns the 429.
 */
export class TokenRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly needsReauth: boolean,
  ) {
    super(message)
    this.name = "TokenRefreshError"
  }
}

export async function refreshToken(
  refreshTokenValue: string,
  clientId: string = CLIENT_ID,
): Promise<TokenSet> {
  const response = await fetch(OAUTH.token, {
    method: "POST",
    headers: oauthHeaders(),
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: clientId,
      scope: REFRESH_SCOPES.join(" "),
    }),
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error")
    const needsReauth = response.status === 400 || response.status === 401 || response.status === 403
    const hint = needsReauth
      ? "claude-cli login expired — please re-authenticate."
      : "Please re-authenticate."
    throw new TokenRefreshError(
      `Token refresh failed (${response.status}): ${errorText}. ${hint}`,
      response.status,
      needsReauth,
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
    // Official profile call sends anthropic-beta alongside the bearer token.
    headers: { ...oauthHeaders(), "anthropic-beta": BETA_OAUTH, Authorization: `Bearer ${accessToken}` },
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

/** Storm guard: after a refresh failure, suppress further attempts on the same
 *  token for a cooldown window so we don't hammer the OAuth endpoint (which is
 *  what triggers the 429 in the first place). */
const REFRESH_COOLDOWN_MS = 60_000
const _refreshCooldown = new Map<string, { until: number; error: unknown }>()

/**
 * Ensure only one refresh happens at a time, and back off after failures.
 * Concurrent callers await the same promise; callers within the cooldown after
 * a failure get the cached error without touching the network.
 */
export async function refreshTokenWithMutex(
  refreshTokenValue: string,
  clientId?: string,
): Promise<TokenSet> {
  const cd = _refreshCooldown.get(refreshTokenValue)
  if (cd && Date.now() < cd.until) throw cd.error
  if (_refreshPromise) return _refreshPromise

  _refreshPromise = refreshToken(refreshTokenValue, clientId)
    .then((tokens) => {
      _refreshCooldown.delete(refreshTokenValue)
      return tokens
    })
    .catch((error) => {
      _refreshCooldown.set(refreshTokenValue, { until: Date.now() + REFRESH_COOLDOWN_MS, error })
      throw error
    })
    .finally(() => {
      _refreshPromise = null
    })

  return _refreshPromise
}

// ---------------------------------------------------------------------------
// § 3.5b  Import from the official Claude Code CLI credential store
// ---------------------------------------------------------------------------

export interface LocalClaudeCredentials {
  access: string
  refresh: string
  expires: number
  scopes?: string[]
  subscriptionType?: string
}

/**
 * Read the official Claude Code CLI's stored OAuth credential
 * (`~/.claude/.credentials.json` → `claudeAiOauth`). opencode's claude provider
 * shares the same OAuth client_id, scopes and endpoints, so this token is
 * directly reusable — letting users import an existing local login instead of
 * re-running the OAuth flow. Returns null if absent / unreadable / malformed.
 */
export function readLocalClaudeCredentials(
  path = join(homedir(), ".claude", ".credentials.json"),
): LocalClaudeCredentials | null {
  try {
    const oauth = JSON.parse(readFileSync(path, "utf8"))?.claudeAiOauth
    if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) return null
    return {
      access: oauth.accessToken,
      refresh: oauth.refreshToken,
      expires: oauth.expiresAt,
      scopes: oauth.scopes,
      subscriptionType: oauth.subscriptionType,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// § 3.6  Credential schema validation — backward compatible
// ---------------------------------------------------------------------------

export function isClaudeCredentials(value: unknown): value is ClaudeCredentials {
  if (!value || typeof value !== "object") return false
  const type = (value as { type?: unknown }).type
  return type === "oauth" || type === "subscription"
}
