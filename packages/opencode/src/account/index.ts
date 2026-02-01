import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"
import { Log } from "../util/log"
import { debugLog } from "../util/debug-log"
import { Instance } from "../project/instance"
import type { AccountCandidate, RateLimitReason } from "./rotation"

// Re-export rotation modules for global account rotation
export * from "./rotation"
export * from "./rotation3d"

const log = Log.create({ service: "account" })

export namespace Account {
  // Known OAuth providers - these have specialized handling or OAuth flows.
  // NOTE: This is NOT a whitelist - any provider can have accounts added.
  // This list is for documentation and special case handling only.
  export const PROVIDERS = ["google-api", "openai", "anthropic", "antigravity", "gemini-cli", "gitlab", "github-copilot", "opencode"] as const
  export type Provider = (typeof PROVIDERS)[number]

  /** @deprecated Use PROVIDERS instead */
  export const FAMILIES = PROVIDERS
  /** @deprecated Use Provider instead */
  export type Family = Provider

  // Account type schemas
  export const ApiAccount = z.object({
    type: z.literal("api"),
    name: z.string(),
    apiKey: z.string(),
    addedAt: z.number(),
  })
  export type ApiAccount = z.infer<typeof ApiAccount>

  export const SubscriptionAccount = z.object({
    type: z.literal("subscription"),
    name: z.string(),
    email: z.string().optional(),
    refreshToken: z.string(),
    accessToken: z.string().optional(),
    expiresAt: z.number().optional(),
    projectId: z.string().optional(),
    managedProjectId: z.string().optional(),
    accountId: z.string().optional(),
    addedAt: z.number(),
    // Rate limiting metadata
    rateLimitResetTimes: z.record(z.string(), z.number()).optional(),
    coolingDownUntil: z.number().optional(),
    cooldownReason: z.string().optional(),
    // Fingerprint for subscription services
    fingerprint: z.record(z.string(), z.unknown()).optional(),
  })
  export type SubscriptionAccount = z.infer<typeof SubscriptionAccount>

  export const Info = z.discriminatedUnion("type", [ApiAccount, SubscriptionAccount])
  export type Info = z.infer<typeof Info>

  // Provider data schema (accounts grouped by provider)
  export const ProviderData = z.object({
    activeAccount: z.string().optional(),
    accounts: z.record(z.string(), Info),
  })
  export type ProviderData = z.infer<typeof ProviderData>

  /** @deprecated Use ProviderData instead */
  export const FamilyData = ProviderData
  /** @deprecated Use ProviderData instead */
  export type FamilyData = ProviderData

  // Storage schema
  // NOTE: Uses "families" key for backward compatibility with existing accounts.json files
  // Conceptually this is "providers" - each key is a provider ID
  export const Storage = z.object({
    version: z.number(),
    families: z.record(z.string(), ProviderData),
  })
  export type Storage = z.infer<typeof Storage>

  const CURRENT_VERSION = 2
  const filepath = path.join(Global.Path.data, "accounts.json")

  // Cached state
  let _storage: Storage | undefined
  async function state(): Promise<Storage> {
    if (!_storage) {
      debugLog("Account.state", "Loading from disk (no cache)")
      _storage = await load()
      debugLog("Account.state", "Loaded", { families: Object.keys(_storage.families) })
    } else {
      debugLog("Account.state", "Using cached state", { families: Object.keys(_storage.families) })
    }
    return _storage
  }

  async function load(): Promise<Storage> {
    const file = Bun.file(filepath)
    const exists = await file.exists()

    if (!exists) {
      // Try migration from old formats
      const migrated = await migrate()
      if (migrated) {
        return migrated
      }
      return { version: CURRENT_VERSION, families: {} }
    }

    try {
      const data = await file.json()
      const parsed = Storage.safeParse(data)
      if (!parsed.success) {
        log.warn("Invalid accounts.json, resetting", { error: parsed.error })
        return { version: CURRENT_VERSION, families: {} }
      }
      let storage = parsed.data
      if (storage.version < 2) {
        storage = await migrateToV2(storage)
        await save(storage)
      }
      return storage
    } catch (e) {
      log.error("Failed to load accounts.json", { error: e })
      return { version: CURRENT_VERSION, families: {} }
    }
  }

  async function save(storage: Storage): Promise<void> {
    debugLog("Account.save", "Writing", { path: filepath })
    try {
      const file = Bun.file(filepath)
      const content = JSON.stringify(storage, null, 2)
      debugLog("Account.save", "Content ready", { length: content.length, families: Object.keys(storage.families) })
      await Bun.write(file, content)
      await fs.chmod(filepath, 0o600)
      debugLog("Account.save", "Write successful")
    } catch (e) {
      debugLog("Account.save", "Write failed", { error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }

  /**
   * List all accounts for a provider
   */
  export async function list(provider: string): Promise<Record<string, Info>> {
    const storage = await state()
    const accounts = storage.families[provider]?.accounts ?? {}
    debugLog("Account.list", provider, { accountCount: Object.keys(accounts).length, accountIds: Object.keys(accounts) })
    return accounts
  }

  /**
   * List all providers with their data
   */
  export async function listAll(): Promise<Record<string, ProviderData>> {
    const storage = await state()
    return storage.families
  }

  /**
   * Get a specific account
   */
  export async function get(provider: string, accountId: string): Promise<Info | undefined> {
    const storage = await state()
    return storage.families[provider]?.accounts[accountId]
  }

  /**
   * Get account by full ID (e.g., "google-api-personal")
   */
  export async function getById(accountId: string): Promise<{ provider: string; info: Info } | undefined> {
    const storage = await state()
    for (const [provider, data] of Object.entries(storage.families)) {
      if (data.accounts[accountId]) {
        return { provider, info: data.accounts[accountId] }
      }
    }
    return undefined
  }

  /**
   * Add a new account
   */
  export async function add(provider: string, accountId: string, info: Info): Promise<void> {
    debugLog("Account.add", "Starting", { provider, accountId, type: info.type })
    const storage = await state()
    debugLog("Account.add", "Got state", { existingFamilies: Object.keys(storage.families) })

    if (!storage.families[provider]) {
      storage.families[provider] = { accounts: {} }
      debugLog("Account.add", "Created new provider entry", { provider })
    }

    storage.families[provider].accounts[accountId] = info
    debugLog("Account.add", "Added account", { accounts: Object.keys(storage.families[provider].accounts) })

    // If this is the first account, make it active
    if (!storage.families[provider].activeAccount) {
      storage.families[provider].activeAccount = accountId
      debugLog("Account.add", "Set as active account", { accountId })
    }

    await save(storage)
    debugLog("Account.add", "Save completed", { provider, accountId })
    log.info("Account added", { provider, accountId, type: info.type })
  }

  /**
   * Update an existing account
   */
  export async function update(provider: string, accountId: string, info: Partial<Info>): Promise<void> {
    const storage = await state()
    const existing = storage.families[provider]?.accounts[accountId]

    if (!existing) {
      throw new Error(`Account not found: ${provider}/${accountId}`)
    }

    storage.families[provider].accounts[accountId] = { ...existing, ...info } as Info
    await save(storage)
  }

  /**
   * Repair accounts by attempting to extract email from JWT tokens
   * Useful for fixing accounts where email was stored as UUID
   */
  export async function repairEmails(): Promise<{ fixed: number; total: number }> {
    const { JWT } = await import("../util/jwt")
    const storage = await state()
    let fixed = 0
    let total = 0

    for (const [provider, familyData] of Object.entries(storage.families)) {
      for (const [accountId, info] of Object.entries(familyData.accounts)) {
        if (info.type !== "subscription") continue
        total++

        const sub = info as SubscriptionAccount
        const currentEmail = sub.email

        // Check if email is missing, is a UUID, or doesn't contain @
        const needsRepair = !currentEmail ||
                           JWT.isUUID(currentEmail) ||
                           !currentEmail.includes("@")

        if (!needsRepair) continue

        // Try to extract email from tokens
        let newEmail: string | undefined
        if (sub.accessToken) {
          newEmail = JWT.getEmail(sub.accessToken)
        }
        if (!newEmail && sub.refreshToken) {
          newEmail = JWT.getEmail(sub.refreshToken)
        }

        if (newEmail && newEmail !== currentEmail) {
          log.info("Repairing account email", { provider, accountId, old: currentEmail, new: newEmail })
          storage.families[provider].accounts[accountId] = {
            ...sub,
            email: newEmail,
            name: sub.name === currentEmail ? newEmail : sub.name,
          }
          fixed++
        }
      }
    }

    if (fixed > 0) {
      await save(storage)
      log.info("Repaired account emails", { fixed, total })
    }

    return { fixed, total }
  }

  /**
   * Remove an account
   */
  export async function remove(provider: string, accountId: string): Promise<void> {
    const storage = await state()

    if (!storage.families[provider]?.accounts[accountId]) {
      return
    }

    delete storage.families[provider].accounts[accountId]

    // If we removed the active account, pick another
    if (storage.families[provider].activeAccount === accountId) {
      const remaining = Object.keys(storage.families[provider].accounts)
      storage.families[provider].activeAccount = remaining[0]
    }

    await save(storage)
    log.info("Account removed", { provider, accountId })
  }

  /**
   * Parse base refresh token from combined format (token|projectId)
   */
  function parseBaseToken(refreshToken: string): string {
    const pipeIndex = refreshToken.indexOf("|")
    return pipeIndex > 0 ? refreshToken.slice(0, pipeIndex) : refreshToken
  }

  /**
   * Deduplicate accounts with same base refresh token.
   * Keeps the account with email, or the one with the longer/more specific ID.
   * This cleans up phantom accounts created by legacy code paths.
   */
  export async function deduplicateByToken(provider: string): Promise<number> {
    const storage = await state()
    const accounts = storage.families[provider]?.accounts
    if (!accounts) return 0

    // Group accounts by base token
    const byToken = new Map<string, string[]>()
    for (const [id, info] of Object.entries(accounts)) {
      if (info.type !== "subscription") continue
      const baseToken = parseBaseToken(info.refreshToken)
      const existing = byToken.get(baseToken) || []
      existing.push(id)
      byToken.set(baseToken, existing)
    }

    // Find and remove duplicates
    let removed = 0
    for (const [_token, ids] of byToken) {
      if (ids.length <= 1) continue

      // Sort to prefer: accounts with email, then longer/more specific IDs
      ids.sort((a, b) => {
        const infoA = accounts[a] as SubscriptionAccount
        const infoB = accounts[b] as SubscriptionAccount
        // Prefer accounts with email
        if (infoA.email && !infoB.email) return -1
        if (!infoA.email && infoB.email) return 1
        // Prefer longer IDs (more specific, e.g., email-based slug)
        return b.length - a.length
      })

      // Keep the first one, remove the rest
      for (let i = 1; i < ids.length; i++) {
        const idToRemove = ids[i]
        delete accounts[idToRemove]
        removed++
        log.info("Removed duplicate account", { provider, accountId: idToRemove })

        // Update active account if needed
        if (storage.families[provider].activeAccount === idToRemove) {
          storage.families[provider].activeAccount = ids[0]
        }
      }
    }

    if (removed > 0) {
      await save(storage)
    }
    return removed
  }

  /**
   * Set the active account for a provider
   */
  export async function setActive(provider: string, accountId: string): Promise<void> {
    const storage = await state()

    if (!storage.families[provider]?.accounts[accountId]) {
      throw new Error(`Account not found: ${provider}/${accountId}`)
    }

    storage.families[provider].activeAccount = accountId
    await save(storage)
    log.info("Active account changed", { provider, accountId })
  }

  /**
   * Get the active account ID for a provider
   */
  export async function getActive(provider: string): Promise<string | undefined> {
    const storage = await state()
    return storage.families[provider]?.activeAccount
  }

  /**
   * Get the active account info for a provider
   */
  export async function getActiveInfo(provider: string): Promise<Info | undefined> {
    const storage = await state()
    const activeId = storage.families[provider]?.activeAccount
    if (!activeId) return undefined
    return storage.families[provider]?.accounts[activeId]
  }

  /**
   * Generate a unique account ID
   */
  export function generateId(provider: string, type: "api" | "subscription", name?: string): string {
    const suffix = name?.toLowerCase().replace(/[^a-z0-9]/g, "-") || Date.now().toString(36)
    return `${provider}-${type}-${suffix}`
  }

  /**
   * Parse provider from account ID.
   *
   * For known PROVIDERS (google, anthropic, etc.), matches by prefix.
   * For other providers (models.dev providers like github-copilot, deepseek),
   * extracts the provider name from the account ID pattern.
   *
   * Account ID patterns:
   * - "{provider}" -> provider
   * - "{provider}-api-{name}" -> provider
   * - "{provider}-subscription-{name}" -> provider
   */
  export function parseProvider(accountId: string): string | undefined {
    // First check known PROVIDERS (prefix match)
    for (const provider of PROVIDERS) {
      if (accountId === provider || accountId.startsWith(`${provider}-`)) {
        return provider
      }
    }

    // For unknown providers, try to extract from account ID pattern
    // Pattern: {provider}-{type}-{name} where type is "api" or "subscription"
    // Use greedy matching (.+) to capture provider names that contain dashes (e.g., "github-copilot")
    const apiMatch = accountId.match(/^(.+)-api-/)
    if (apiMatch) return apiMatch[1]

    const subMatch = accountId.match(/^(.+)-subscription-/)
    if (subMatch) return subMatch[1]

    // If no pattern matched and it doesn't contain dashes, treat as provider ID itself
    if (!accountId.includes("-")) {
      return accountId
    }

    // For IDs like "github-copilot" (provider name with dash), return as-is
    // Check if it looks like a provider ID (no -api- or -subscription- suffix)
    if (!accountId.includes("-api-") && !accountId.includes("-subscription-")) {
      return accountId
    }

    return undefined
  }

  /** @deprecated Use parseProvider instead */
  export const parseFamily = parseProvider

  /**
   * Smartly get a display name for an account info
   * WYSIWYG: Always prefer email for identification
   */
  export function getDisplayName(id: string, info: Info, provider: string): string {
    const { JWT } = require("../util/jwt"); // Lazy import to avoid cycle if any

    // 1. Try JWT Decoding (OpenAI / Google OAuth)
    let email = (info.type === "subscription" && info.accessToken) ? JWT.getEmail(info.accessToken) : (info as any).email;
    if (!email && info.type === "subscription" && info.refreshToken) email = JWT.getEmail(info.refreshToken);

    // 2. Check accountId and name fields for email patterns
    if (!email || email === provider) {
      if ((info as any).accountId && (info as any).accountId.includes("@")) email = (info as any).accountId;
      else if (info.name && info.name.includes("@")) email = info.name;
    }

    // 3. If we have an email, use it
    if (email && email !== provider && email.includes("@")) {
      return email;
    }

    // 4. For API accounts, the name field should be the user-provided name
    if (info.type === "api" && info.name && info.name !== provider) {
      // Check if name looks useful (not just the provider name repeated)
      const isUseful = info.name !== provider &&
                       !info.name.startsWith(`${provider}-`) &&
                       !JWT.isUUID(info.name);
      if (isUseful) return info.name;
    }

    // 5. For subscription accounts, try accountId or username
    if (info.type === "subscription") {
      const sub = info as SubscriptionAccount;
      if (sub.accountId && sub.accountId !== provider && !JWT.isUUID(sub.accountId)) {
        return sub.accountId;
      }
    }

    // 6. Extract meaningful part from account ID if it looks like {provider}-{type}-{name}
    const idMatch = id.match(/^[^-]+-(?:api|subscription)-(.+)$/)
    if (idMatch && idMatch[1] && idMatch[1] !== provider) {
      // Convert dashes back to something readable
      const extracted = idMatch[1].replace(/-/g, ' ')
      if (extracted !== provider && !JWT.isUUID(extracted)) {
        return extracted;
      }
    }

    // 7. Fallback - at least show something other than raw ID
    if (info.name && info.name !== provider) return info.name;

    // 8. Last resort: generate a short label
    const shortId = id.split('-').pop() || id
    return shortId !== provider ? shortId : `Account`;
  }

  async function migrateToV2(storage: any): Promise<Storage> {
    log.info("Migrating accounts.json to v2...")
    if (storage.families.google && storage.families.google.accounts) {
      const googleAccounts = storage.families.google.accounts
      const antigravityAccounts: Record<string, any> = {}
      const geminiCliAccounts: Record<string, any> = {}
      const remainingGoogleAccounts: Record<string, any> = {}

      for (const [id, account] of Object.entries(googleAccounts as Record<string, any>)) {
        let moved = false
        // Clue for antigravity: fingerprint userAgent or rate limits
        const isAntigravity = account.fingerprint?.userAgent?.includes("antigravity") ||
          Object.keys(account.rateLimitResetTimes || {}).some(k => k.startsWith("gemini-antigravity"))

        // Clue for gemini-cli: rate limits or specific fields
        const isGeminiCli = Object.keys(account.rateLimitResetTimes || {}).some(k => k.startsWith("gemini-cli"))

        if (isAntigravity) {
          const newId = id.replace(/^google-/, "antigravity-")
          antigravityAccounts[newId] = { ...account }
          moved = true
        } else if (isGeminiCli) {
          const newId = id.replace(/^google-/, "gemini-cli-")
          geminiCliAccounts[newId] = { ...account }
          moved = true
        } else {
          remainingGoogleAccounts[id] = account
        }
      }

      if (Object.keys(antigravityAccounts).length > 0) {
        storage.families.antigravity = {
          accounts: antigravityAccounts,
          activeAccount: Object.keys(antigravityAccounts)[0]
        }
      }
      if (Object.keys(geminiCliAccounts).length > 0) {
        storage.families["gemini-cli"] = {
          accounts: geminiCliAccounts,
          activeAccount: Object.keys(geminiCliAccounts)[0]
        }
      }
      storage.families.google.accounts = remainingGoogleAccounts
      if (Object.keys(remainingGoogleAccounts).length === 0) {
        delete storage.families.google
      } else {
        storage.families.google.activeAccount = Object.keys(remainingGoogleAccounts)[0]
      }
    }
    storage.version = 2
    return storage as Storage
  }

  /**
   * Migrate from old storage formats
   */
  async function migrate(): Promise<Storage | null> {
    log.info("Checking for accounts to migrate...")
    const storage: Storage = { version: CURRENT_VERSION, families: {} }
    let hasMigrated = false

    // 1. Migrate from auth.json
    // - API keys: migrate all
    // - OAuth: only migrate for providers that DON'T have separate multi-account files
    //   - Google OAuth: skip (comes from antigravity-accounts.json)
    //   - OpenAI OAuth: skip (comes from openai-codex-accounts.json)
    //   - Anthropic OAuth: migrate (no separate multi-account file)
    const authPath = path.join(Global.Path.data, "auth.json")
    const authFile = Bun.file(authPath)
    if (await authFile.exists()) {
      try {
        const authData = await authFile.json()
        for (const [providerID, auth] of Object.entries(authData)) {
          const provider = parseProviderFromLegacyId(providerID)
          if (!provider || !PROVIDERS.includes(provider as Provider)) continue

          const authInfo = auth as any
          if (authInfo.type === "api") {
            // Migrate all API keys
            if (!storage.families[provider]) {
              storage.families[provider] = { accounts: {} }
            }
            const accountId = generateId(provider, "api", providerID.replace(`${provider}-`, "") || "default")
            storage.families[provider].accounts[accountId] = {
              type: "api",
              name: providerID === provider ? "Default" : providerID.replace(`${provider}-`, ""),
              apiKey: authInfo.key,
              addedAt: Date.now(),
            }
            if (!storage.families[provider].activeAccount) {
              storage.families[provider].activeAccount = accountId
            }
            hasMigrated = true
          } else if (authInfo.type === "oauth") {
            // Only migrate OAuth for providers without separate multi-account files
            // Google and OpenAI have their own account files, Anthropic doesn't
            if (provider === "google" || provider === "google-api" || provider === "openai") {
              continue // Skip - will be migrated from antigravity/codex account files
            }
            // Skip Anthropic if already present (avoid duplicates with new format)
            if (provider === "anthropic" && storage.families["anthropic"] && Object.keys(storage.families["anthropic"].accounts).length > 0) {
              continue
            }

            if (!storage.families[provider]) {
              storage.families[provider] = { accounts: {} }
            }
            const accountId = generateId(provider, "subscription", authInfo.accountId || providerID.replace(`${provider}-`, "") || "default")
            storage.families[provider].accounts[accountId] = {
              type: "subscription",
              name: authInfo.accountId || providerID,
              email: authInfo.accountId,
              refreshToken: authInfo.refresh,
              accessToken: authInfo.access,
              expiresAt: authInfo.expires,
              accountId: authInfo.accountId,
              addedAt: Date.now(),
            }
            if (!storage.families[provider].activeAccount) {
              storage.families[provider].activeAccount = accountId
            }
            hasMigrated = true
          }
        }
      } catch (e) {
        log.warn("Failed to migrate auth.json", { error: e })
      }
    }

    // Post-migrate cleanup: Remove legacy account ID if new format exists for Anthropic
    if (storage.families["anthropic"] && storage.families["anthropic"].accounts["anthropic"] && storage.families["anthropic"].accounts["anthropic-subscription-anthropic"]) {
      delete storage.families["anthropic"].accounts["anthropic"];
      if (storage.families["anthropic"].activeAccount === "anthropic") {
        storage.families["anthropic"].activeAccount = "anthropic-subscription-anthropic";
      }
    }


    // 2. Migrate from antigravity-accounts.json
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(Global.Path.home, ".config")
    const antigravityPath = path.join(xdgConfig, "opencode", "antigravity-accounts.json")
    const antigravityFile = Bun.file(antigravityPath)
    if (await antigravityFile.exists()) {
      try {
        const data = await antigravityFile.json()
        if (data.accounts && Array.isArray(data.accounts)) {
          if (!storage.families["antigravity"]) {
            storage.families["antigravity"] = { accounts: {} }
          }

          for (let i = 0; i < data.accounts.length; i++) {
            const account = data.accounts[i]
            const accountId = `antigravity-subscription-${i + 1}`
            storage.families["antigravity"].accounts[accountId] = {
              type: "subscription",
              name: account.email || `Account ${i + 1}`,
              email: account.email,
              refreshToken: account.refreshToken,
              projectId: account.projectId,
              managedProjectId: account.managedProjectId,
              addedAt: account.addedAt || Date.now(),
              rateLimitResetTimes: account.rateLimitResetTimes,
              coolingDownUntil: account.coolingDownUntil,
              cooldownReason: account.cooldownReason,
              fingerprint: account.fingerprint,
            }

            // Set active based on activeIndex
            if (data.activeIndex === i && !storage.families["antigravity"].activeAccount) {
              storage.families["antigravity"].activeAccount = accountId
            }
          }
          hasMigrated = true
          log.info("Migrated antigravity accounts", { count: data.accounts.length })
        }
      } catch (e) {
        log.warn("Failed to migrate antigravity-accounts.json", { error: e })
      }
    }

    // 3. Migrate from openai-codex-accounts.json (if exists)
    // Note: The external codex plugin stores in ~/.opencode/, not ~/.config/opencode/
    const codexPath = path.join(Global.Path.home, ".opencode", "openai-codex-accounts.json")
    const codexFile = Bun.file(codexPath)
    if (await codexFile.exists()) {
      try {
        const data = await codexFile.json()
        if (data.accounts && Array.isArray(data.accounts)) {
          if (!storage.families["openai"]) {
            storage.families["openai"] = { accounts: {} }
          }

          for (let i = 0; i < data.accounts.length; i++) {
            const account = data.accounts[i]
            const accountId = `openai-subscription-${i + 1}`
            storage.families["openai"].accounts[accountId] = {
              type: "subscription",
              name: account.email || `Account ${i + 1}`,
              email: account.email,
              refreshToken: account.refreshToken,
              accountId: account.accountId,
              addedAt: account.addedAt || Date.now(),
            }

            if (data.activeIndex === i && !storage.families["openai"].activeAccount) {
              storage.families["openai"].activeAccount = accountId
            }
          }
          hasMigrated = true
          log.info("Migrated OpenAI Codex accounts", { count: data.accounts.length })
        }
      } catch (e) {
        log.warn("Failed to migrate openai-codex-accounts.json", { error: e })
      }
    }

    if (hasMigrated) {
      await save(storage)
      log.info("Migration complete", { families: Object.keys(storage.families) })
      return storage
    }

    return null
  }

  /**
   * Parse provider from legacy provider ID (used in migration)
   */
  function parseProviderFromLegacyId(providerID: string): string | undefined {
    // Handle suffixed providers like "google-api-work" -> "google-api"
    const match = providerID.match(/^([a-z]+)(-[a-z0-9-]+)?$/)
    if (match) {
      return match[1]
    }
    return undefined
  }

  /**
   * Refresh the state (reload from disk)
   */
  export async function refresh(): Promise<void> {
    _storage = await load()
  }

  /**
   * Force migration from auth.json to accounts.json
   * This should be called at bootstrap to ensure single source of truth
   * Backs up auth.json to auth.json.migrated and deletes the original
   */
  export async function forceFullMigration(): Promise<boolean> {
    const authPath = path.join(Global.Path.data, "auth.json")
    const file = Bun.file(authPath)

    if (!(await file.exists())) {
      log.info("No auth.json to migrate")
      return false
    }

    try {
      const authData = await file.json()
      const storage = await state()
      let migrated = false

      for (const [providerID, auth] of Object.entries(authData as Record<string, any>)) {
        const provider = parseProviderFromLegacyId(providerID)
        if (!provider || !PROVIDERS.includes(provider as Provider)) continue

        if (!storage.families[provider]) {
          storage.families[provider] = { accounts: {} }
        }

        // Skip if provider already has accounts (don't overwrite existing data)
        if (Object.keys(storage.families[provider].accounts).length > 0) continue

        if (auth.type === "api") {
          const accountId = generateId(provider, "api", "default")
          storage.families[provider].accounts[accountId] = {
            type: "api",
            name: "Default",
            apiKey: auth.key,
            addedAt: Date.now(),
          }
          storage.families[provider].activeAccount = accountId
          migrated = true
          log.info("Migrated API key", { provider, accountId })
        } else if (auth.type === "oauth") {
          const slug = auth.email || auth.accountId || "default"
          const accountId = generateId(provider, "subscription", slug)
          storage.families[provider].accounts[accountId] = {
            type: "subscription",
            name: slug,
            email: auth.email,
            refreshToken: auth.refresh,
            accessToken: auth.access,
            expiresAt: auth.expires,
            accountId: auth.accountId,
            addedAt: Date.now(),
          }
          storage.families[provider].activeAccount = accountId
          migrated = true
          log.info("Migrated OAuth account", { provider, accountId, email: auth.email })
        }
      }

      if (migrated) {
        await save(storage)
        // Refresh cached state
        _storage = storage
      }

      // Backup and delete auth.json
      const backupPath = path.join(Global.Path.data, "auth.json.migrated")
      await Bun.write(backupPath, await file.text())
      await fs.unlink(authPath)

      log.info("auth.json migrated to accounts.json", {
        backup: backupPath,
        migrated,
      })
      return true
    } catch (e) {
      log.error("Failed to migrate auth.json", { error: e })
      return false
    }
  }

  // ============================================================================
  // ROTATION INTEGRATION
  // ============================================================================

  /**
   * Get the next available account for a provider using rotation.
   * Takes into account health scores and rate limits.
   *
   * @param provider Provider ID (e.g., "openai", "anthropic", "antigravity")
   * @param model Optional model ID for model-specific rate limits
   * @returns Account ID and info, or undefined if none available
   */
  export async function getNextAvailable(
    provider: string,
    model?: string,
  ): Promise<{ id: string; info: Info } | undefined> {
    const rotation = await import("./rotation")

    const storage = await state()
    const providerData = storage.families[provider]
    if (!providerData || Object.keys(providerData.accounts).length === 0) {
      return undefined
    }

    const healthTracker = rotation.getHealthTracker()
    const rateLimitTracker = rotation.getRateLimitTracker()

    // Build candidate list
    const candidates: AccountCandidate[] = []
    for (const [id, info] of Object.entries(providerData.accounts)) {
      const lastUsed = info.type === "subscription" ? (info as any).lastUsed ?? 0 : 0
      candidates.push({
        id,
        lastUsed,
        healthScore: healthTracker.getScore(id),
        isRateLimited: rateLimitTracker.isRateLimited(id, provider, model),
        isCoolingDown: info.type === "subscription" && (info as any).coolingDownUntil
          ? Date.now() < (info as any).coolingDownUntil
          : false,
      })
    }

    // Select best account
    const currentActiveId = providerData.activeAccount ?? null
    const selectedId = rotation.selectBestAccount(candidates, currentActiveId)

    if (!selectedId) {
      log.warn("No available account for rotation", { provider, model })
      return undefined
    }

    const selectedInfo = providerData.accounts[selectedId]
    if (!selectedInfo) {
      return undefined
    }

    return { id: selectedId, info: selectedInfo }
  }

  /**
   * Record a successful request for an account.
   * Improves health score.
   */
  export async function recordSuccess(accountId: string): Promise<void> {
    const { getHealthTracker } = await import("./rotation")
    getHealthTracker().recordSuccess(accountId)
    log.debug("Recorded success", { accountId })
  }

  /**
   * Record a rate limit for an account.
   * Marks the account as rate limited and reduces health score.
   *
   * @param accountId Account ID
   * @param provider Provider ID
   * @param reason Rate limit reason
   * @param backoffMs Backoff time in milliseconds
   * @param model Optional model ID
   */
  export async function recordRateLimit(
    accountId: string,
    provider: string,
    reason: string,
    backoffMs: number,
    model?: string,
  ): Promise<void> {
    const rotation = await import("./rotation")

    const healthTracker = rotation.getHealthTracker()
    const rateLimitTracker = rotation.getRateLimitTracker()

    healthTracker.recordRateLimit(accountId)
    rateLimitTracker.markRateLimited(
      accountId,
      provider,
      reason as RateLimitReason,
      backoffMs,
      model,
    )

    log.info("Recorded rate limit", { accountId, provider, reason, backoffMs, model })
  }

  /**
   * Record a failure for an account.
   * Reduces health score more significantly than rate limits.
   */
  export async function recordFailure(accountId: string): Promise<void> {
    const { getHealthTracker } = await import("./rotation")
    getHealthTracker().recordFailure(accountId)
    log.warn("Recorded failure", { accountId })
  }

  /**
   * Check if an account is rate limited.
   */
  export async function isRateLimited(accountId: string, provider: string, model?: string): Promise<boolean> {
    const { getRateLimitTracker } = await import("./rotation")
    return getRateLimitTracker().isRateLimited(accountId, provider, model)
  }

  /**
   * Get the minimum wait time until any account becomes available.
   */
  export async function getMinWaitTime(provider: string, model?: string): Promise<number> {
    const { getRateLimitTracker } = await import("./rotation")
    const rateLimitTracker = getRateLimitTracker()

    const storage = await state()
    const providerData = storage.families[provider]
    if (!providerData) return 0

    let minWait = Infinity
    for (const id of Object.keys(providerData.accounts)) {
      const wait = rateLimitTracker.getWaitTime(id, provider, model)
      if (wait === 0) return 0 // Found an available account
      minWait = Math.min(minWait, wait)
    }

    return minWait === Infinity ? 0 : minWait
  }

  /**
   * Clear all rate limits for a provider.
   */
  export async function clearRateLimits(provider: string): Promise<void> {
    const { getRateLimitTracker } = await import("./rotation")
    const rateLimitTracker = getRateLimitTracker()

    const storage = await state()
    const providerData = storage.families[provider]
    if (!providerData) return

    for (const id of Object.keys(providerData.accounts)) {
      rateLimitTracker.clear(id, provider)
    }

    log.info("Cleared rate limits", { provider })
  }

  /**
   * Get health and rate limit status for all accounts in a provider.
   * Useful for debugging and admin UI.
   */
  export async function getRotationStatus(
    provider: string,
  ): Promise<
    Array<{
      id: string
      name: string
      healthScore: number
      isRateLimited: boolean
      waitTimeMs: number
      consecutiveFailures: number
    }>
  > {
    const { getHealthTracker, getRateLimitTracker } = await import("./rotation")

    const storage = await state()
    const providerData = storage.families[provider]
    if (!providerData) return []

    const healthTracker = getHealthTracker()
    const rateLimitTracker = getRateLimitTracker()

    const result = []
    for (const [id, info] of Object.entries(providerData.accounts)) {
      result.push({
        id,
        name: info.name,
        healthScore: healthTracker.getScore(id),
        isRateLimited: rateLimitTracker.isRateLimited(id, provider),
        waitTimeMs: rateLimitTracker.getWaitTime(id, provider),
        consecutiveFailures: healthTracker.getConsecutiveFailures(id),
      })
    }

    return result
  }
}
