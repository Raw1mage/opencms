import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "../../installation"
import { getBearer, getProfile, getTokenState, initAuth, startDeviceFlow } from "./auth"
import { iife } from "../../util/iife"

/**
 * copilot-cli provider plugin (DD-7/8/9/10).
 *
 * Self-contained reproduction of GitHub Copilot CLI auth behavior.
 * - Own OAuth device flow
 * - Own profile fetch (/copilot_internal/user)
 * - Own token exchange (capiSessionToken)
 * - Own fetch interceptor (no AI SDK runtime dependency)
 *
 * Provider family: "copilot-cli"
 */
export async function CopilotCLIPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    auth: {
      provider: "copilot-cli",
      async loader(getAuth, provider) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        // Initialize auth state on first load (profile + token exchange)
        const existing = getTokenState()
        if (!existing || existing.rawAccessToken !== info.refresh) {
          await initAuth(info.refresh, info.enterpriseUrl ?? "github.com")
        }

        const profile = getProfile()
        const enterpriseUrl = info.enterpriseUrl
        const baseURL = enterpriseUrl
          ? `https://copilot-api.${enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
          : profile?.endpoints.api ?? "https://api.githubcopilot.com"

        // Set all models to zero cost (Copilot subscription covers it)
        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
          }
        }

        return {
          baseURL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const currentInfo = await getAuth()
            if (currentInfo.type !== "oauth") return fetch(request, init)

            // Get a valid bearer (auto-refreshes capiSessionToken if expired)
            const bearer = await getBearer()

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

                // Messages API (Anthropic via Copilot)
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
              Authorization: `Bearer ${bearer}`,
              "Openai-Intent": "conversation-edits",
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            // Remove conflicting auth headers that AI SDK may have injected
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
          type: "oauth" as const,
          label: "Login with Copilot CLI",
          prompts: [
            {
              type: "select" as const,
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                { label: "GitHub.com", value: "github.com", hint: "Public" },
                { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
              ],
            },
            {
              type: "text" as const,
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs: Record<string, string>) => inputs.deploymentType === "enterprise",
              validate: (value: string) => {
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
            return startDeviceFlow(inputs)
          },
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (!input.model.providerId.includes("copilot-cli")) return

      const session = await sdk.session
        .get({ path: { id: input.sessionID }, throwOnError: true })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      output.headers["x-initiator"] = "agent"
    },
  }
}
