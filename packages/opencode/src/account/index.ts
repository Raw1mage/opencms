import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"
import { Log } from "../util/log"
import { Instance } from "../project/instance"

const log = Log.create({ service: "account" })

export namespace Account {
  // Provider families that support multi-account
  export const FAMILIES = ["google", "openai", "anthropic", "antigravity", "gemini-cli", "gitlab"] as const
  export type Family = (typeof FAMILIES)[number]

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

  // Family data schema
  export const FamilyData = z.object({
    activeAccount: z.string().optional(),
    accounts: z.record(z.string(), Info),
  })
  export type FamilyData = z.infer<typeof FamilyData>

  // Storage schema
  export const Storage = z.object({
    version: z.number(),
    families: z.record(z.string(), FamilyData),
  })
  export type Storage = z.infer<typeof Storage>

  const CURRENT_VERSION = 2
  const filepath = path.join(Global.Path.data, "accounts.json")

  // Cached state
  let _storage: Storage | undefined
  async function state(): Promise<Storage> {
    if (!_storage) {
      _storage = await load()
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
    const file = Bun.file(filepath)
    await Bun.write(file, JSON.stringify(storage, null, 2))
    await fs.chmod(filepath, 0o600)
  }

  /**
   * List all accounts for a provider family
   */
  export async function list(family: string): Promise<Record<string, Info>> {
    const storage = await state()
    return storage.families[family]?.accounts ?? {}
  }

  /**
   * List all families with their data
   */
  export async function listAll(): Promise<Record<string, FamilyData>> {
    const storage = await state()
    return storage.families
  }

  /**
   * Get a specific account
   */
  export async function get(family: string, accountId: string): Promise<Info | undefined> {
    const storage = await state()
    return storage.families[family]?.accounts[accountId]
  }

  /**
   * Get account by full ID (e.g., "google-api-personal")
   */
  export async function getById(accountId: string): Promise<{ family: string; info: Info } | undefined> {
    const storage = await state()
    for (const [family, data] of Object.entries(storage.families)) {
      if (data.accounts[accountId]) {
        return { family, info: data.accounts[accountId] }
      }
    }
    return undefined
  }

  /**
   * Add a new account
   */
  export async function add(family: string, accountId: string, info: Info): Promise<void> {
    const storage = await state()

    if (!storage.families[family]) {
      storage.families[family] = { accounts: {} }
    }

    storage.families[family].accounts[accountId] = info

    // If this is the first account, make it active
    if (!storage.families[family].activeAccount) {
      storage.families[family].activeAccount = accountId
    }

    await save(storage)
    log.info("Account added", { family, accountId, type: info.type })
  }

  /**
   * Update an existing account
   */
  export async function update(family: string, accountId: string, info: Partial<Info>): Promise<void> {
    const storage = await state()
    const existing = storage.families[family]?.accounts[accountId]

    if (!existing) {
      throw new Error(`Account not found: ${family}/${accountId}`)
    }

    storage.families[family].accounts[accountId] = { ...existing, ...info } as Info
    await save(storage)
  }

  /**
   * Remove an account
   */
  export async function remove(family: string, accountId: string): Promise<void> {
    const storage = await state()

    if (!storage.families[family]?.accounts[accountId]) {
      return
    }

    delete storage.families[family].accounts[accountId]

    // If we removed the active account, pick another
    if (storage.families[family].activeAccount === accountId) {
      const remaining = Object.keys(storage.families[family].accounts)
      storage.families[family].activeAccount = remaining[0]
    }

    await save(storage)
    log.info("Account removed", { family, accountId })
  }

  /**
   * Set the active account for a family
   */
  export async function setActive(family: string, accountId: string): Promise<void> {
    const storage = await state()

    if (!storage.families[family]?.accounts[accountId]) {
      throw new Error(`Account not found: ${family}/${accountId}`)
    }

    storage.families[family].activeAccount = accountId
    await save(storage)
    log.info("Active account changed", { family, accountId })
  }

  /**
   * Get the active account ID for a family
   */
  export async function getActive(family: string): Promise<string | undefined> {
    const storage = await state()
    return storage.families[family]?.activeAccount
  }

  /**
   * Get the active account info for a family
   */
  export async function getActiveInfo(family: string): Promise<Info | undefined> {
    const storage = await state()
    const activeId = storage.families[family]?.activeAccount
    if (!activeId) return undefined
    return storage.families[family]?.accounts[activeId]
  }

  /**
   * Generate a unique account ID
   */
  export function generateId(family: string, type: "api" | "subscription", name?: string): string {
    const suffix = name?.toLowerCase().replace(/[^a-z0-9]/g, "-") || Date.now().toString(36)
    return `${family}-${type}-${suffix}`
  }

  /**
   * Parse family from account ID
   */
  export function parseFamily(accountId: string): string | undefined {
    for (const family of FAMILIES) {
      if (accountId === family || accountId.startsWith(`${family}-`)) {
        return family
      }
    }
    return undefined
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
          const family = parseProviderFamily(providerID)
          if (!family || !FAMILIES.includes(family as Family)) continue

          const authInfo = auth as any
          if (authInfo.type === "api") {
            // Migrate all API keys
            if (!storage.families[family]) {
              storage.families[family] = { accounts: {} }
            }
            const accountId = generateId(family, "api", providerID.replace(`${family}-`, "") || "default")
            storage.families[family].accounts[accountId] = {
              type: "api",
              name: providerID === family ? "Default" : providerID.replace(`${family}-`, ""),
              apiKey: authInfo.key,
              addedAt: Date.now(),
            }
            if (!storage.families[family].activeAccount) {
              storage.families[family].activeAccount = accountId
            }
            hasMigrated = true
          } else if (authInfo.type === "oauth") {
            // Only migrate OAuth for providers without separate multi-account files
            // Google and OpenAI have their own account files, Anthropic doesn't
            if (family === "google" || family === "openai") {
              continue // Skip - will be migrated from antigravity/codex account files
            }
            if (!storage.families[family]) {
              storage.families[family] = { accounts: {} }
            }
            const accountId = generateId(family, "subscription", authInfo.accountId || providerID.replace(`${family}-`, "") || "default")
            storage.families[family].accounts[accountId] = {
              type: "subscription",
              name: authInfo.accountId || providerID,
              email: authInfo.accountId,
              refreshToken: authInfo.refresh,
              accessToken: authInfo.access,
              expiresAt: authInfo.expires,
              accountId: authInfo.accountId,
              addedAt: Date.now(),
            }
            if (!storage.families[family].activeAccount) {
              storage.families[family].activeAccount = accountId
            }
            hasMigrated = true
          }
        }
      } catch (e) {
        log.warn("Failed to migrate auth.json", { error: e })
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
   * Parse provider family from provider ID
   */
  function parseProviderFamily(providerID: string): string | undefined {
    // Handle suffixed providers like "google-work" -> "google"
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
}
