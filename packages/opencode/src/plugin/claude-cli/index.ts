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

            // claude-cli token persistence — landing-bug fix (2026-06-03). ONE persist
            // helper shared by BOTH refresh paths:
            //   (1) the explicit getModel refresh below, and
            //   (2) the provider-internal ensureValidToken refresh that fires
            //       mid-session when the access token expires (provider.ts:478),
            //       wired via `onTokenRefresh` on createClaudeCode.
            // Path (2) was previously UNWIRED — createClaudeCode received no
            // onTokenRefresh — so mid-session token ROTATIONS (Anthropic rotates
            // refresh_token, see auth.ts:193) updated `creds` only in memory and were
            // never written back. A long session refreshes many times; on the next
            // process start the stale (already-consumed) refresh token loads →
            // invalid_grant → forced re-login. Wiring (2) closes the leak.
            //
            // Persist targets the REAL opencode storage account (claude-cli-subscription-
            // <slug>), NOT the claude-side `creds.accountId` (email/profile): prefer the
            // loader's `accountId` (storage id), fall back to a base-token reverse-lookup.
            // `lastKnownRefresh` tracks the account's current on-disk refresh value so the
            // fallback keeps resolving across successive rotations. Account.update is
            // in-place (throws if the id is gone → caught), never creates a duplicate, and
            // is best-effort — a write failure must NOT abort the request.
            let lastKnownRefresh = (creds?.refresh as string) ?? ""
            const persistRefreshedToken = async (refreshed: any) => {
              try {
                const { Account } = await import("../../account")
                const storageId = accountId || (await Account.findByRefreshToken("claude-cli", lastKnownRefresh))
                if (!storageId) {
                  log.warn("Could not resolve storage account for refreshed token; skipping persist")
                  return
                }
                await Account.update("claude-cli", storageId, {
                  accessToken: refreshed.access,
                  expiresAt: refreshed.expires,
                  refreshToken: refreshed.refresh,
                })
                if (refreshed.refresh) lastKnownRefresh = refreshed.refresh
                log.info("Persisted refreshed claude-cli token", { accountId: storageId })
              } catch (persistErr) {
                log.error("Failed to persist refreshed claude-cli token (continuing with in-memory creds)", {
                  error: persistErr,
                })
              }
            }

            // Token refresh before model creation — ensures fresh access token
            if (isClaudeOAuthAuth(creds) && (!creds.access || (creds.expires && creds.expires < Date.now()))) {
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
              await persistRefreshedToken(creds)
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
              // Landing-bug fix: persist mid-session ensureValidToken rotations
              // (provider.ts:478). Without this the rotated refresh token was lost
              // on the next process start → invalid_grant.
              onTokenRefresh: persistRefreshedToken,
            })
            return provider.languageModel(modelID)
          },
        }
      },
      methods: authMethods,
    },
  }
}
