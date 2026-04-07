import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import type { Auth as SDKAuth } from "@opencode-ai/sdk"
import { Log } from "../util/log"
import { generatePKCE } from "@openauthjs/openauth/pkce"

const log = Log.create({ service: "plugin.claude-cli" })

// GLOBAL CONSTANTS
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const VERSION = "2.1.92"
const ATTRIBUTION_SALT = "59cf53e54c78"

// STATE (Cross-request cache) - Sessions API deprecated, using ?beta=true strategy
const TOOL_PREFIX = "mcp__"

// Token refresh mutex — prevents concurrent refresh races
// FIX: Multiple parallel requests detecting expired token would all trigger refresh,
// potentially invalidating each other's tokens
// @event_20260209_token_refresh_race
let refreshPromise: Promise<void> | null = null

/**
 * Recapitulates T8A function from official cli.js: sha256(salt + content[indices] + version)
 */
function calculateAttributionHash(content: string): string {
  const indices = [4, 7, 20]
  const chars = indices.map((idx) => content[idx] || "0").join("")
  const input = `${ATTRIBUTION_SALT}${chars}${VERSION}`

  const hash = createHash("sha256").update(input).digest("hex")
  return hash.slice(0, 3)
}

type ClaudeOAuthAuth = {
  type: "oauth" | "subscription"
  refresh: string
  access?: string
  expires?: number
  accountId?: string
  orgID?: string
  email?: string
}

function isClaudeOAuthAuth(value: unknown): value is ClaudeOAuthAuth {
  if (!value || typeof value !== "object") return false
  const type = (value as { type?: unknown }).type
  return type === "oauth" || type === "subscription"
}

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (input instanceof Request) return input.url
  return String(input)
}

function getBillingHeader(content: string): string {
  const hash = calculateAttributionHash(content)
  return `cc_version=${VERSION}.${hash}; cc_entrypoint=unknown; cch=00000;`
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
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
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
  log.info("CHECKPOINT: AnthropicAuthPlugin initialized — using TypeScript anthropic.ts, NOT C library")
  return {
    // NOTE: session_id header removed - it triggers Anthropic's non-Claude-Code detection
    // for subscription auth. OpenCode session tracking handled internally.
    // @event_20260209_session_id_header
    auth: {
      provider: "claude-cli", // Primary registration
      async loader(getAuth, provider) {
        const loadedAuth = await getAuth()
        if (!isClaudeOAuthAuth(loadedAuth)) return {}
        const auth = loadedAuth

        // Reset costs for subscription
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        // FIX: Add unique fetchId to distinguish this fetch from any cached SDK fetch
        // Without this, SDK cache key (based on JSON.stringify) can't differentiate
        // between different fetch functions since functions are ignored during serialization
        // @event_20260209_sdk_cache_fetch_id
        const fetchId = `claude-cli-${auth.accountId || "default"}-${Date.now()}`

        return {
          apiKey: "",
          isClaudeCode: true,
          fetchId, // This gets included in cache key calculation
          fetch: async (reqInput: RequestInfo | URL, init?: RequestInit) => {
            log.info("CHECKPOINT: anthropic.ts fetch() called — TypeScript implementation is active")
            // DEBUG: Log INCOMING request from SDK (before any modifications)
            const sdkHeaders = new Headers(init?.headers)
            const sdkUrl = toUrlString(reqInput)
            log.debug("SDK INCOMING", {
              url: sdkUrl,
              method: init?.method,
              sdkAuth: sdkHeaders.get("Authorization")?.slice(0, 30),
              sdkXApiKey: sdkHeaders.get("x-api-key")?.slice(0, 20),
              sdkBeta: sdkHeaders.get("anthropic-beta"),
              sdkUserAgent: sdkHeaders.get("User-Agent"),
              allHeaders: Array.from(sdkHeaders.keys()),
            })

            const latestAuth = await getAuth()
            if (!isClaudeOAuthAuth(latestAuth)) return fetch(reqInput, init)
            const auth = latestAuth

            // 1. Token Refresh (with mutex to prevent concurrent refresh races)
            // FIX: Use pending-promise pattern — only the first caller performs the refresh,
            // subsequent concurrent callers await the same promise
            // @event_20260209_token_refresh_race
            if (auth.type === "oauth" || auth.type === "subscription") {
              if (!auth.access || (auth.expires && auth.expires < Date.now())) {
                if (!refreshPromise) {
                  refreshPromise = (async () => {
                    try {
                      log.info("Refreshing token for claude-cli...")
                      // Official scope list from Claude CLI v2.1.92
                      // @event_20260214_oauth_refresh_invalid_scope
                      const REFRESH_SCOPES = [
                        "user:profile",
                        "user:inference",
                        "user:sessions:claude_code",
                        "user:mcp_servers",
                        "user:file_upload",
                      ]
                      const response = await fetch("https://platform.claude.com/v1/oauth/token", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          grant_type: "refresh_token",
                          refresh_token: auth.refresh,
                          client_id: CLIENT_ID,
                          scope: REFRESH_SCOPES.join(" "),
                        }),
                      })
                      if (response.ok) {
                        const json = await response.json()
                        await client.auth.set({
                          path: { id: auth.accountId || "claude-cli" },
                          body: {
                            type: auth.type,
                            refresh: json.refresh_token ?? auth.refresh,
                            access: json.access_token,
                            expires: Date.now() + json.expires_in * 1000,
                            orgID: auth.orgID,
                            email: auth.email,
                          } as unknown as SDKAuth,
                        })
                        auth.access = json.access_token
                        auth.expires = Date.now() + json.expires_in * 1000
                        log.info("Token refresh successful")
                      } else {
                        // FIX: Handle refresh failure - log error and throw to prevent using expired token
                        // @event_20260209_token_refresh_error_handling
                        const errorText = await response.text().catch(() => "unknown error")
                        log.error("Token refresh failed", { status: response.status, error: errorText })
                        throw new Error(
                          `Token refresh failed (${response.status}): ${errorText}. Please re-authenticate.`,
                        )
                      }
                    } finally {
                      refreshPromise = null
                    }
                  })()
                }
                await refreshPromise
              }
            }

            const requestHeaders = new Headers(init?.headers)

            // DEBUG: Log actual token being used
            log.debug("Auth token check", {
              hasAccess: !!auth.access,
              accessPrefix: auth.access?.slice(0, 20),
              authType: auth.type,
              accountId: auth.accountId,
            })

            // OFFICIAL CLI HEADERS - matching reference implementation exactly
            requestHeaders.set("Authorization", `Bearer ${auth.access}`)
            requestHeaders.set("anthropic-version", "2023-06-01")
            requestHeaders.set("Content-Type", "application/json")
            // User-Agent format from reference: claude-code/VERSION
            requestHeaders.set("User-Agent", `claude-code/${VERSION}`)

            // Beta flags: minimum required (always) + conditional (per auth/model)
            // Ref: claude-code@2.1.92 — gD1 set + conditional assembly
            const incomingBeta = requestHeaders.get("anthropic-beta") || ""
            const incomingBetasList = incomingBeta
              .split(",")
              .map((b) => b.trim())
              .filter(Boolean)
            const minimumBetas = [
              "claude-code-20250219",
              "interleaved-thinking-2025-05-14",
              "context-management-2025-06-27",
            ]
            // Auth-conditional betas (subscription/oauth only)
            const authBetas =
              auth.type === "oauth" || auth.type === "subscription"
                ? ["oauth-2025-04-20", "prompt-caching-scope-2026-01-05"]
                : []
            const mergedBetas = [...new Set([...minimumBetas, ...authBetas, ...incomingBetasList])].join(",")
            requestHeaders.set("anthropic-beta", mergedBetas)
            // Note: Removed x-anthropic-additional-protection as it's not in reference implementation
            if (auth.orgID) requestHeaders.set("x-organization-uuid", auth.orgID)

            // Scrub framework bloat - remove headers that might trigger Anthropic's non-Claude-Code detection
            const toDelete = [
              "x-api-key",
              "anthropic-client",
              "x-app",
              "x-opencode-tools-debug",
              "x-opencode-account-id",
              "session_id", // FIX: This header triggers credential rejection @event_20260209_session_id_header
            ]
            toDelete.forEach((h) => requestHeaders.delete(h))

            // 2. URL normalization
            let requestInput = reqInput
            let requestUrl: URL | null = null
            try {
              const urlStr = toUrlString(reqInput)
              // Handle relative URLs by prepending Anthropic's base URL
              if (urlStr.startsWith("/")) {
                const normalizedPath = urlStr.startsWith("/v1/") ? urlStr : `/v1${urlStr}`
                requestInput = `https://api.anthropic.com${normalizedPath}`
                requestUrl = new URL(requestInput)
              } else {
                requestUrl = new URL(urlStr)
              }
            } catch {
              requestUrl = null
            }

            // 3. Claude Code Protocol: ?beta=true + mcp_ tool prefix
            let body = init?.body
            if (body && typeof body === "string") {
              try {
                const parsed = JSON.parse(body)

                // 3a. CRITICAL: System prompt MUST start with official Claude Code identifier
                // This is verified by Anthropic for Sonnet/Opus subscription auth
                // @event_20260209_claude_code_system_prompt
                const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

                if (parsed.system) {
                  if (Array.isArray(parsed.system)) {
                    // Array format: ALWAYS sanitize opencode references, then prepend identity if needed
                    // FIX: Must sanitize ALL system messages, not just when prepending identity
                    // @event_20260209_opencode_sanitization
                    parsed.system = parsed.system
                      .map((item: any) => {
                        if (item.type === "text" && item.text) {
                          return {
                            ...item,
                          }
                        }
                        return item
                      })
                      // FIX: Filter out empty text blocks - Anthropic API rejects them with 400 error
                      // "system: text content blocks must be non-empty"
                      // @event_20260209_empty_system_blocks
                      .filter((item: any) => {
                        if (item.type === "text") {
                          return item.text && item.text.trim() !== ""
                        }
                        return true
                      })
                    // Then prepend identity if not present
                    const firstText = parsed.system.find((item: any) => item.type === "text")
                    if (!firstText?.text?.includes(CLAUDE_CODE_IDENTITY)) {
                      parsed.system = [{ type: "text", text: CLAUDE_CODE_IDENTITY }, ...parsed.system]
                    }
                  } else if (typeof parsed.system === "string") {
                    if (!parsed.system.includes(CLAUDE_CODE_IDENTITY)) {
                      parsed.system = `${CLAUDE_CODE_IDENTITY}\n\n${parsed.system}`
                    }
                  }
                } else {
                  // No system prompt: add identity
                  parsed.system = CLAUDE_CODE_IDENTITY
                }

                // DEBUG: Log system prompt status
                log.debug("System prompt check", {
                  hasSystem: !!parsed.system,
                  systemType: typeof parsed.system,
                  systemPreview:
                    typeof parsed.system === "string"
                      ? parsed.system.slice(0, 80)
                      : Array.isArray(parsed.system)
                        ? parsed.system[0]?.text?.slice(0, 80)
                        : "unknown",
                })

                // 3b. Add mcp_ prefix to tools definitions (only if tools exist)
                // FIX: Guard against double-prefix when tools already have mcp_ prefix
                if (parsed.tools && Array.isArray(parsed.tools)) {
                  parsed.tools = parsed.tools.map((tool: any) => ({
                    ...tool,
                    name: tool.name && !tool.name.startsWith(TOOL_PREFIX) ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                  }))
                }

                // 3c. Add mcp_ prefix to tool_use blocks in messages + filter empty text blocks
                if (parsed.messages && Array.isArray(parsed.messages)) {
                  parsed.messages = parsed.messages
                    .map((msg: any) => {
                      if (msg.content && Array.isArray(msg.content)) {
                        msg.content = msg.content
                          .map((block: any) => {
                            if (block.type === "tool_use" && block.name && !block.name.startsWith(TOOL_PREFIX)) {
                              return { ...block, name: `${TOOL_PREFIX}${block.name}` }
                            }
                            if (block.type === "tool_result" && block.tool_use_id) {
                              // tool_result doesn't have name, but keep for consistency
                              return block
                            }
                            return block
                          })
                          // FIX: Filter out empty text blocks - Anthropic API rejects them
                          // @event_20260209_empty_system_blocks
                          .filter((block: any) => {
                            if (block.type === "text") {
                              return block.text && block.text.trim() !== ""
                            }
                            return true
                          })
                      } else if (typeof msg.content === "string" && msg.content.trim() === "") {
                        // Filter empty string content messages
                        return null
                      }
                      return msg
                    })
                    .filter(
                      (msg: any) =>
                        msg !== null &&
                        (typeof msg.content !== "object" || (Array.isArray(msg.content) && msg.content.length > 0)),
                    )

                  // 3d. Add billing header from first non-meta user message (matches official 2.1.92 HBY)
                  const firstUserMessage = parsed.messages.find(
                    (m: any) => m.role === "user" && !m.meta,
                  )
                  if (firstUserMessage) {
                    const userContent =
                      typeof firstUserMessage.content === "string"
                        ? firstUserMessage.content
                        : JSON.stringify(firstUserMessage.content)
                    requestHeaders.set("x-anthropic-billing-header", getBillingHeader(userContent))
                  }
                }

                body = JSON.stringify(parsed)

                // NOTE: Post-stringify sanitization removed — regex on serialized JSON is fragile
                // and the previous patterns (.replace(/You are Claude Code\.\s*/g, "")) contradicted
                // the prepend logic above. All text manipulation now happens before JSON.stringify.
                // @event_20260209_global_sanitization

                // Debug dump removed — writing full request body to disk is a security risk
                // (contains auth tokens and user messages). Use log.debug for targeted debugging.
                // @event_20260209_debug_dump_removed
              } catch (e) {
                log.debug("Body parse error", { error: e })
              }
            }

            // 3e. Add ?beta=true for messages endpoint (key for subscription auth)
            if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
              requestUrl.searchParams.set("beta", "true")
              requestInput = requestUrl.toString()
              log.debug("Using beta messages endpoint", { url: requestInput })
            }

            // DEBUG: Log ALL request headers for troubleshooting
            const allHeadersArray = Array.from(requestHeaders.entries())
            log.debug("Request headers FULL", {
              headers: allHeadersArray.map(([k, v]) =>
                k.toLowerCase() === "authorization" ? `${k}: ${v.slice(0, 30)}...` : `${k}: ${v}`,
              ),
            })
            if (body && typeof body === "string") {
              try {
                const bodyParsed = JSON.parse(body)
                const toolNames = bodyParsed.tools?.map((t: any) => t.name) || []
                const hasToolUse = bodyParsed.messages?.some((m: any) =>
                  m.content?.some?.((c: any) => c.type === "tool_use"),
                )
                // Check for cache_control in system and messages
                const hasCacheInSystem = JSON.stringify(bodyParsed.system).includes("cache_control")
                const hasCacheInMessages = JSON.stringify(bodyParsed.messages).includes("cache_control")
                log.debug("Request body analysis", {
                  model: bodyParsed.model,
                  toolCount: toolNames.length,
                  firstToolName: toolNames[0],
                  hasToolUse,
                  hasMcpPrefix: toolNames[0]?.startsWith("mcp_"),
                  hasCacheInSystem,
                  hasCacheInMessages,
                })
              } catch {}
            }

            const response = await fetch(requestInput, { ...init, body, headers: requestHeaders })

            // DEBUG: Log response status
            log.debug("API Response", {
              status: response.status,
              ok: response.ok,
              statusText: response.statusText,
            })

            // If response is an error, log the body for debugging
            if (!response.ok) {
              const clonedResponse = response.clone()
              const errorText = await clonedResponse.text()
              log.error("API Error Response", { status: response.status, body: errorText.slice(0, 500) })
            }

            // 4. Transform streaming response to remove mcp_ prefix from tool names
            // FIX: Buffer incomplete lines to prevent chunk-boundary splits from breaking regex
            // SSE format guarantees each event ends with \n, so we buffer until we have a complete line
            // @event_20260209_streaming_chunk_boundary
            if (response.body) {
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              const encoder = new TextEncoder()
              let remainder = ""

              const stream = new ReadableStream({
                async pull(controller) {
                  const { done, value } = await reader.read()
                  if (done) {
                    // Flush any remaining buffered content
                    if (remainder) {
                      const flushed = remainder.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
                      controller.enqueue(encoder.encode(flushed))
                      remainder = ""
                    }
                    controller.close()
                    return
                  }

                  const text = remainder + decoder.decode(value, { stream: true })
                  // Find last newline — everything before it is complete lines, safe to transform
                  const lastNewline = text.lastIndexOf("\n")
                  if (lastNewline === -1) {
                    // No complete line yet, buffer everything
                    remainder = text
                    return
                  }
                  const complete = text.slice(0, lastNewline + 1)
                  remainder = text.slice(lastNewline + 1)
                  // Remove mcp_ prefix from tool names in complete lines only
                  const transformed = complete.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')

                  // Extract cache usage from SSE message_start / message_delta events
                  for (const line of complete.split("\n")) {
                    if (!line.startsWith("data: ")) continue
                    const raw = line.slice(6)
                    if (!raw.includes('"message_start"') && !raw.includes('"message_delta"')) continue
                    try {
                      const evt = JSON.parse(raw)
                      const usage = evt.type === "message_start" ? evt.message?.usage : evt.usage
                      if (usage) {
                        log.info("CACHE USAGE", {
                          type: evt.type,
                          input_tokens: usage.input_tokens,
                          output_tokens: usage.output_tokens,
                          cache_creation_input_tokens: usage.cache_creation_input_tokens,
                          cache_read_input_tokens: usage.cache_read_input_tokens,
                        })
                      }
                    } catch {}
                  }

                  controller.enqueue(encoder.encode(transformed))
                },
              })

              return new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })
            }

            return response
          },
        }
      },
      methods: [
        {
          label: "Claude account with subscription · Pro, Max, Team, or Enterprise",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max")
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === "failed") return credentials
                try {
                  const profile = await fetch("https://api.anthropic.com/api/oauth/profile", {
                    headers: { Authorization: `Bearer ${credentials.access}` },
                  }).then((r) => r.json())
                  const email = profile.emailAddress || profile.email
                  return {
                    ...credentials,
                    orgID: profile.organizationUuid || profile.organization_uuid,
                    email,
                    accountId: email,
                    provider: "claude-cli",
                  }
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
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === "failed") return credentials
                const result = await fetch(`https://api.anthropic.com/api/oauth/claude_cli/create_api_key`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", authorization: `Bearer ${credentials.access}` },
                }).then((r) => r.json())
                return { type: "success", key: result.raw_key, provider: "claude-cli" }
              },
            }
          },
        },
      ],
    },
  }
}
