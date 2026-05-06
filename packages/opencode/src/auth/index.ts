import z from "zod"
import { createHash } from "node:crypto"
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
      username: z.string().optional(),
      orgID: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
      projectId: z.string().optional(),
      name: z.string().optional(),
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
   * Get auth for a (family, accountId?) pair.
   *
   * @spec specs/provider-account-decoupling DD-2, DD-8
   *
   * - `family` MUST be a registered family (Account.knownFamilies). Pass
   *   `accountId` separately when targeting a specific account; omit it to
   *   use the family's `activeAccount`.
   * - The legacy single-arg form is removed. There is no string-shape
   *   inference, no `parseProvider` recovery, no silent fallback. If callers
   *   pass an accountId where family is expected, we throw — that's the
   *   point.
   *
   * Errors:
   *   - UnknownFamilyError — `family` is not in Account.knownFamilies()
   *   - NoActiveAccountError — `accountId` omitted AND no activeAccount set
   */
  export async function get(family: string, accountId?: string): Promise<Info | undefined> {
    const { Account } = await import("../account")
    const { debugCheckpoint } = await import("../util/debug")
    const { UnknownFamilyError, NoActiveAccountError } = await import("../provider/registry-shape")

    debugCheckpoint("auth", "Auth.get called", { family, accountId })

    const knownFamilies = await Account.knownFamilies({ includeStorage: true })
    if (!knownFamilies.includes(family)) {
      throw new UnknownFamilyError({
        family,
        knownFamilies: [...knownFamilies],
        message:
          `Auth.get called with family=${JSON.stringify(family)} which is not registered. ` +
          `If you have an accountId here, pass it as the second argument with the correct family. ` +
          `knownFamilies=${JSON.stringify([...knownFamilies])}`,
      })
    }

    // Explicit account requested — look it up directly. No active-account
    // consultation, no fallback.
    if (accountId !== undefined) {
      const accounts = await Account.list(family)
      const accountInfo = accounts[accountId]
      if (!accountInfo) {
        debugCheckpoint("auth", "explicit accountId not found in family", { family, accountId })
        return undefined
      }
      return accountToAuth(accountInfo)
    }

    // No accountId given — use the family's active account.
    const accounts = await Account.list(family)
    const accountIds = Object.keys(accounts)

    // Empty family = no auth at all. Probes (`if (await Auth.get(family))`)
    // expect undefined here, so we don't throw — there's nothing inconsistent
    // to flag.
    if (accountIds.length === 0) {
      debugCheckpoint("auth", "family has no accounts", { family })
      return undefined
    }

    // Family has accounts but caller didn't pass accountId — consult activeAccount.
    const activeInfo = await Account.getActiveInfo(family)
    debugCheckpoint("auth", "Active info result", {
      family,
      hasActiveInfo: !!activeInfo,
      activeInfoType: activeInfo?.type,
    })

    if (!activeInfo) {
      // Inconsistent state: accounts exist but no activeAccount set. Fail loud
      // per AGENTS.md rule 1; do NOT silently pick the first account.
      throw new NoActiveAccountError({
        family,
        message:
          `family=${JSON.stringify(family)} has ${accountIds.length} account(s) but no activeAccount set; ` +
          `pass accountId explicitly (Auth.get(family, accountId)) ` +
          `or pick an active account via the admin panel.`,
      })
    }

    if (family === "gemini-cli" && activeInfo.type === "subscription") {
      return undefined
    }
    return accountToAuth(activeInfo)
  }

  /**
   * Get all auth entries (returns active account for each provider key)
   * Note: auth.json is no longer read - all data comes from accounts.json
   */
  export async function all(): Promise<Record<string, Info>> {
    const { Account } = await import("../account")
    const allAccounts = await Account.listAll()
    const result: Record<string, Info> = {}

    for (const [providerKey, providerData] of Object.entries(allAccounts)) {
      const activeId = providerData.activeAccount
      if (activeId && providerData.accounts[activeId]) {
        result[providerKey] = accountToAuth(providerData.accounts[activeId])
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
  export async function set(providerId: string, info: Info): Promise<string | undefined> {
    const { Account } = await import("../account")
    const providerKey = await Account.resolveProviderOrSelf(providerId)

    if (info.type === "api") {
      const raw = providerId.startsWith(`${providerKey}-`) ? providerId.slice(providerKey.length + 1) : providerId
      let label = info.name || raw || providerId
      let accountId = Account.generateId(providerKey, "api", label)
      
      const existingAccounts = await Account.list(providerKey)
      
      // API Key Deduplication: if the exact same API key already exists for this provider, we update it or return it,
      // rather than creating a phantom duplicate account under a new name.
      let duplicateId: string | undefined
      for (const [id, acc] of Object.entries(existingAccounts)) {
        if (acc.type === "api" && acc.apiKey === info.key) {
          duplicateId = id
          break
        }
      }

      if (duplicateId) {
        // If the key exists, we simply update its name/projectId if they were provided
        await Account.update(providerKey, duplicateId, {
          name: info.name || existingAccounts[duplicateId].name,
          projectId: info.projectId || (existingAccounts[duplicateId] as any).projectId,
        })
        return duplicateId
      }

      // Handle ID collision if the user happened to provide a generic name like "Default" that already exists
      let counter = 1
      while (existingAccounts[accountId]) {
        label = `${info.name || raw || providerId}-${counter}`
        accountId = Account.generateId(providerKey, "api", label)
        counter++
      }

      await Account.add(providerKey, accountId, {
        type: "api",
        name: label,
        apiKey: info.key,
        addedAt: Date.now(),
        projectId: info.projectId,
      })
      return accountId
    } else if (info.type === "oauth") {
      // Unified identity resolution chain:
      // 1. explicit email, 2. JWT decode from access token, 3. JWT decode from refresh token
      // 4. accountId only if it looks like an email (contains @), 5. explicit username
      // 6. short hash of token (ultimate fallback — always unique)
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
      const username = info.username

      // Check for existing account with same base token to avoid duplicates
      const parts = parseRefreshParts(info.refresh)
      const baseToken = parts.refreshToken || parseBaseToken(info.refresh)
      const hasProjectParts = providerKey === "gemini-cli"
      const projectId = hasProjectParts ? parts.projectId : undefined
      const managedProjectId = hasProjectParts ? parts.managedProjectId : undefined
      const existingAccounts = await Account.list(providerKey)
      let existingAccountId: string | undefined

      // Targeted update by accountId path: when the caller addresses an existing
      // account directly (token rotation persistence, dead-state clearing on
      // upstream revoke), skip baseToken matching. Empty refresh would otherwise
      // match nothing and fall through to phantom-account creation.
      if (existingAccounts[providerId]) {
        existingAccountId = providerId
      } else {
        for (const [id, acc] of Object.entries(existingAccounts)) {
          if (acc.type !== "subscription") continue
          const existingBaseToken = parseBaseToken(acc.refreshToken)
          if (existingBaseToken === baseToken) {
            existingAccountId = id
            break
          }
        }
      }

      if (existingAccountId) {
        // Update existing account instead of creating duplicate
        await Account.update(providerKey, existingAccountId, {
          email: email,
          refreshToken: baseToken, // Store base token without projectId suffix
          accessToken: info.access,
          expiresAt: info.expires,
          projectId,
          managedProjectId,
          metadata: info.orgID ? { orgID: info.orgID } : undefined,
        })
        return existingAccountId
      } else {
        // Unified slug resolution: email > username > token-hash (never falls back to providerId)
        const tokenHash = createHash("sha256").update(baseToken).digest("hex").slice(0, 8)
        const slug = email || username || `${providerId}-${tokenHash}`
        const accountId = Account.generateId(providerKey, "subscription", slug)

        // Re-auth with new refresh token: accountId matches by email but baseToken differs
        if (existingAccounts[accountId]) {
          await Account.update(providerKey, accountId, {
            email: email,
            refreshToken: baseToken,
            accessToken: info.access,
            expiresAt: info.expires,
            projectId,
            managedProjectId,
            metadata: info.orgID ? { orgID: info.orgID } : undefined,
          })
          return accountId
        }

        await Account.add(providerKey, accountId, {
          type: "subscription",
          name: email || username || providerId,
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
        return accountId
      }
    }
    return undefined
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
    const provider = await Account.resolveFamilyOrSelf(providerId)
    const activeId = await Account.getActive(provider)
    if (activeId) {
      await Account.remove(provider, activeId)
    }
  }

  /**
   * List all account IDs for a provider key
   */
  export async function listAccounts(providerPrefix: string): Promise<string[]> {
    const { Account } = await import("../account")
    const providerKey = await Account.resolveProviderOrSelf(providerPrefix)
    const accounts = await Account.list(providerKey)
    return Object.keys(accounts).sort()
  }

  /**
   * Get default (active) account for provider key
   */
  export async function getDefaultAccount(providerPrefix: string): Promise<string | undefined> {
    const { Account } = await import("../account")
    const providerKey = await Account.resolveProviderOrSelf(providerPrefix)
    return Account.getActive(providerKey)
  }

  /**
   * Check if any account exists for this provider key
   */
  export async function hasAccount(providerId: string): Promise<boolean> {
    const { Account } = await import("../account")

    // First, try exact match by account ID
    const exactMatch = await Account.getById(providerId)
    if (exactMatch) {
      return true
    }

    // Otherwise, check if provider key has any accounts
    const providerKey = await Account.resolveProviderOrSelf(providerId)
    const accounts = await Account.list(providerKey)
    return Object.keys(accounts).length > 0
  }
}
