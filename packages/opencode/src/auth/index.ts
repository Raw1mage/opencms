import z from "zod"
import path from "path"
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
   * e.g., "openai" → "openai", "openai-work" → "openai", "google-subscription-1" → "google"
   */
  function parseFamily(providerID: string): string {
    const families = ["google", "openai", "anthropic", "github-copilot", "antigravity", "gemini-cli", "gitlab"]
    for (const family of families) {
      if (providerID === family || providerID.startsWith(`${family}-`)) {
        return family
      }
    }
    // Default: use the first segment before hyphen, or the whole ID
    const match = providerID.match(/^([a-z0-9-]+)(-|$)/)
    return match ? match[1] : providerID
  }

  /**
   * Convert Account.Info to Auth.Info
   */
  function accountToAuth(info: { type: "api"; apiKey: string } | { type: "subscription"; refreshToken: string; accessToken?: string; expiresAt?: number; accountId?: string }): Info {
    if (info.type === "api") {
      return { type: "api", key: info.apiKey }
    } else {
      return {
        type: "oauth",
        refresh: info.refreshToken,
        access: info.accessToken || "",
        expires: info.expiresAt || 0,
        accountId: info.accountId,
      }
    }
  }

  /**
   * Get auth for a provider ID
   * Looks up the ACTIVE account for the provider family in Account module
   */
  export async function get(providerID: string): Promise<Info | undefined> {
    const { Account } = await import("../account")

    // First, try exact match by account ID
    const exactMatch = await Account.getById(providerID)
    if (exactMatch) {
      return accountToAuth(exactMatch.info)
    }

    // Otherwise, get the active account for this provider family
    const family = parseFamily(providerID)
    const legacyAuth = await (async () => {
      const { Global } = await import("../global")
      const authPath = path.join(Global.Path.data, "auth.json")
      const file = Bun.file(authPath)
      if (!(await file.exists())) return undefined

      const data = await file.json().catch(() => undefined)
      if (!data || typeof data !== "object") return undefined

      const record = data as Record<string, unknown>
      const entry = record[providerID] ?? record[family]
      if (!entry) return undefined

      const parsed = Info.safeParse(entry)
      if (!parsed.success) return undefined
      return parsed.data
    })()

    if (family === "gitlab" && legacyAuth) {
      return legacyAuth
    }

    const activeInfo = await Account.getActiveInfo(family)
    if (activeInfo) {
      return accountToAuth(activeInfo)
    }

    if (legacyAuth) {
      return legacyAuth
    }

    return undefined
  }

  /**
   * Get all auth entries (returns active account for each family)
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

    const legacy = await (async () => {
      const { Global } = await import("../global")
      const authPath = path.join(Global.Path.data, "auth.json")
      const file = Bun.file(authPath)
      if (!(await file.exists())) return undefined
      const data = await file.json().catch(() => undefined)
      if (!data || typeof data !== "object") return undefined
      return data as Record<string, unknown>
    })()

    if (legacy) {
      for (const [providerID, auth] of Object.entries(legacy)) {
        if (result[providerID]) continue
        const parsed = Info.safeParse(auth)
        if (!parsed.success) continue
        result[providerID] = parsed.data
      }
    }

    return result
  }

  /**
   * Set auth for a provider (creates/updates account in Account module)
   */
  export async function set(providerID: string, info: Info) {
    const { Account } = await import("../account")
    const family = parseFamily(providerID)

    if (info.type === "api") {
      const accountId = Account.generateId(family, "api", providerID)
      await Account.add(family, accountId, {
        type: "api",
        name: providerID,
        apiKey: info.key,
        addedAt: Date.now(),
      })
    } else if (info.type === "oauth") {
      let email = info.email || info.accountId
      if (!email && info.access) {
        email = JWT.getEmail(info.access)
      }
      const slug = email || providerID
      const accountId = Account.generateId(family, "subscription", slug)
      await Account.add(family, accountId, {
        type: "subscription",
        name: slug,
        email: email,
        refreshToken: info.refresh,
        accessToken: info.access,
        expiresAt: info.expires,
        accountId: info.accountId,
        addedAt: Date.now(),
      })
    }
  }

  /**
   * Remove auth for a provider
   */
  export async function remove(providerID: string) {
    const { Account } = await import("../account")

    // Try to find and remove by exact ID first
    const exactMatch = await Account.getById(providerID)
    if (exactMatch) {
      await Account.remove(exactMatch.family, providerID)
      return
    }

    // Otherwise, remove the active account for this family
    const family = parseFamily(providerID)
    const activeId = await Account.getActive(family)
    if (activeId) {
      await Account.remove(family, activeId)
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
  export async function hasAccount(providerID: string): Promise<boolean> {
    const { Account } = await import("../account")

    // First, try exact match by account ID
    const exactMatch = await Account.getById(providerID)
    if (exactMatch) {
      return true
    }

    // Otherwise, check if family has any accounts
    const family = parseFamily(providerID)
    const accounts = await Account.list(family)
    return Object.keys(accounts).length > 0
  }

  /**
   * @deprecated Use Account.list("google") instead
   * Kept for backward compatibility with plugins
   */
  export async function listAntigravityAccounts(): Promise<Record<string, { refreshToken: string; managedProjectId: string; email?: string }>> {
    const { Account } = await import("../account")
    const accounts = await Account.list("google")
    const result: Record<string, { refreshToken: string; managedProjectId: string; email?: string }> = {}

    for (const [id, info] of Object.entries(accounts)) {
      if (info.type === "subscription") {
        const oldId = id.replace("google-subscription-", "antigravity-").replace("antigravity-1", "antigravity")
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
