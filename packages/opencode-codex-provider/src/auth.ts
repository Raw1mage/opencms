/**
 * Codex OAuth authentication.
 *
 * PKCE + device code flows against auth.openai.com.
 * Extracted from plugin/codex.ts — self-contained, no opencode imports.
 */
import { CLIENT_ID, ISSUER } from "./protocol.js"
import type { CodexCredentials, TokenResponse, IdTokenClaims } from "./types.js"

// ---------------------------------------------------------------------------
// § 1  Token refresh
// ---------------------------------------------------------------------------

// Per-token mutex map. Coalesces concurrent refreshes that hold the SAME
// refresh_token (the rotation race surface) — multiple sessions or in-flight
// callers refreshing the same account share one upstream call. Keyed on the
// refresh_token itself so different accounts never share a promise (the
// previous module-level single-promise design returned the wrong account's
// tokens to the loser of a parallel call). Map self-cleans on settle.
const refreshPromises = new Map<string, Promise<TokenResponse | null>>()

/**
 * Refresh with per-token mutex — prevents same-account refresh storms inside
 * one process. Cross-process protection (e.g. opencode + opencode-beta both
 * holding the same refresh_token) is NOT covered here; that would need a
 * file-lock or a single-owner persistence layer.
 */
export async function refreshTokenWithMutex(refreshToken: string): Promise<TokenResponse | null> {
  if (!refreshToken) return null
  const existing = refreshPromises.get(refreshToken)
  if (existing) return existing
  const promise = refreshAccessToken(refreshToken).finally(() => {
    refreshPromises.delete(refreshToken)
  })
  refreshPromises.set(refreshToken, promise)
  return promise
}

/**
 * Refresh a codex OAuth access token.
 *
 * Outcome contract:
 *   • 2xx  → resolves with TokenResponse (happy path)
 *   • 4xx  → resolves with null (refresh_token is permanently dead — revoked,
 *            expired, or signed for a different client). Caller MUST stop
 *            retrying with this refresh_token; only re-login can recover.
 *   • 5xx / network error → throws (transient; caller may retry later)
 *
 * Returning null on 4xx is the contract that prevents
 * "dead refresh keeps getting hit" — once the upstream says permanent,
 * we surface that as a settled value so callers can persist the
 * dead-state and stop attempting. Throwing for transient failure
 * preserves real error visibility.
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse | null> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (response.ok) return response.json()
  if (response.status >= 400 && response.status < 500) return null
  throw new Error(`Token refresh failed: ${response.status}`)
}

/**
 * Revoke an OAuth refresh token upstream.
 *
 * Mirrors upstream codex-rs commit 22f7ef1cb7 (2026) — logout must notify the
 * OAuth edge before clearing local state, otherwise the backend token lives on
 * detached from any client record. Fail-closed is handled by the caller: this
 * helper throws on any non-2xx or network error so the caller can preserve
 * local credentials and surface the failure.
 *
 * Note: auth.openai.com diverges from RFC 7009 — the revoke endpoint rejects
 * application/x-www-form-urlencoded and requires application/json.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const response = await fetch(`${ISSUER}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    // Truncate body in case upstream echoes the token or other sensitive data.
    const snippet = body.slice(0, 200)
    throw new Error(`Token revoke failed: HTTP ${response.status}${snippet ? ` — ${snippet}` : ""}`)
  }
  // 200/204 is a success per RFC 7009. No body content expected.
}

// ---------------------------------------------------------------------------
// § 2  PKCE helpers
// ---------------------------------------------------------------------------

export interface PkceCodes {
  verifier: string
  challenge: string
}

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

// ---------------------------------------------------------------------------
// § 3  Token exchange
// ---------------------------------------------------------------------------

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

// ---------------------------------------------------------------------------
// § 4  JWT claim parsing
// ---------------------------------------------------------------------------

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// § 5  Credential validation
// ---------------------------------------------------------------------------

export function isCodexCredentials(value: unknown): value is CodexCredentials {
  if (!value || typeof value !== "object") return false
  return (value as { type?: unknown }).type === "oauth"
}
