/**
 * Claude CLI plugin — self-contained provider plugin.
 *
 * Owns: auth registration (Hooks interface) + model factory.
 * Delegates to: @opencode-ai/provider-claude for HTTP, SSE, headers, conversion.
 * AI SDK surface: zero runtime imports (type-only LanguageModelV2 via provider-claude).
 *
 * Replaces: plugin/anthropic.ts (fetch interceptor dead code removed).
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Auth as SDKAuth } from "@opencode-ai/sdk"
import { createClaudeCode } from "@opencode-ai/provider-claude/provider"
import { isClaudeCredentials, refreshTokenWithMutex } from "@opencode-ai/provider-claude/auth"
import type { ClaudeCredentials } from "@opencode-ai/provider-claude/auth"
import { Log } from "../../util/log"
import { authMethods } from "./auth"

const log = Log.create({ service: "plugin.claude-cli" })

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

export async function ClaudeCliPlugin(input: PluginInput): Promise<Hooks> {
  const { client } = input
  log.info("ClaudeCliPlugin initialized")
  return {
    auth: {
      provider: "claude-cli",
      async loader(getAuth, provider, accountId) {
        const loadedAuth = await getAuth()
        if (!isClaudeOAuthAuth(loadedAuth)) return {}
        const auth = loadedAuth

        // Reset costs for subscription auth
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          // Credential passthrough — consumed by getModel below and by
          // provider.ts's getSDK cache key calculation
          type: auth.type,
          refresh: auth.refresh,
          access: auth.access,
          expires: auth.expires,
          orgID: auth.orgID,
          email: auth.email,
          accountId: auth.accountId,

          // Model factory — creates LanguageModelV2 via provider-claude.
          // This is the ONLY model creation path for claude-cli.
          // No AI SDK provider factory (createAnthropic) is involved.
          async getModel(_sdk: any, modelID: string, options?: Record<string, any>) {
            log.info("getModel via provider-claude", { modelID })
            const creds = options as any

            // Token refresh before model creation — ensures fresh access token
            if (isClaudeOAuthAuth(creds) && (!creds.access || (creds.expires && creds.expires < Date.now()))) {
              try {
                const tokens = await refreshTokenWithMutex(creds.refresh)
                creds.access = tokens.access
                creds.expires = tokens.expires
                if (tokens.refresh) creds.refresh = tokens.refresh
                // Persist refreshed tokens
                await client.auth.set({
                  path: { id: creds.accountId || "claude-cli" },
                  body: {
                    type: creds.type,
                    refresh: creds.refresh,
                    access: creds.access,
                    expires: creds.expires,
                    orgID: creds.orgID,
                    email: creds.email,
                  } as unknown as SDKAuth,
                })
                log.info("Token refreshed before model creation")
              } catch (e) {
                log.error("Token refresh failed in getModel", { error: e })
                throw e
              }
            }

            const credentials: ClaudeCredentials = isClaudeCredentials(creds)
              ? creds
              : {
                  type: (creds?.type as "oauth" | "subscription") ?? "subscription",
                  refresh: creds?.refresh ?? "",
                  access: creds?.access,
                  expires: creds?.expires,
                  orgID: creds?.orgID,
                  email: creds?.email,
                  accountId: creds?.accountId,
                }

            const provider = createClaudeCode({
              credentials,
              enableCaching: true,
            })
            return provider.languageModel(modelID)
          },
        }
      },
      methods: authMethods,
    },
  }
}
