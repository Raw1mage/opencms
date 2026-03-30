import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { tryWsTransport } from "./codex-websocket"
import { Installation } from "../installation"
import { Auth, OAUTH_DUMMY_KEY } from "../auth"
import { applyProviderModelCorrections } from "../provider/model-curation"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import z from "zod"
import os from "os"

const log = Log.create({ service: "plugin.codex" })

export const CodexTransportEvent = BusEvent.define(
  "codex.transport",
  z.object({
    sessionId: z.string(),
    transport: z.enum(["ws", "http"]),
    accountId: z.string().optional(),
  }),
)

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
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

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

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

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
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

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  try {
  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    reusePort: true,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          const errorMsg = errorDescription || error
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          const errorMsg = "Missing authorization code"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!pendingOAuth || state !== pendingOAuth.state) {
          const errorMsg = "Invalid state - potential CSRF attack"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined

        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err) => current.reject(err))

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new Error("Login cancelled"))
        pendingOAuth = undefined
        return new Response("Login cancelled", { status: 200 })
      }

      return new Response("Not found", { status: 404 })
    },
  })
  } catch (e) {
    // Port already bound (e.g. from previous daemon) — check if it's our server
    log.warn("oauth server port in use, attempting reuse", { port: OAUTH_PORT, error: String(e) })
    // If we get here, another process holds the port. Not recoverable.
    throw e
  }

  log.info("codex oauth server started", { port: OAUTH_PORT })
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  // Keep the server running — it's shared between openai and codex providers.
  // Stopping it causes EADDRINUSE when the other provider tries to start it.
  // The server is lightweight and idempotent (pendingOAuth gates callback handling).
  pendingOAuth = undefined
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function CodexAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "openai",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        provider.models = applyProviderModelCorrections(provider.id, provider.models)

        // Zero out costs for Codex (included with ChatGPT subscription)
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            stripDummyAuthHeader(init)

            // Rotation-aware auth: if x-opencode-account-id header is set by
            // rotation, resolve that account's token instead of the closure default.
            const rotationAccountId = extractHeader(init, "x-opencode-account-id")
            const currentAuth = rotationAccountId
              ? (await Auth.get(rotationAccountId)) ?? (await getAuth())
              : await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)
            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }
            if (rotationAccountId && !authWithAccount.accountId) {
              log.warn("rotation account auth resolved but missing accountId", { rotationAccountId })
            }
            await refreshIfNeeded(currentAuth, authWithAccount, "openai", input.client)

            const headers = buildCodexHeaders(init, currentAuth.access, authWithAccount.accountId)
            const parsed = parseCodexUrl(requestInput)
            const isCodexEndpoint =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
            const url = isCodexEndpoint ? new URL(CODEX_API_ENDPOINT) : parsed

            if (isCodexEndpoint) {
              let bodyString: string | undefined
              if (init?.body) {
                bodyString = typeof init.body === "string" ? init.body : undefined
              } else if (requestInput instanceof Request) {
                try { bodyString = await requestInput.clone().text() } catch (e) {
                  log.warn("codex failed to read request body (openai provider)", { error: String(e) })
                }
              }
              if (bodyString) {
                try {
                  if (!init) init = {}
                  init.body = transformCodexBody(bodyString)
                  if (!init.method && requestInput instanceof Request) init.method = requestInput.method
                } catch (e) {
                  log.warn("codex body transform failed (openai provider)", { error: String(e) })
                }
              }
            }

            return fetch(url, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${Installation.VERSION}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = await tokenResponse.json()

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await Bun.sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerId !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
  }
}

/** Per-session turn state for sticky routing + delta tracking. Keyed by sessionID. */
const codexTurnStates = new Map<string, { turnState?: string; lastInputLength?: number }>()

// ── Shared helpers for CodexAuthPlugin / CodexNativeAuthPlugin ──

/**
 * Extract a header value from RequestInit, handling all header representations.
 * Removes the header after extraction so it doesn't leak to the upstream API.
 */
function extractHeader(init: RequestInit | undefined, name: string): string | undefined {
  if (!init?.headers) return undefined
  const lowerName = name.toLowerCase()
  let value: string | undefined
  if (init.headers instanceof Headers) {
    value = init.headers.get(lowerName) ?? undefined
    if (value) init.headers.delete(lowerName)
  } else if (Array.isArray(init.headers)) {
    const idx = init.headers.findIndex(([k]) => k.toLowerCase() === lowerName)
    if (idx >= 0) {
      value = String(init.headers[idx][1])
      init.headers.splice(idx, 1)
    }
  } else {
    for (const key of Object.keys(init.headers)) {
      if (key.toLowerCase() === lowerName) {
        value = String(init.headers[key])
        delete init.headers[key]
        break
      }
    }
  }
  return value
}

function stripDummyAuthHeader(init?: RequestInit) {
  if (!init?.headers) return
  if (init.headers instanceof Headers) {
    init.headers.delete("authorization")
    init.headers.delete("Authorization")
  } else if (Array.isArray(init.headers)) {
    init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
  } else {
    delete init.headers["authorization"]
    delete init.headers["Authorization"]
  }
}

function buildCodexHeaders(init: RequestInit | undefined, accessToken: string, accountId?: string): Headers {
  const headers = new Headers()
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => headers.set(key, value))
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        if (value !== undefined) headers.set(key, String(value))
      }
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (value !== undefined) headers.set(key, String(value))
      }
    }
  }
  headers.set("authorization", `Bearer ${accessToken}`)
  if (accountId) headers.set("ChatGPT-Account-Id", accountId)
  return headers
}

function transformCodexBody(bodyString: string): string {
  const body = JSON.parse(bodyString)
  // Codex endpoint requires top-level instructions
  const messages = body.messages || []
  const systemMsg = messages.find((m: any) => m.role === "system" || m.role === "developer")
  body.instructions = systemMsg ? systemMsg.content : "You are a helpful assistant."
  delete body.max_output_tokens
  delete body.max_tokens
  return JSON.stringify(body)
}

function parseCodexUrl(requestInput: RequestInfo | URL): URL {
  return requestInput instanceof URL
    ? requestInput
    : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
}

async function refreshIfNeeded(
  currentAuth: any,
  authWithAccount: any,
  providerId: string,
  client: PluginInput["client"],
) {
  if (currentAuth.access && currentAuth.expires >= Date.now()) return
  log.info("refreshing codex access token", { provider: providerId })
  const tokens = await refreshAccessToken(currentAuth.refresh)
  const newAccountId = extractAccountId(tokens) || authWithAccount.accountId
  await client.auth.set({
    path: { id: providerId },
    body: {
      type: "oauth",
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ...(newAccountId && { accountId: newAccountId }),
    },
  })
  currentAuth.access = tokens.access_token
  authWithAccount.accountId = newAccountId
}


// Old WS implementation removed — replaced by codex-websocket.ts transport adapter

/**
 * CodexNativeAuthPlugin — OAuth auth + efficiency optimizations for "codex" provider.
 */
export async function CodexNativeAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "codex",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Zero out costs (ChatGPT subscription)
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            stripDummyAuthHeader(init)

            // Rotation-aware auth: if x-opencode-account-id header is set by
            // rotation, resolve that account's token instead of the closure default.
            const rotationAccountId = extractHeader(init, "x-opencode-account-id")
            const currentAuth = rotationAccountId
              ? (await Auth.get(rotationAccountId)) ?? (await getAuth())
              : await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)
            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }
            if (rotationAccountId && !authWithAccount.accountId) {
              log.warn("rotation account auth resolved but missing accountId", { rotationAccountId })
            }
            await refreshIfNeeded(currentAuth, authWithAccount, "codex", input.client)

            const headers = buildCodexHeaders(init, currentAuth.access, authWithAccount.accountId)

            // Sticky routing: replay per-session turn state
            const sessionId = headers.get("session_id") || ""
            const turnState = codexTurnStates.get(sessionId)
            if (turnState?.turnState) {
              headers.set("x-codex-turn-state", turnState.turnState)
            }

            const parsed = parseCodexUrl(requestInput)
            const isCodexEndpoint =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions") || parsed.pathname.includes("/codex/responses")
            const url = isCodexEndpoint ? new URL(CODEX_API_ENDPOINT) : parsed

            if (isCodexEndpoint) {
              let bodyString: string | undefined
              if (init?.body) {
                bodyString = typeof init.body === "string" ? init.body : undefined
              } else if (requestInput instanceof Request) {
                try { bodyString = await requestInput.clone().text() } catch (e) {
                  log.warn("codex failed to read request body", { error: String(e) })
                }
              }
              if (bodyString) {
                try {
                  const body = JSON.parse(transformCodexBody(bodyString))

                  // Prompt cache fallback: inject if AI SDK adapter didn't set it
                  if (!body.prompt_cache_key) {
                    body.prompt_cache_key = `codex-${authWithAccount.accountId || "default"}`
                  }

                  // Server-side inline compaction (context_management)
                  if (!body.context_management) {
                    body.context_management = [{ type: "compaction", compact_threshold: 100000 }]
                  }

                  // Incremental delta: trim input to only new items when previous_response_id is set
                  const fullInputLength = Array.isArray(body.input) ? body.input.length : 0
                  let deltaMode = false
                  if (body.previous_response_id && Array.isArray(body.input) && sessionId) {
                    const lastLen = turnState?.lastInputLength ?? 0
                    if (lastLen > 0 && body.input.length > lastLen) {
                      body.input = body.input.slice(lastLen)
                      deltaMode = true
                    }
                  }
                  // Track input length for next delta (use full length, not trimmed)
                  if (sessionId) {
                    codexTurnStates.set(sessionId, { ...turnState, lastInputLength: fullInputLength })
                  }

                  const inputItems = Array.isArray(body.input) ? body.input.length : 0
                  console.error(`[DELTA-HTTP] session=${sessionId} delta=${deltaMode} inputItems=${inputItems} fullItems=${fullInputLength} hasPrevResp=${!!body.previous_response_id} lastLen=${turnState?.lastInputLength ?? 0}`)
                  log.info("codex fetch body transform", {
                    hasCacheKey: !!body.prompt_cache_key,
                    hasTurnState: !!turnState?.turnState,
                    hasContextMgmt: !!body.context_management,
                    deltaMode,
                    inputItems,
                    fullInputItems: fullInputLength,
                  })

                  if (!init) init = {}
                  init.body = JSON.stringify(body)
                  if (!init.method && requestInput instanceof Request) init.method = requestInput.method
                } catch (e) {
                  log.warn("codex body transform failed", { error: String(e) })
                }
              }
            }

            // Transport decision: WebSocket (if available) or HTTP
            // WS is a transport adapter per specs/codex/provider_runtime/ DD-4
            log.info("ws transport check", { sessionId, isCodexEndpoint })
            if (isCodexEndpoint && sessionId) {
              try {
                const wsUrl = CODEX_API_ENDPOINT.replace("https://", "wss://")
                const wsResponse = await tryWsTransport({
                  sessionId,
                  accessToken: currentAuth.access,
                  accountId: authWithAccount.accountId,
                  turnState: turnState?.turnState,
                  body: init?.body ? JSON.parse(typeof init.body === "string" ? init.body : "") : {},
                  wsUrl,
                })
                if (wsResponse) {
                  Bus.publish(CodexTransportEvent, { sessionId, transport: "ws", accountId: authWithAccount.accountId }).catch(() => {})
                  return wsResponse
                }
              } catch (e) {
                log.warn("ws transport error, falling back to HTTP", { sessionId, error: String(e).slice(0, 100) })
              }
            }

            // HTTP path (default or WS fallback)
            if (sessionId) {
              Bus.publish(CodexTransportEvent, { sessionId, transport: "http", accountId: authWithAccount.accountId }).catch(() => {})
            }
            const response = await fetch(url, { ...init, headers })

            // Guard: Codex returns JSON error bodies (e.g. usage_limit_reached)
            // instead of SSE streams. Detect and throw so AI SDK sees a real error
            // rather than silently producing finishReason=unknown with 0 tokens.
            if (!response.ok) {
              const ct = response.headers.get("content-type") ?? ""
              if (ct.includes("application/json") || !ct.includes("text/event-stream")) {
                const body = await response.text()
                log.warn("codex HTTP error", { status: response.status, body: body.slice(0, 300) })
                throw new Error(`Codex API error (${response.status}): ${body.slice(0, 200)}`)
              }
            }

            const newTurnState = response.headers.get("x-codex-turn-state")
            if (newTurnState && sessionId) {
              codexTurnStates.set(sessionId, { ...turnState, turnState: newTurnState })
              log.info("codex turn state captured", { sessionId, turnState: newTurnState.slice(0, 20) + "..." })
            }
            return response
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            const state = generateState()
            const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            return {
              url: authUrl,
              instructions: "Open the link above in any browser, login, then paste the callback URL here",
              method: "code" as const,
              async callback(pastedUrl: string) {
                try {
                  let code = pastedUrl.trim()
                  try {
                    const parsed = new URL(code)
                    code = parsed.searchParams.get("code") ?? code
                  } catch {}

                  const tokens = await exchangeCodeForTokens(code, redirectUri, pkce)
                  const accountId = extractAccountId(tokens)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    accountId,
                  }
                } catch (e) {
                  log.error("codex paste-URL token exchange failed", { error: String(e) })
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (device code)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${Installation.VERSION}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })
            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }
                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })
                    if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    const tokens: TokenResponse = await tokenResponse.json()
                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }
                  await Bun.sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerId !== "codex") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
    // Reset sticky routing on new user message, but preserve lastInputLength for delta tracking
    "chat.message": async (input) => {
      if (input.model?.providerId === "codex") {
        const existing = codexTurnStates.get(input.sessionID)
        if (existing) {
          existing.turnState = undefined
        }
      }
    },
  }
}
