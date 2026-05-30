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
          try {
            const profile = await fetchProfile(credentials.access)
            return {
              ...credentials,
              orgID: profile.orgID,
              email: profile.email,
              accountId: profile.email,
              provider: "claude-cli",
            }
          } catch (e) {
            log.warn("Profile fetch failed, continuing without profile", { error: e })
            return { ...credentials, provider: "claude-cli" }
          }
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
