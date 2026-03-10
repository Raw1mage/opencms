import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { iife } from "@/util/iife"

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds
function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    auth: {
      provider: "github-copilot",
      async loader(getAuth, provider) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        const enterpriseUrl = info.enterpriseUrl
        const baseURL = enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : undefined

        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }

            // NOTE: @event_copilot_rate_limits
            // The following code is disabled due to rate limiting issues with the GitHub Copilot Messages API.
            // To enable Claude model support through Copilot, set environment variable:
            // OPENCODE_COPILOT_CLAUDE_MESSAGES_API=true
            //
            // This requires the Messages API to have higher rate limits. See:
            // https://github.com/anthropics/anthropic-sdk-js/issues/rate-limits
            //
            // Once re-enabled, these configurations will allow routing Claude requests through
            // the Copilot API instead of the default SDK endpoints. Configuration should be
            // moved to models.dev presets once we have a better grasp of the feature matrix.
            const enableClaudeMessagesAPI = process.env.OPENCODE_COPILOT_CLAUDE_MESSAGES_API === "true"

            if (enableClaudeMessagesAPI) {
              // Re-enable Claude routing through Copilot API when rate limits are resolved
              const base = baseURL ?? model.api.url
              const claude = model.id.includes("claude")
              const url = iife(() => {
                if (!claude) return base
                if (base.endsWith("/v1")) return base
                if (base.endsWith("/")) return `${base}v1`
                return `${base}/v1`
              })

              model.api.url = url
              model.api.npm = claude ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot"
            } else {
              // Default: use GitHub Copilot SDK for all models
              model.api.npm = "@ai-sdk/github-copilot"
            }
          }
        }

        return {
          baseURL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)

            const url = request instanceof URL ? request.href : request.toString()
            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }

                // Messages API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  const hasNonToolCalls =
                    Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            // images can be nested inside tool_result content
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    isAgent: !(last?.role === "user" && hasNonToolCalls),
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "User-Agent": `opencode/${Installation.VERSION}`,
              Authorization: `Bearer ${info.refresh}`,
              "Openai-Intent": "conversation-edits",
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"
            let actualProvider = "github-copilot"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
              actualProvider = "github-copilot-enterprise"
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
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                // Track when we started so we can respect the device code expiry (if provided).
                const startedAt = Date.now()
                const expiresMs = (deviceData as any).expires_in ? (deviceData as any).expires_in * 1000 : undefined

                // Start with the server-provided interval (in seconds) or a sensible default.
                let pollIntervalMs = (deviceData.interval || 5) * 1000

                while (true) {
                  // Respect overall expiry if provided by the device code response.
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
                  } catch (err) {
                    // Network error - wait and retry using the current poll interval.
                    await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  let data: any
                  try {
                    data = await response.json()
                  } catch {
                    // If we can't parse JSON and the response isn't OK, treat as a failure.
                    if (!response.ok) return { type: "failed" as const }
                    // Otherwise wait and retry.
                    await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  // Server may suggest a new polling interval; respect it.
                  if (typeof data.interval === "number" && data.interval > 0) {
                    pollIntervalMs = data.interval * 1000
                  }

                  if (data.access_token) {
                    // Fetch GitHub user identity for multi-account support
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
                      // Non-fatal: fall back to token-hash based ID generation
                    }

                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      provider?: string
                      enterpriseUrl?: string
                      username?: string
                      email?: string
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                      username,
                      email,
                    }

                    if (actualProvider === "github-copilot-enterprise") {
                      result.provider = "github-copilot-enterprise"
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  // Standard device flow transient signals
                  if (data.error === "authorization_pending") {
                    await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    // RFC: increase polling interval by 5 seconds.
                    pollIntervalMs = pollIntervalMs + 5000
                    await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  // Fatal failures the user initiated or token expired.
                  if (data.error === "access_denied" || data.error === "expired_token") {
                    return { type: "failed" as const }
                  }

                  // Any other error from the server should fail-fast.
                  if (data.error) return { type: "failed" as const }

                  // Otherwise, wait and retry using the last known interval.
                  await Bun.sleep(pollIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (!input.model.providerId.includes("github-copilot")) return

      if (input.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const session = await sdk.session
        .get({
          path: {
            id: input.sessionID,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      // mark subagent sessions as agent initiated matching standard that other copilot tools have
      output.headers["x-initiator"] = "agent"
    },
  }
}
