import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { generatePKCE } from "@openauthjs/openauth/pkce"

const log = Log.create({ service: "plugin.anthropic" })

// GLOBAL CONSTANTS
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const VERSION = "2.1.37"
const ATTRIBUTION_SALT = "59cf53e54c78"

// STATE
const SESSIONS_INITIALIZED = new Map<string, string>()
const ENVIRONMENTS_CACHE = new Map<string, string>()

/**
 * Logic from T8A function in cli.js: sha256(salt + content[4,7,20] + version)
 */
function calculateAttributionHash(content: string): string {
  const indices = [4, 7, 20]
  const chars = indices.map((idx) => content[idx] || "0").join("")
  const input = `${ATTRIBUTION_SALT}${chars}${VERSION}`

  // Use globalThis.crypto for broad compatibility if node:crypto is failing LSP
  // For simplicity in this environment, assume Bun or Node global crypto
  // @ts-ignore
  const hash = new Bun.CryptoHasher("sha256").update(input).digest("hex")
  return hash.slice(0, 3)
}

function getBillingHeader(content: string): string {
  const hash = calculateAttributionHash(content)
  const ccVersion = `${VERSION}.${hash}`
  return `cc_version=${ccVersion}; cc_entrypoint=unknown; cch=00000;`
}

async function authorize(mode: "max" | "console") {
  const pkce = await generatePKCE()
  const url = new URL(`https://platform.claude.com/oauth/authorize`)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", "https://platform.claude.com/oauth/code/callback")
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
  )
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return { url: url.toString(), verifier: pkce.verifier }
}

async function exchange(code: string, verifier: string) {
  const splits = code.split("#")
  const result = await fetch("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  })
  if (!result.ok) return { type: "failed" as const }
  const json = await result.json()
  return {
    type: "success" as const,
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  const { client } = input
  return {
    "chat.headers": async (input, output) => {
      if (input.model.providerId === "anthropic") {
        output.headers["session_id"] = input.sessionID
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      if (input.model?.providerId === "anthropic") {
        output.system.unshift(prefix)
        if (output.system[1]) output.system[1] = prefix + "\n\n" + output.system[1]
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = (await getAuth()) as any
        if (auth.type === "api") return { apiKey: auth.key }
        if (auth.type === "oauth") {
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
          }
          return {
            apiKey: "",
            fetch: async (reqInput: RequestInfo | URL, init?: RequestInit) => {
              const auth = (await getAuth()) as any
              if (auth.type !== "oauth") return fetch(reqInput, init)

              // Token Refresh
              if (!auth.access || auth.expires < Date.now()) {
                const response = await fetch("https://platform.claude.com/v1/oauth/token", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    grant_type: "refresh_token",
                    refresh_token: auth.refresh,
                    client_id: CLIENT_ID,
                    scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
                  }),
                })
                if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
                const json = await response.json()
                const accountId = auth.accountId || "anthropic"
                await client.auth.set({
                  path: { id: accountId },
                  body: {
                    type: "oauth",
                    refresh: json.refresh_token ?? auth.refresh,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000,
                    orgID: auth.orgID,
                    accountId: auth.accountId,
                    email: auth.email,
                  } as any,
                })
                auth.access = json.access_token
                auth.refresh = json.refresh_token ?? auth.refresh
              }

              const requestInit = init ?? {}
              const requestHeaders = new Headers(init?.headers)
              const sessionId =
                requestHeaders.get("session_id") || requestHeaders.get("anthropic-session-id") || "default-session"

              // Base Headers (S0 + jH)
              requestHeaders.set("Authorization", `Bearer ${auth.access}`)
              requestHeaders.set("anthropic-version", "2023-06-01")
              requestHeaders.set("Content-Type", "application/json")
              requestHeaders.set("User-Agent", `claude-code/${VERSION}`)
              requestHeaders.set("anthropic-beta", "oauth-2025-04-20,claude-code-20250219")
              requestHeaders.set("x-anthropic-additional-protection", "true")
              if (auth.orgID) requestHeaders.set("x-organization-uuid", auth.orgID)

              // Strip problematic OpenCode framework headers
              requestHeaders.delete("x-api-key")
              requestHeaders.delete("anthropic-client")
              requestHeaders.delete("x-app")
              requestHeaders.delete("x-opencode-tools-debug")

              const TOOL_PREFIX = "mcp_"
              let body = requestInit.body
              let requestInput = reqInput

              let requestUrl: URL | null = null
              try {
                const urlStr = typeof reqInput === "string" ? reqInput : (reqInput as any).url || reqInput.toString()
                requestUrl = new URL(urlStr)
              } catch {
                requestUrl = null
              }

              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body)
                  if (requestUrl && requestUrl.pathname === "/v1/messages") {
                    const messages = parsed.messages || []
                    const lastMessage = messages[messages.length - 1]
                    const userContent =
                      typeof lastMessage?.content === "string"
                        ? lastMessage.content
                        : JSON.stringify(lastMessage?.content || "")

                    // Add Billing Header with dynamic attribution hash
                    requestHeaders.set("x-anthropic-billing-header", getBillingHeader(userContent))

                    // 1. Environment Discovery
                    let environmentId = ENVIRONMENTS_CACHE.get(auth.orgID)
                    if (!environmentId && auth.orgID) {
                      try {
                        const envResponse = await fetch("https://api.anthropic.com/v1/environment_providers", {
                          headers: {
                            Authorization: `Bearer ${auth.access}`,
                            "anthropic-version": "2023-06-01",
                            "x-organization-uuid": auth.orgID,
                            "User-Agent": `claude-code/${VERSION}`,
                            "x-anthropic-billing-header": getBillingHeader(""),
                          },
                        })
                        if (envResponse.ok) {
                          const envData = await envResponse.json()
                          if (envData.environments && envData.environments.length > 0) {
                            environmentId = envData.environments[0].environment_id
                            ENVIRONMENTS_CACHE.set(auth.orgID, environmentId!)
                          }
                        }
                      } catch (e) {
                        log.debug("Env fetch error", { error: e })
                      }
                    }

                    // 2. Session Lifecycle
                    if (!SESSIONS_INITIALIZED.has(sessionId)) {
                      try {
                        const sessionResponse = await fetch("https://api.anthropic.com/v1/sessions", {
                          method: "POST",
                          headers: {
                            Authorization: `Bearer ${auth.access}`,
                            "anthropic-version": "2023-06-01",
                            "Content-Type": "application/json",
                            "x-organization-uuid": auth.orgID || "",
                            "User-Agent": `claude-code/${VERSION}`,
                            "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
                            "x-anthropic-billing-header": getBillingHeader(""),
                          },
                          body: JSON.stringify({
                            title: "OpenCode Session",
                            session_context: {
                              model: parsed.model || "claude-3-7-sonnet-latest",
                              sources: [],
                              outcomes: [],
                            },
                            environment_id: environmentId || "default",
                            events: [],
                          }),
                        })
                        if (sessionResponse.ok) {
                          const sessionData = await sessionResponse.json()
                          if (sessionData.id) {
                            SESSIONS_INITIALIZED.set(sessionId, sessionData.id)
                            log.info("Anthropic Server Session Created", { serverId: sessionData.id })
                          }
                        }
                      } catch (e) {
                        log.debug("Session create error", { error: e })
                      }
                    }

                    const serverSessionId = SESSIONS_INITIALIZED.get(sessionId)
                    if (lastMessage && serverSessionId) {
                      // 3. REROUTE TO SESSIONS API EVENTS
                      requestInput = `https://api.anthropic.com/v1/sessions/${serverSessionId}/events`

                      // Strip caching headers added by ProviderTransform
                      if (Array.isArray(lastMessage.content)) {
                        lastMessage.content = lastMessage.content.map((part: any) => {
                          if (part.providerOptions) delete part.providerOptions
                          return part
                        })
                      }
                      if (lastMessage.providerOptions) delete lastMessage.providerOptions

                      body = JSON.stringify({
                        events: [
                          {
                            uuid: crypto.randomUUID(),
                            session_id: serverSessionId,
                            type: "user",
                            parent_tool_use_id: null,
                            message: {
                              role: lastMessage.role,
                              content: lastMessage.content,
                            },
                            cwd: "/home/pkcs12/opencode",
                            userType: "external",
                            version: VERSION,
                            isSidechain: false,
                          },
                        ],
                      })
                      log.info("Rerouted to Sessions API", { serverSessionId })
                    }
                  } else {
                    body = JSON.stringify(parsed)
                  }
                } catch (e) {
                  /* ignore parse errors */
                }
              }

              return fetch(requestInput, { ...requestInit, body, headers: requestHeaders })
            },
          }
        }
        return {}
      },
      methods: [
        {
          label: "Claude account with subscription · Pro, Max, Team, or Enterprise",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max")
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === "failed") return credentials
                try {
                  const profile = await fetch("https://api.anthropic.com/api/oauth/profile", {
                    headers: { Authorization: `Bearer ${credentials.access}` },
                  }).then((r) => r.json())
                  return {
                    ...credentials,
                    orgID: profile.organization_uuid,
                    email: profile.email,
                    accountId: profile.email,
                  } as any
                } catch (e) {
                  return credentials
                }
              },
            }
          },
        },
        {
          label: "Anthropic Console account · API usage billing",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console")
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === "failed") return credentials
                const result = await fetch(`https://api.anthropic.com/api/oauth/claude_cli/create_api_key`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", authorization: `Bearer ${credentials.access}` },
                }).then((r) => r.json())
                return { type: "success", key: result.raw_key }
              },
            }
          },
        },
        { label: "3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI", type: "api" },
      ],
    },
  }
}
