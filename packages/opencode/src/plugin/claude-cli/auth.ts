/**
 * Claude CLI plugin — OAuth PKCE auth methods.
 *
 * Delegates to @opencode-ai/provider-claude for authorize/exchange/profile.
 * This file only defines the UI-facing auth.methods array for the Hooks interface.
 */
import { generatePKCE } from "@openauthjs/openauth/pkce"
import {
  authorize,
  exchange,
  fetchProfile,
} from "@opencode-ai/provider-claude/auth"
import { OAUTH } from "@opencode-ai/provider-claude/protocol"
import { Log } from "../../util/log"

const log = Log.create({ service: "plugin.claude-cli" })

export const authMethods = [
  {
    label: "Claude account with subscription · Pro, Max, Team, or Enterprise",
    type: "oauth" as const,
    authorize: async () => {
      log.info("OAuth authorize: subscription flow")
      const { url, verifier } = await authorize("max", generatePKCE)
      return {
        url,
        instructions: "Paste the authorization code here: ",
        method: "code" as const,
        callback: async (code: string) => {
          const credentials = await exchange(code, verifier)
          // The profile carries the ONLY human-readable identity for a claude-cli
          // account: the access token is an opaque (non-JWT) string, so no email can
          // be recovered from it. If the email is lost here, Auth.set falls back to a
          // token-hash slug + the literal "claude-cli" display name — and because the
          // refresh token rotates, every re-login then mints a NEW duplicate account.
          // So fetch the profile with a small bounded retry (login is an interactive
          // one-shot, not the runtime hot path — this does NOT churn a live token),
          // and if it still fails, fail the login with a clear message instead of
          // silently creating a half-identified "claude-cli" account.
          // @spec auth/credential-token-refresh-ineffective (defect B)
          let lastErr: unknown
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const profile = await fetchProfile(credentials.access)
              // A 200 with no email is as useless as a throw: without it the account
              // degrades to a token-hash slug and a fresh duplicate on every re-login.
              // Treat it as a failed attempt so the retry/refuse path below applies.
              if (!profile.email) {
                throw new Error("Profile fetched but contained no email address")
              }
              return {
                ...credentials,
                orgID: profile.orgID,
                email: profile.email,
                accountId: profile.email,
                provider: "claude-cli",
              }
            } catch (e) {
              lastErr = e
              log.warn(`Profile fetch failed (attempt ${attempt}/3)`, { error: e })
              if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
            }
          }
          log.error("Profile fetch failed after retries; refusing to create an unidentified account", {
            error: lastErr,
          })
          throw new Error(
            "Logged in to Claude, but fetching your account profile failed, so the account could not be " +
              "identified. No account was created (this avoids duplicate, mis-named 'claude-cli' accounts). " +
              "Please try logging in again.",
          )
        },
      }
    },
  },
  {
    label: "Anthropic Console account · API usage billing",
    type: "oauth" as const,
    authorize: async () => {
      log.info("OAuth authorize: console flow")
      const { url, verifier } = await authorize("console", generatePKCE)
      return {
        url,
        instructions: "Paste the authorization code here: ",
        method: "code" as const,
        callback: async (code: string) => {
          const credentials = await exchange(code, verifier)
          const result = await fetch(OAUTH.apiKey, {
            method: "POST",
            headers: { "Content-Type": "application/json", authorization: `Bearer ${credentials.access}` },
          }).then((r) => r.json())
          return { type: "success" as const, key: result.raw_key, provider: "claude-cli" }
        },
      }
    },
  },
]
