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
              // Snapshot the PRE-rotation refresh token. The stored account still
              // holds it, so it's how we locate that exact account after the refresh
              // rotates `creds.refresh` to a new value (see persist below).
              const preRotationRefresh = creds.refresh as string
              try {
                const tokens = await refreshTokenWithMutex(creds.refresh)
                creds.access = tokens.access
                creds.expires = tokens.expires
                if (tokens.refresh) creds.refresh = tokens.refresh
                log.info("Token refreshed before model creation")
              } catch (e) {
                log.error("Token refresh failed in getModel", { error: e })
                throw e
              }

              // Persist the rotated token back to accounts.json so the next process
              // start does not replay a consumed refresh token (→ invalid_grant →
              // forced re-login). Best-effort: refresh already succeeded and `creds`
              // is fresh in memory, so a write failure must NOT abort the request.
              //
              // ROOT CAUSE of the original "time's up → must re-login": the previous
              // persist did `client.auth.set({ path: { id: creds.accountId || "claude-cli" } })`.
              // `creds.accountId` is the CLAUDE-side identifier (email/profile), NOT the
              // opencode storage account id (claude-cli-subscription-<slug>), and it
              // falls back to the literal "claude-cli". Auth.set then re-runs identity
              // resolution on that wrong id → it fails to hit the live storage account
              // and the rotated token never lands on it. Next boot loads the stale
              // (already-consumed) refresh token → invalid_grant.
              //
              // Fix: write straight to the real storage account via Account.update —
              // prefer the loader's `accountId` (the opencode storage id), and fall
              // back to a base-token lookup for loader call sites that don't supply it.
              // Account.update is targeted in-place, NO-OPS if the id is gone, and never
              // creates a duplicate account.
              try {
                const { Account } = await import("../../account")
                const storageId = accountId || (await Account.findByRefreshToken("claude-cli", preRotationRefresh))
                if (storageId) {
                  await Account.update("claude-cli", storageId, {
                    accessToken: creds.access,
                    expiresAt: creds.expires,
                    refreshToken: creds.refresh,
                  })
                  log.info("Persisted refreshed claude-cli token", { accountId: storageId })
                } else {
                  log.warn("Could not resolve storage account for refreshed token; skipping persist")
                }
              } catch (persistErr) {
                log.error("Failed to persist refreshed claude-cli token (continuing with in-memory creds)", {
                  error: persistErr,
                })
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
