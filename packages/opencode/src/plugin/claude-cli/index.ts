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
              // Snapshot the PRE-rotation refresh token: the stored account still
              // holds it, so it's how we'll locate that account after the refresh
              // rotates `creds.refresh` to a new value (see persist below).
              const preRotationRefresh = creds.refresh as string
              try {
                const tokens = await refreshTokenWithMutex(creds.refresh)
                creds.access = tokens.access
                creds.expires = tokens.expires
                if (tokens.refresh) creds.refresh = tokens.refresh
                log.info("Token refreshed before model creation")
              } catch (e) {
                // Refresh failed. provider-claude's TokenRefreshError carries the
                // precise intent: needsReauth=false (e.g. 429 — the OAuth *token
                // endpoint* throttled us; the account is NOT dead, provider-claude
                // already applied a 60s storm-guard cooldown) vs needsReauth=true
                // (400/401/403 — the grant is dead, re-auth required).
                //
                // Do NOT let the raw "Token refresh failed (...)" error escape to the
                // host's generic onError gates (session/llm.ts): isAuthError() string-
                // matches "token refresh failed" → forces re-login, while
                // isRateLimitError() early-returns false on the same string. Together
                // they'd hard-stop a transient throttle and abandon a still-valid
                // subscription. So consume the error in our own layer (like codex's
                // openai.ts and gemini's token.ts do) and re-shape a transient throttle
                // into a plain rate-limit error — the "(429)" in the message makes
                // isRateLimitError() route it to RateLimitJudge → cooldown + immediate
                // rotation to an available account. Only genuine re-auth propagates as-is.
                const status = (e as { status?: number })?.status
                const needsReauth = (e as { needsReauth?: boolean })?.needsReauth
                if (needsReauth === false || status === 429) {
                  log.warn("Token refresh throttled (transient); routing to rotation, not re-login", {
                    status,
                  })
                  throw Object.assign(
                    new Error(
                      `claude-cli token endpoint rate limited (${status ?? 429}); rotating to an available account`,
                    ),
                    { status: status ?? 429 },
                  )
                }
                log.error("Token refresh failed in getModel (re-auth required)", { error: e })
                throw e
              }

              // Persist the rotated token back to accounts.json so the next process
              // start doesn't replay a consumed refresh token (→ invalid_grant →
              // forced re-login; spec DD-13). Best-effort: refresh already succeeded
              // and `creds` is fresh in memory, so a write failure must NOT abort.
              //
              // Resolve the storage account id by its PRE-rotation refresh token via
              // base-token match (Account.findByRefreshToken — same identity scheme
              // as deduplicateByToken), then Account.update in place. We deliberately
              // do NOT rely on the loader's `accountId` param: it is only supplied on
              // the per-account loader call site (provider.ts:1806), not the
              // family-default one (1764), so keying on it silently skipped persist on
              // that path and the rotated token was lost (spec DD-16). And we must NOT
              // route through client.auth.set / Auth.set: for a claude account whose
              // email lives only in `name` (the access token is opaque, not a JWT —
              // DD-12) its email-slug resolution falls back to a token-hash and mints
              // a NEW "claude-cli" duplicate on every refresh (DD-15). Account.update
              // is targeted, NO-OPS via thrown-and-caught error if the id is gone, and
              // never creates an account.
              try {
                const { Account } = await import("../../account")
                const id = await Account.findByRefreshToken("claude-cli", preRotationRefresh)
                if (id) {
                  await Account.update("claude-cli", id, {
                    accessToken: creds.access,
                    expiresAt: creds.expires,
                    refreshToken: creds.refresh,
                  })
                  log.info("Persisted refreshed claude-cli token", { accountId: id })
                } else {
                  log.warn("Could not resolve account by refresh token; skipping persist to avoid duplicates")
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
