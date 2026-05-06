/**
 * Codex Auth Plugin — thin auth-only plugin for the native codex provider.
 *
 * Responsibilities:
 * - OAuth credential management (browser + device code flows)
 * - Pass credentials to @opencode-ai/codex-provider via provider options
 * - Zero model costs for Codex Plus
 * - NO fetch interceptor, NO body transform, NO transport logic
 *
 * All protocol behavior lives in @opencode-ai/codex-provider.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  CLIENT_ID,
  CODEX_CLI_VERSION,
  ISSUER,
  ORIGINATOR,
  OAUTH_PORT,
  OAUTH_POLLING_SAFETY_MARGIN_MS,
  extractAccountId,
  exchangeCodeForTokens,
  generatePKCE,
  generateState,
  revokeRefreshToken,
} from "@opencode-ai/codex-provider"
import { createCodex } from "@opencode-ai/codex-provider/provider"
import { isCodexCredentials } from "@opencode-ai/codex-provider/auth"
import { setContinuationFilePath, invalidateContinuation } from "@opencode-ai/codex-provider/continuation"
import { setEmptyTurnLogPath, setEmptyTurnLogBus } from "@opencode-ai/codex-provider/empty-turn-log"
import type { TokenResponse, PkceCodes } from "@opencode-ai/codex-provider"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { Auth } from "../auth"
import { Global } from "../global"
import { BusEvent } from "@/bus/bus-event"
import { codexServerCompact } from "../provider/codex-compaction"
import { Bus } from "../bus"
import { z } from "zod"
import path from "path"
import os from "os"

/**
 * Mimic upstream codex-rs `get_codex_user_agent`:
 * `codex_cli_rs/<ver> (<OS> <release>; <arch>) terminal`
 * UA prefix must match the `originator` header, otherwise OpenAI's first-party
 * classifier downgrades the request to third-party. See default_client.rs.
 */
function buildCodexUserAgent(): string {
  const archMap: Record<string, string> = { x64: "x86_64", arm64: "aarch64", ia32: "i686" }
  const arch = archMap[os.arch()] ?? os.arch()
  const platMap: Record<string, string> = { linux: "Linux", darwin: "Darwin", win32: "Windows" }
  const platform = platMap[os.platform()] ?? os.platform()
  return `codex_cli_rs/${CODEX_CLI_VERSION} (${platform} ${os.release()}; ${arch}) terminal`
}

/** Emitted when WS continuation state is invalidated (e.g., after compaction). */
export const ContinuationInvalidatedEvent = BusEvent.define(
  "codex.continuation.invalidated",
  z.object({
    sessionId: z.string(),
  }),
)

const log = Log.create({ service: "plugin.codex" })

// ── OAuth server (shared with openai provider) ──

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

const HTML_SUCCESS = `<!doctype html><html><head><title>OpenCode - Codex Authorization Successful</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec}.container{text-align:center;padding:2rem}h1{margin-bottom:1rem}p{color:#b7b1b1}</style>
</head><body><div class="container"><h1>Authorization Successful</h1><p>You can close this window.</p></div><script>setTimeout(()=>window.close(),2000)</script></body></html>`

const HTML_ERROR = (msg: string) => `<!doctype html><html><head><title>OpenCode - Codex Authorization Failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#131010;color:#f1ecec}.container{text-align:center;padding:2rem}h1{color:#fc533a;margin-bottom:1rem}p{color:#b7b1b1}.error{color:#ff917b;font-family:monospace;margin-top:1rem;padding:1rem;background:#3c140d;border-radius:.5rem}</style>
</head><body><div class="container"><h1>Authorization Failed</h1><p>An error occurred.</p><div class="error">${msg}</div></div></body></html>`

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

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
          const msg = errorDescription || error
          pendingOAuth?.reject(new Error(msg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(msg), { headers: { "Content-Type": "text/html" } })
        }
        if (!code) {
          pendingOAuth?.reject(new Error("Missing authorization code"))
          pendingOAuth = undefined
          return new Response(HTML_ERROR("Missing authorization code"), { status: 400, headers: { "Content-Type": "text/html" } })
        }
        if (!pendingOAuth || state !== pendingOAuth.state) {
          pendingOAuth?.reject(new Error("Invalid state"))
          pendingOAuth = undefined
          return new Response(HTML_ERROR("Invalid state"), { status: 400, headers: { "Content-Type": "text/html" } })
        }

        const current = pendingOAuth
        pendingOAuth = undefined
        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err) => current.reject(err))
        return new Response(HTML_SUCCESS, { headers: { "Content-Type": "text/html" } })
      }
      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new Error("Login cancelled"))
        pendingOAuth = undefined
        return new Response("Login cancelled", { status: 200 })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  log.info("codex oauth server started", { port: OAUTH_PORT })
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingOAuth) {
        pendingOAuth = undefined
        reject(new Error("OAuth callback timeout"))
      }
    }, 5 * 60 * 1000)

    pendingOAuth = {
      pkce, state,
      resolve: (tokens) => { clearTimeout(timeout); resolve(tokens) },
      reject: (error) => { clearTimeout(timeout); reject(error) },
    }
  })
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
    originator: ORIGINATOR,
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

// Refresh is no longer triggered from the auth-plugin loader path.
// Sole refresh authority is `ensureValidToken` inside @opencode-ai/codex-provider,
// fired on actual API calls. Persistence happens via the `onTokenRefresh`
// callback wired in getModel below — that callback writes new tokens back to
// accounts.json so cross-restart state stays correct.
//
// This eliminates the "open N projects → N parallel /provider calls →
// N parallel refresh attempts → token rotation race kills the account"
// failure mode entirely: /provider no longer triggers any refresh.

// ── Logout (upstream token revoke) ──

/**
 * Revoke a codex OAuth refresh token upstream before local teardown. Mirrors
 * upstream codex-rs 22f7ef1cb7 (logout_with_revoke) — fail-closed so a
 * failed revoke propagates to the caller and local credentials stay in
 * place until the operator can retry. AGENTS.md 第一條.
 *
 * No-op when refreshToken is missing / empty: there is nothing to revoke,
 * but emit log.info so the branch is observable.
 */
export async function logoutCodex(refreshToken: string | undefined | null, context: { accountId?: string } = {}) {
  if (!refreshToken) {
    log.info("codex logout: no refresh token on account, skipping upstream revoke", context)
    return
  }
  try {
    await revokeRefreshToken(refreshToken)
    log.info("codex logout: upstream revoke succeeded", context)
  } catch (err) {
    log.warn("codex logout: upstream revoke failed (fail-closed — local state preserved)", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

// ── Plugin Entry ──

export async function CodexNativeAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    "session.compact": async (_input, output) => {
      // Only handle compaction for codex/openai providers
      if (_input.model.providerId !== "codex" && _input.model.providerId !== "openai") return

      const result = await codexServerCompact({
        model: _input.model.modelID,
        input: _input.conversationItems as unknown[],
        instructions: _input.instructions,
        tools: [],
        parallel_tool_calls: true,
      })

      if (!result.success || !result.output) return

      // Extract human-readable summary from compacted output
      output.compactedItems = result.output
      output.summary =
        result.output
          .filter((item: any) => item.type === "message")
          .flatMap((item: any) => (item.content ?? []).map((c: any) => c.text ?? ""))
          .join("\n") || "[Server-compacted conversation history]"

      log.info("codex server compaction via hook", {
        sessionID: _input.sessionID,
        outputItems: result.output.length,
      })
    },
    auth: {
      provider: "codex",
      async loader(getAuth, provider, accountRecordId) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Zero out costs (ChatGPT subscription)
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        const authWithAccount = auth as typeof auth & { accountId?: string }

        // Initialize continuation file path once
        setContinuationFilePath(path.join(Global.Path.state, "ws-continuation.json"))

        // Initialize empty-turn forensic log path once. JSONL is the load-bearing
        // evidence path per spec codex-empty-turn-recovery Decision D-2; bus
        // mirror is non-load-bearing convenience per DD-2 / INV-06. The provider
        // package never imports Global.Path / Bus directly (INV-16 — provider
        // boundary discipline) — they are injected here at runtime initialization,
        // matching the setContinuationFilePath pattern above.
        setEmptyTurnLogPath(path.join(Global.Path.state, "codex", "empty-turns.jsonl"))
        // Bus mirroring uses the generic GlobalBus EventEmitter directly so we
        // don't need to define a typed BusEvent for what is intentionally a
        // schemaless convenience channel (INV-06 — bus is non-load-bearing).
        // Subscribers that want this signal can listen on GlobalBus "event"
        // and filter on payload.type === "codex.emptyTurn".
        try {
          const { GlobalBus } = await import("../bus/global.js")
          setEmptyTurnLogBus((channel: string, payload: unknown) => {
            try {
              GlobalBus.emit("event", {
                directory: process.cwd(),
                context: { directory: process.cwd() } as any,
                payload: { type: channel, properties: payload },
              })
            } catch {
              /* CET-002: bus publish failure is severity Low by design */
            }
          })
        } catch {
          /* If Bus module is unavailable in this runtime context, skip wiring */
        }

        // Capture client for the onTokenRefresh closure below.
        const authClient = input.client

        // Return credentials + getModel factory for native codex provider
        return {
          apiKey: "codex-oauth", // dummy — native provider ignores this
          type: "oauth",
          refresh: auth.refresh,
          access: auth.access,
          expires: auth.expires,
          accountId: authWithAccount.accountId,
          async getModel(_sdk: any, modelID: string, options?: Record<string, any>) {
            const credentials = options as any
            // Persist via the opencode account record id (post phase 2 family
            // decoupling). Falling back to JWT chatgpt_account_id would route
            // Auth.set to a UUID-keyed phantom family because the registry no
            // longer maps UUID → per-account entry.
            const persistAccountId = accountRecordId ?? credentials?.accountId ?? authWithAccount.accountId
            const provider = createCodex({
              credentials: isCodexCredentials(credentials)
                ? credentials
                : {
                    type: "oauth",
                    refresh: credentials?.refresh ?? "",
                    access: credentials?.access,
                    expires: credentials?.expires,
                    accountId: credentials?.accountId,
                  },
              conversationId: credentials?.conversationId,
              sessionId: credentials?.sessionId,
              installationId: credentials?.installationId,
              userAgent: buildCodexUserAgent(),
              // Persist refreshed (or cleared-on-dead) tokens back to accounts.json
              // so the next bootstrap reads the fresh state instead of replaying a
              // rotated-out refresh_token. Without this, lazy refresh would be
              // memory-only and a process restart would resurrect a dead token.
              onTokenRefresh: async (creds) => {
                await authClient.auth.set({
                  path: { id: persistAccountId ?? "codex" },
                  body: {
                    type: "oauth",
                    refresh: creds.refresh ?? "",
                    access: creds.access ?? "",
                    expires: creds.expires ?? 0,
                    ...(creds.accountId && { accountId: creds.accountId }),
                  },
                })
              },
            })
            return provider.languageModel(modelID)
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
            const { redirectUri } = await startOAuthServer()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)
            const callbackPromise = waitForOAuthCallback(pkce, state)
            return {
              url: authUrl,
              instructions:
                "Open the link in any browser. The window closes automatically once login completes; if it doesn't (e.g. browser is on a different machine), paste the callback URL into the field below.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await callbackPromise
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    accountId: extractAccountId(tokens),
                  }
                } catch (e) {
                  log.error("codex browser auto callback failed", { error: String(e) })
                  return { type: "failed" as const }
                }
              },
              code: async (pastedUrl: string) => {
                try {
                  let code = pastedUrl.trim()
                  try { const parsed = new URL(code); code = parsed.searchParams.get("code") ?? code } catch {}
                  const tokens = await exchangeCodeForTokens(code, redirectUri, pkce)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    accountId: extractAccountId(tokens),
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
              headers: { "Content-Type": "application/json", "User-Agent": `opencode/${Installation.VERSION}` },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })
            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")
            const deviceData = (await deviceResponse.json()) as { device_auth_id: string; user_code: string; interval: string }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "User-Agent": `opencode/${Installation.VERSION}` },
                    body: JSON.stringify({ device_auth_id: deviceData.device_auth_id, user_code: deviceData.user_code }),
                  })
                  if (response.ok) {
                    const data = (await response.json()) as { authorization_code: string; code_verifier: string }
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
                  if (response.status !== 403 && response.status !== 404) return { type: "failed" as const }
                  await Bun.sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
      ],
    },
  }
}
