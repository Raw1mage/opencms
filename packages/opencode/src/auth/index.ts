import z from "zod"
import { JWT } from "../util/jwt"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

/**
 * Auth module - Thin wrapper around Account module
 * All auth data is stored in accounts.json (single source of truth)
 */
export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      email: z.string().optional(),
      orgID: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  /**
   * Parse provider family from provider ID
   * e.g., "openai" → "openai", "openai-work" → "openai", "google-api-work" → "google-api"
   */
  function parseFamily(providerId: string): string {
    const families = [
      "google-api",
      "openai",
      "claude-cli",
      "github-copilot",
      "antigravity",
      "gemini-cli",
      "gitlab",
      "opencode",
    ]
    for (const family of families) {
      if (providerId === family || providerId.startsWith(`${family}-`)) {
        return family
      }
    }
    // Default: use the first segment before hyphen, or the whole ID
    const match = providerId.match(/^([a-z0-9-]+)(-|$)/)
    return match ? match[1] : providerId
  }

  /**
   * Convert Account.Info to Auth.Info
   */
  function accountToAuth(
    info:
      | { type: "api"; apiKey: string }
      | {
          type: "subscription"
          refreshToken: string
          accessToken?: string
          expiresAt?: number
          accountId?: string
          metadata?: Record<string, any>
          email?: string
        },
  ): Info {
    if (info.type === "api") {
      return { type: "api", key: info.apiKey }
    } else {
      return {
        type: "oauth",
        refresh: info.refreshToken,
        access: info.accessToken || "",
        expires: info.expiresAt || 0,
        accountId: info.accountId,
        email: info.email,
        orgID: info.metadata?.orgID,
      }
    }
  }

  /**
   * Get auth for a provider ID
   * Looks up the ACTIVE account for the provider family in Account module
   * Note: auth.json is no longer read - all data comes from accounts.json
   */
  export async function get(providerId: string): Promise<Info | undefined> {
    const { Account } = await import("../account")

    // 1. Try exact match by account ID
    const exactMatch = await Account.getById(providerId)
    if (exactMatch) {
      return accountToAuth(exactMatch.info)
    }

    // 2. Try simplified ID match for Antigravity (e.g. antigravity-ivon0829 -> antigravity-subscription-ivon0829-gmail-com)
    if (providerId.startsWith("antigravity-") && !providerId.includes("subscription")) {
      const antigravityAccounts = await Account.list("antigravity")
      for (const [id, info] of Object.entries(antigravityAccounts)) {
        if (info.type === "subscription" && info.email) {
          const username = info.email.split("@")[0]
          if (`antigravity-${username}` === providerId) {
            return accountToAuth(info)
          }
        }
      }
    }

    // 3. Get active account for this provider family
    const family = parseFamily(providerId)
    const activeInfo = await Account.getActiveInfo(family)
    if (activeInfo) {
      return accountToAuth(activeInfo)
    }

    return undefined
  }

  /**
   * Get all auth entries (returns active account for each family)
   * Note: auth.json is no longer read - all data comes from accounts.json
   */
  export async function all(): Promise<Record<string, Info>> {
    const { Account } = await import("../account")
    const allAccounts = await Account.listAll()
    const result: Record<string, Info> = {}

    for (const [family, familyData] of Object.entries(allAccounts)) {
      const activeId = familyData.activeAccount
      if (activeId && familyData.accounts[activeId]) {
        // Use family name as key for backward compatibility
        result[family] = accountToAuth(familyData.accounts[activeId])
      }
    }

    return result
  }

  /**
   * Parse base refresh token from combined format (token|projectId)
   */
  function parseBaseToken(refreshToken: string): string {
    const pipeIndex = refreshToken.indexOf("|")
    return pipeIndex > 0 ? refreshToken.slice(0, pipeIndex) : refreshToken
  }

  function parseRefreshParts(refreshToken: string): {
    refreshToken: string
    projectId?: string
    managedProjectId?: string
  } {
    const [refresh = "", projectId = "", managedProjectId = ""] = (refreshToken ?? "").split("|")
    return {
      refreshToken: refresh,
      projectId: projectId || undefined,
      managedProjectId: managedProjectId || undefined,
    }
  }

  /**
   * Set auth for a provider (creates/updates account in Account module)
   */
  export async function set(providerId: string, info: Info) {
    const { Account } = await import("../account")
    const family = parseFamily(providerId)

    if (info.type === "api") {
      const raw = providerId.startsWith(`${family}-`) ? providerId.slice(family.length + 1) : providerId
      const label = raw || providerId
      const accountId = Account.generateId(family, "api", label)
      await Account.add(family, accountId, {
        type: "api",
        name: label,
        apiKey: info.key,
        addedAt: Date.now(),
      })
    } else if (info.type === "oauth") {
      // Priority: 1. explicit email, 2. JWT decode from access token, 3. JWT decode from refresh token
      // 4. accountId only if it looks like an email (contains @), not if it's a UUID
      let email = info.email
      if (!email && info.access) {
        email = JWT.getEmail(info.access)
      }
      if (!email && info.refresh) {
        email = JWT.getEmail(info.refresh)
      }
      if (!email && info.accountId && info.accountId.includes("@")) {
        email = info.accountId
      }

      // Check for existing account with same base token to avoid duplicates
      const parts = parseRefreshParts(info.refresh)
      const baseToken = parts.refreshToken || parseBaseToken(info.refresh)
      const hasProjectParts = family === "antigravity" || family === "gemini-cli"
      const projectId = hasProjectParts ? parts.projectId : undefined
      const managedProjectId = hasProjectParts ? parts.managedProjectId : undefined
      const existingAccounts = await Account.list(family)
      let existingAccountId: string | undefined

      for (const [id, acc] of Object.entries(existingAccounts)) {
        if (acc.type !== "subscription") continue
        const existingBaseToken = parseBaseToken(acc.refreshToken)
        if (existingBaseToken === baseToken) {
          existingAccountId = id
          break
        }
      }

      if (existingAccountId) {
        // Update existing account instead of creating duplicate
        await Account.update(family, existingAccountId, {
          email: email,
          refreshToken: baseToken, // Store base token without projectId suffix
          accessToken: info.access,
          expiresAt: info.expires,
          projectId,
          managedProjectId,
          metadata: info.orgID ? { orgID: info.orgID } : undefined,
        })
      } else {
        const slug = email || providerId
        const accountId = Account.generateId(family, "subscription", slug)
        await Account.add(family, accountId, {
          type: "subscription",
          name: slug,
          email: email,
          refreshToken: baseToken, // Store base token without projectId suffix
          accessToken: info.access,
          expiresAt: info.expires,
          accountId: info.accountId,
          projectId,
          managedProjectId,
          addedAt: Date.now(),
          metadata: info.orgID ? { orgID: info.orgID } : undefined,
        })
      }
    }
  }

  /**
   * Remove auth for a provider
   */
  export async function remove(providerId: string) {
    const { Account } = await import("../account")

    // Try to find and remove by exact ID first
    const exactMatch = await Account.getById(providerId)
    if (exactMatch) {
      await Account.remove(exactMatch.provider, providerId)
      return
    }

    // Otherwise, remove the active account for this provider
    const provider = parseFamily(providerId)
    const activeId = await Account.getActive(provider)
    if (activeId) {
      await Account.remove(provider, activeId)
    }
  }

  /**
   * List all account IDs for a provider family
   */
  export async function listAccounts(providerPrefix: string): Promise<string[]> {
    const { Account } = await import("../account")
    const family = parseFamily(providerPrefix)
    const accounts = await Account.list(family)
    return Object.keys(accounts).sort()
  }

  /**
   * Get default (active) account for provider family
   */
  export async function getDefaultAccount(providerPrefix: string): Promise<string | undefined> {
    const { Account } = await import("../account")
    const family = parseFamily(providerPrefix)
    return Account.getActive(family)
  }

  /**
   * Check if any account exists for this provider family
   */
  export async function hasAccount(providerId: string): Promise<boolean> {
    const { Account } = await import("../account")

    // First, try exact match by account ID
    const exactMatch = await Account.getById(providerId)
    if (exactMatch) {
      return true
    }

    // Otherwise, check if family has any accounts
    const family = parseFamily(providerId)
    const accounts = await Account.list(family)
    return Object.keys(accounts).length > 0
  }

  /**
   * @deprecated Use Account.list("google-api") instead
   * Kept for backward compatibility with plugins
   */
  export async function listAntigravityAccounts(): Promise<
    Record<string, { refreshToken: string; managedProjectId: string; email?: string }>
  > {
    const { Account } = await import("../account")
    const accounts = await Account.list("google-api")
    const result: Record<string, { refreshToken: string; managedProjectId: string; email?: string }> = {}

    for (const [id, info] of Object.entries(accounts)) {
      if (info.type === "subscription") {
        let oldId = id.replace("google-subscription-", "antigravity-")
        // Simplify: antigravity-ivon0829-gmail-com -> antigravity-ivon0829
        if (info.email) {
          const username = info.email.split("@")[0]
          oldId = `antigravity-${username}`
        }
        result[oldId] = {
          refreshToken: info.refreshToken,
          managedProjectId: info.managedProjectId || info.projectId || "",
          email: info.email,
        }
      }
    }

    return result
  }
}
