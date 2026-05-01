import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"
import { Log } from "../util/log"
import { debugCheckpoint } from "../util/debug"
import { Instance } from "../project/instance"
import type { AccountCandidate, RateLimitReason } from "./rotation"
import { Bus } from "../bus"

// Re-export rotation modules for global account rotation
export * from "./rotation"
export * from "./rotation3d"
export * from "./monitor"

const log = Log.create({ service: "account" })

export namespace Account {
  // Known OAuth providers - these have specialized handling or OAuth flows.
  // NOTE: This is NOT a whitelist - any provider can have accounts added.
  // This list is for documentation and special case handling only.
  export const PROVIDERS = [
    "google-api",
    "openai",
    "claude-cli",
    "gemini-cli",
    "gitlab",
    "github-copilot",
    "gmicloud",
    "opencode",
  ] as const
  export type Provider = (typeof PROVIDERS)[number]

  /** @deprecated Use PROVIDERS instead */
  export const FAMILIES = PROVIDERS
  // Account type schemas
  export const ApiAccount = z.object({
    type: z.literal("api"),
    name: z.string(),
    apiKey: z.string(),
    addedAt: z.number(),
    projectId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
    metadata: z.record(z.string(), z.unknown()).optional(),
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
  export const AccountProviderData = ProviderData
  export type AccountProviderData = ProviderData

  // Provider-first compatibility aliases
  export const knownProviders = knownFamilies
  export const resolveProvider = resolveFamily
  export const resolveProviderOrSelf = resolveFamilyOrSelf
  // @event_20260314: removed parseProviderKey (zero importers)

  // Storage schema
  // NOTE: Uses "families" key for backward compatibility with existing accounts.json files.
  // Conceptually this is provider-keyed storage: each top-level key is an account-bearing provider boundary.
  export const Storage = z.object({
    version: z.number(),
    families: z.record(z.string(), ProviderData),
  })
  export type Storage = z.infer<typeof Storage>

  const CURRENT_VERSION = 2
  const filepath = path.join(Global.Path.user, "accounts.json")
  const legacyOpencodeFilepath = path.join(Global.Path.home, ".opencode", "accounts.json")

  // Cached state
  let _storage: Storage | undefined
  let _mtime: number | undefined

  function providersOf(storage: Storage): Record<string, ProviderData> {
    return storage.families
  }

  function providerKeysOf(storage: Storage): string[] {
    return Object.keys(providersOf(storage))
  }

  async function getDiskMtime(): Promise<number | undefined> {
    const file = Bun.file(filepath)
    if (!(await file.exists())) return
    const mtime = file.lastModified
    if (typeof mtime !== "number") return
    return mtime
  }

  async function state(): Promise<Storage> {
    if (_storage) {
      const mtime = await getDiskMtime()
      if (mtime === _mtime) {
        debugCheckpoint("Account.state", "Using cached state", { providerKeys: providerKeysOf(_storage) })
        return _storage
      }
      debugCheckpoint("Account.state", "Loading from disk", { reason: "mtime-changed" })
    } else {
      debugCheckpoint("Account.state", "Loading from disk", { reason: "no-cache" })
    }

    _storage = await load()
    _mtime = await getDiskMtime()
    debugCheckpoint("Account.state", "Loaded", { providerKeys: providerKeysOf(_storage) })
    return _storage
  }

  async function load(): Promise<Storage> {
    const file = Bun.file(filepath)
    let exists = await file.exists()

    // @event_2026-02-07_install: one-time migration from ~/.opencode/accounts.json
    // Robust check: migrate if target missing OR effectively empty (< 50 bytes)
    const isTargetMissingOrEmpty = !exists || (await file.size) < 50
    if (isTargetMissingOrEmpty) {
      const legacyOpencodeFile = Bun.file(legacyOpencodeFilepath)
      if (await legacyOpencodeFile.exists()) {
        const legacySize = await legacyOpencodeFile.size
        if (legacySize > 50) {
          log.info("Migrating accounts.json from legacy ~/.opencode", {
            from: legacyOpencodeFilepath,
            to: filepath,
            size: legacySize,
          })
          await fs.mkdir(path.dirname(filepath), { recursive: true }).catch(() => {})
          try {
            await fs.rename(legacyOpencodeFilepath, filepath)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== "EXDEV") throw error
            await fs.copyFile(legacyOpencodeFilepath, filepath)
            await fs.rm(legacyOpencodeFilepath, { force: true })
          }
          await fs.chmod(filepath, 0o600).catch(() => {})
          exists = true
        }
      }
    }

    // @event_20260314: removed legacy XDG migration (~/.local/share/opencode/accounts.json)
    // That file was a shadow-write artifact, not a genuine legacy source.

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

      // @event_20260314: removed anthropic→claude-cli one-time migration (B1)

      if (storage.version < 2) {
        storage = await migrateToV2(storage)
        await save(storage)
      }

      let shouldSave = false

      // @event_20260326: strip managed app provider keys from accounts.json.
      // Managed apps (google-calendar, gmail) use gauth.json for OAuth tokens,
      // NOT accounts.json. Residual empty families cause them to appear as
      // LLM providers in the Model Manager.
      {
        const { ManagedAppRegistry } = await import("../mcp/app-registry")
        const managedKeys = ManagedAppRegistry.catalog().map((entry) => entry.auth.providerKey)
        for (const key of managedKeys) {
          if (storage.families[key]) {
            log.info("Removing managed app residual from accounts.json", { key })
            delete storage.families[key]
            shouldSave = true
          }
        }
      }

      // Normalize family keys that were created from provider instance IDs
      // (e.g. "nvidia-work" should resolve back to canonical family "nvidia").
      // This removes ambiguity between provider/account/model coordinates.
      const normalized = await normalizeFamilyKeys(storage)
      if (normalized.changed) {
        storage = normalized.storage
        shouldSave = true
      }

      if (shouldSave) {
        await save(storage)
      }

      return storage
    } catch (e) {
      log.error("Failed to load accounts.json", { error: e })
      return { version: CURRENT_VERSION, families: {} }
    }
  }

  async function listKnownProvidersInternal(options?: { includeStorage?: boolean }): Promise<string[]> {
    const includeStorage = options?.includeStorage ?? true
    const { ModelsDev } = await import("../provider/models")
    const fromModels = Object.keys(await ModelsDev.get().catch(() => ({}) as Record<string, unknown>))
    const fromStorage = includeStorage ? providerKeysOf(await state()) : []
    return Array.from(new Set([...PROVIDERS, ...fromModels, ...fromStorage]))
  }

  const listKnownFamiliesInternal = listKnownProvidersInternal

  export async function knownFamilies(options?: { includeStorage?: boolean }): Promise<string[]> {
    return listKnownProvidersInternal(options)
  }

  /**
   * @internal:migration-only
   *
   * Recovers a family from a per-account or per-instance providerId via regex
   * + longest-prefix matching. Kept ONLY so the one-shot migration script
   * (specs/provider-account-decoupling/ DD-9) can normalise legacy storage
   * fields. Runtime dispatch paths MUST NOT call this — pass family + accountId
   * as separate dimensions instead. Adding new runtime callers re-introduces
   * the 2026-05-02 CodexFamilyExhausted bug class.
   */
  export function resolveFamilyFromKnown(providerId: string, knownFamilies: readonly string[]): string | undefined {
    if (!providerId) return undefined
    const unique = Array.from(new Set(knownFamilies.filter(Boolean)))
    const set = new Set(unique)

    // 1) Exact family match
    if (set.has(providerId)) {
      return providerId
    }

    // 2) Account ID form: {family}-{api|subscription}-{slug}
    const accountIdMatch = providerId.match(/^(.+)-(api|subscription)-/)
    if (accountIdMatch?.[1] && set.has(accountIdMatch[1])) {
      return accountIdMatch[1]
    }

    // 3) Provider instance form: {family}-{instanceSlug}
    const sorted = [...unique].sort((a, b) => b.length - a.length)
    for (const family of sorted) {
      if (providerId.startsWith(`${family}-`)) {
        return family
      }
    }

    return undefined
  }

  export async function resolveFamily(providerId: string): Promise<string | undefined> {
    const known = await knownFamilies({ includeStorage: true })
    return resolveFamilyFromKnown(providerId, known)
  }

  export async function resolveFamilyOrSelf(providerId: string): Promise<string> {
    return (await resolveFamily(providerId)) ?? providerId
  }

  function resolveCanonicalProviderKeyFromKnown(family: string, knownFamilies: readonly string[]): string | undefined {
    return resolveFamilyFromKnown(family, knownFamilies)
  }

  function inferProviderKeyFromAccountIds(
    accounts: Record<string, Info>,
    knownFamilies: readonly string[],
  ): string | undefined {
    const set = new Set(knownFamilies)
    const counts = new Map<string, number>()

    for (const accountId of Object.keys(accounts)) {
      const match = accountId.match(/^(.+)-(api|subscription)-/)
      const prefix = match?.[1]
      if (!prefix || !set.has(prefix)) continue
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
    }

    let winner: string | undefined
    let score = 0
    for (const [family, count] of counts) {
      if (count > score) {
        winner = family
        score = count
      }
    }

    return winner
  }

  function mergeProviderData(target: ProviderData, source: ProviderData): boolean {
    let changed = false

    for (const [accountId, info] of Object.entries(source.accounts)) {
      if (!target.accounts[accountId]) {
        target.accounts[accountId] = info
        changed = true
        continue
      }

      // Collision fallback: retain both entries to avoid silent data loss.
      let nextId = `${accountId}-migrated`
      let counter = 2
      while (target.accounts[nextId]) {
        nextId = `${accountId}-migrated-${counter}`
        counter++
      }
      target.accounts[nextId] = info
      changed = true
    }

    if (source.activeAccount && target.accounts[source.activeAccount] && !target.activeAccount) {
      target.activeAccount = source.activeAccount
      changed = true
    }

    return changed
  }

  type ProviderNormalizationMove = {
    from: string
    to: string
    accountCount: number
  }

  type FamilyNormalizationMove = ProviderNormalizationMove

  async function normalizeProviderKeys(
    storage: Storage,
  ): Promise<{ storage: Storage; changed: boolean; moves: ProviderNormalizationMove[] }> {
    const knownFamilies = await listKnownProvidersInternal({ includeStorage: false })
    let changed = false
    const moves: ProviderNormalizationMove[] = []

    for (const [family, data] of Object.entries(storage.families)) {
      const direct = resolveCanonicalProviderKeyFromKnown(family, knownFamilies)
      const inferred = inferProviderKeyFromAccountIds(data.accounts, knownFamilies)
      const canonical = direct ?? inferred

      if (!canonical || canonical === family) continue

      const target = (storage.families[canonical] ??= { accounts: {} })
      const merged = mergeProviderData(target, data)
      delete storage.families[family]

      if (merged || canonical !== family) {
        changed = true
        moves.push({
          from: family,
          to: canonical,
          accountCount: Object.keys(data.accounts).length,
        })
        log.info("Normalized provider family key", {
          from: family,
          to: canonical,
          accountCount: Object.keys(data.accounts).length,
        })
      }
    }

    return { storage, changed, moves }
  }

  const normalizeFamilyKeys = normalizeProviderKeys

  // @event_20260319_daemonization Phase ε.7 — In-process mutex for account mutations
  // Serializes all read-modify-write operations so concurrent TUI + webapp calls
  // within the same per-user daemon cannot race on accounts.json.
  let _mutexChain: Promise<void> = Promise.resolve()
  function withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const result = _mutexChain.then(fn, fn)
    _mutexChain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  // @event_20260319_daemonization Phase ε.2 — Sanitize account info before publishing
  // Strips secret fields so events are safe to broadcast over SSE.
  function sanitizeInfo(info: Info): { type: "api" | "subscription"; name: string; addedAt: number } {
    return {
      type: info.type,
      name: info.name,
      addedAt: info.addedAt,
    }
  }

  async function save(storage: Storage): Promise<void> {
    debugCheckpoint("Account.save", "Writing", { path: filepath })
    try {
      const content = JSON.stringify(storage, null, 2)
      debugCheckpoint("Account.save", "Content ready", {
        length: content.length,
        providerKeys: providerKeysOf(storage),
      })

      // Primary save to ~/.config
      await Bun.write(filepath, content)
      await fs.chmod(filepath, 0o600)

      _mtime = await getDiskMtime()
      debugCheckpoint("Account.save", "Write successful")
    } catch (e) {
      debugCheckpoint("Account.save", "Write failed", { error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }

  /**
   * List all accounts for a provider
   */
  export async function list(provider: string): Promise<Record<string, Info>> {
    const storage = await state()
    const accounts = providersOf(storage)[provider]?.accounts ?? {}
    debugCheckpoint("Account.list", provider, {
      accountCount: Object.keys(accounts).length,
      accountIds: Object.keys(accounts),
    })
    return accounts
  }

  /**
   * List all providers with their data
   */
  export async function listAll(): Promise<Record<string, ProviderData>> {
    const storage = await state()
    return providersOf(storage)
  }

  /**
   * Get a specific account
   */
  export async function get(provider: string, accountId: string): Promise<Info | undefined> {
    const storage = await state()
    return providersOf(storage)[provider]?.accounts[accountId]
  }

  /**
   * Get account by full ID (e.g., "google-api-personal")
   */
  export async function getById(accountId: string): Promise<{ provider: string; info: Info } | undefined> {
    const storage = await state()
    for (const [provider, data] of Object.entries(providersOf(storage))) {
      if (data.accounts[accountId]) {
        return { provider, info: data.accounts[accountId] }
      }
    }
    return undefined
  }

  /**
   * Add a new account
   */
  export function add(provider: string, accountId: string, info: Info): Promise<void> {
    return withMutex(async () => {
      debugCheckpoint("Account.add", "Starting", { provider, accountId, type: info.type })
      const storage = await state()
      debugCheckpoint("Account.add", "Got state", { existingProviderKeys: providerKeysOf(storage) })

      if (!providersOf(storage)[provider]) {
        providersOf(storage)[provider] = { accounts: {} }
        debugCheckpoint("Account.add", "Created new provider entry", { provider })
      }

      if (providersOf(storage)[provider].accounts[accountId]) {
        throw new Error(`Account ID ${accountId} already exists for provider ${provider}. Account.add does not permit silent overwrites.`)
      }

      providersOf(storage)[provider].accounts[accountId] = info
      debugCheckpoint("Account.add", "Added account", { accounts: Object.keys(providersOf(storage)[provider].accounts) })

      // If this is the first account, make it active
      if (!providersOf(storage)[provider].activeAccount) {
        providersOf(storage)[provider].activeAccount = accountId
        debugCheckpoint("Account.add", "Set as active account", { accountId })
      }

      await save(storage)
      debugCheckpoint("Account.add", "Save completed", { provider, accountId })
      log.info("Account added", { provider, accountId, type: info.type })

      // @event_20260319_daemonization Phase ε.3 — publish account.added
      await Bus.publish(Bus.AccountAdded, {
        providerKey: provider,
        accountId,
        info: sanitizeInfo(info),
      }).catch(() => {})
    })
  }

  /**
   * Update an existing account
   */
  export function update(provider: string, accountId: string, info: Partial<Info>): Promise<void> {
    return withMutex(async () => {
      const storage = await state()
      const existing = providersOf(storage)[provider]?.accounts[accountId]

      if (!existing) {
        throw new Error(`Account not found: ${provider}/${accountId}`)
      }

      providersOf(storage)[provider].accounts[accountId] = { ...existing, ...info } as Info
      await save(storage)
    })
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

    for (const [provider, providerData] of Object.entries(providersOf(storage))) {
      for (const [accountId, info] of Object.entries(providerData.accounts)) {
        if (info.type !== "subscription") continue
        total++

        const sub = info as SubscriptionAccount
        const currentEmail = sub.email

        // Check if email is missing, is a UUID, or doesn't contain @
        const needsRepair = !currentEmail || JWT.isUUID(currentEmail) || !currentEmail.includes("@")

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
          providersOf(storage)[provider].accounts[accountId] = {
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
   * Remove an account.
   *
   * For codex-family subscription accounts, this also revokes the refresh
   * token upstream (`https://auth.openai.com/oauth/revoke`) BEFORE deleting
   * the local entry — fail-closed per AGENTS.md 第一條. If the upstream
   * revoke call errors, the local credentials stay in place and the error
   * propagates so the operator can retry.
   * (@plans/provider-hotfix Phase 1)
   */
  export function remove(provider: string, accountId: string): Promise<void> {
    return withMutex(async () => {
      const storage = await state()

      const info = providersOf(storage)[provider]?.accounts[accountId]
      if (!info) {
        return
      }

      // Upstream revoke before local teardown (codex family only).
      if (provider === "codex" && info.type === "subscription") {
        const { logoutCodex } = await import("../plugin/codex-auth")
        // logoutCodex is fail-closed: throws on revoke failure, we preserve
        // local state by letting the throw propagate before the delete below.
        await logoutCodex(info.refreshToken, { accountId })
      }

      delete providersOf(storage)[provider].accounts[accountId]

      // If we removed the active account, pick another
      if (providersOf(storage)[provider].activeAccount === accountId) {
        const remaining = Object.keys(providersOf(storage)[provider].accounts)
        providersOf(storage)[provider].activeAccount = remaining[0]
      }

      await save(storage)
      log.info("Account removed", { provider, accountId })

      // @event_20260319_daemonization Phase ε.4 — publish account.removed
      await Bus.publish(Bus.AccountRemoved, { providerKey: provider, accountId }).catch(() => {})
    })
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
    const accounts = providersOf(storage)[provider]?.accounts
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
        if (providersOf(storage)[provider].activeAccount === idToRemove) {
          providersOf(storage)[provider].activeAccount = ids[0]
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
  export function setActive(provider: string, accountId: string): Promise<void> {
    return withMutex(async () => {
      const storage = await state()

      if (!providersOf(storage)[provider]?.accounts[accountId]) {
        throw new Error(`Account not found: ${provider}/${accountId}`)
      }

      const previousAccountId = providersOf(storage)[provider].activeAccount
      providersOf(storage)[provider].activeAccount = accountId
      await save(storage)
      log.info("Active account changed", { provider, accountId })

      // @event_20260319_daemonization Phase ε.5 — publish account.activated
      await Bus.publish(Bus.AccountActivated, {
        providerKey: provider,
        accountId,
        previousAccountId: previousAccountId !== accountId ? previousAccountId : undefined,
      }).catch(() => {})
    })
  }

  /**
   * Get the active account ID for a provider
   */
  export async function getActive(provider: string): Promise<string | undefined> {
    const storage = await state()
    return providersOf(storage)[provider]?.activeAccount
  }

  /**
   * Get the active account info for a provider
   */
  export async function getActiveInfo(provider: string): Promise<Info | undefined> {
    const storage = await state()
    const activeId = providersOf(storage)[provider]?.activeAccount
    debugCheckpoint("account", "getActiveInfo", {
      provider,
      activeId,
      hasProviderEntry: !!providersOf(storage)[provider],
      providerKeys: providerKeysOf(storage),
    })
    if (!activeId) return undefined
    const info = providersOf(storage)[provider]?.accounts[activeId]
    debugCheckpoint("account", "getActiveInfo result", {
      provider,
      activeId,
      hasInfo: !!info,
      infoType: info?.type,
    })
    return info
  }

  /**
   * Get a short, readable version of an account ID.
   * Removes provider and type prefixes if present.
   */
  export function getShortId(id: string, provider: string): string {
    if (!id) return id
    // Pattern: {provider}-subscription-{name}
    const subPrefix = `${provider}-subscription-`
    if (id.startsWith(subPrefix)) return id.slice(subPrefix.length)

    const apiPrefix = `${provider}-api-`
    if (id.startsWith(apiPrefix)) return id.slice(apiPrefix.length)

    // Fallback for cases where it might be provider-name
    if (id.startsWith(`${provider}-`)) return id.slice(provider.length + 1)

    return id
  }

  /**
   * Generate a unique account ID.
   * Format: {provider}-{type}-{suffix} to allow parseProvider() to resolve the family.
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
   *
   * @internal:migration-only
   *
   * Recovers a family from a legacy per-account providerId. Kept ONLY for the
   * one-shot migration script (specs/provider-account-decoupling/ DD-9).
   * Runtime dispatch MUST NOT call this — carry family + accountId as
   * separate dimensions instead.
   */
  export function parseProvider(accountId: string): string | undefined {
    if (!accountId || typeof accountId !== "string") return undefined
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

    return undefined
  }

  /** @deprecated Use parseProvider instead */
  export const parseFamily = parseProvider

  /**
   * Smartly get a display name for an account info
   * WYSIWYG: Always prefer email for identification
   */
  export function getDisplayName(id: string, info: Info, provider: string): string {
    const { JWT } = require("../util/jwt") // Lazy import to avoid cycle if any

    // 1. Try JWT Decoding (OpenAI / Google OAuth)
    let email =
      info.type === "subscription" ? (info.accessToken ? JWT.getEmail(info.accessToken) : info.email) : undefined
    if (!email && info.type === "subscription" && info.refreshToken) email = JWT.getEmail(info.refreshToken)

    // 2. Check accountId and name fields for email patterns
    if (!email || email === provider) {
      if (info.type === "subscription" && info.accountId && info.accountId.includes("@")) email = info.accountId
      else if (info.name && info.name.includes("@")) email = info.name
    }

    // 3. If we have an email, use it
    if (email && email !== provider && email.includes("@")) {
      return email
    }

    // 4. For API accounts, the name field should be the user-provided name
    if (info.type === "api" && info.name && info.name !== provider) {
      // Check if name looks useful (not just the provider name repeated)
      const isUseful = info.name !== provider && !info.name.startsWith(`${provider}-`) && !JWT.isUUID(info.name)
      if (isUseful) return info.name
    }

    // 5. For subscription accounts, try accountId or username
    if (info.type === "subscription") {
      const sub = info as SubscriptionAccount
      if (sub.accountId && sub.accountId !== provider && !JWT.isUUID(sub.accountId)) {
        return sub.accountId
      }
    }

    // 6. Extract meaningful part from account ID if it looks like {provider}-{type}-{name}
    const idMatch = id.match(/^[^-]+-(?:api|subscription)-(.+)$/)
    if (idMatch && idMatch[1] && idMatch[1] !== provider) {
      // Convert dashes back to something readable
      const extracted = idMatch[1].replace(/-/g, " ")
      if (extracted !== provider && !JWT.isUUID(extracted)) {
        return extracted
      }
    }

    // 7. Fallback - at least show something other than raw ID
    if (info.name && info.name !== provider && info.name !== "Default") return info.name

    // 8. Last resort: generate a short label
    const shortId = id.split("-").pop() || id
    if (shortId !== provider && shortId !== "default" && shortId !== "cli") return shortId

    // 9. If everything else fails or is redundant, return a clean label
    return getProviderLabel(provider)
  }

  /**
   * Get a friendly display label for a provider ID
   */
  export function getProviderLabel(provider: string): string {
    const map: Record<string, string> = {
      "google-api": "google-api",
      openai: "openai",
      "claude-cli": "claude-cli",
      "gemini-cli": "gemini-cli",
      opencode: "opencode",
      gitlab: "gitlab",
      "github-copilot": "github-copilot",
    }
    return map[provider] || provider
  }

  async function migrateToV2(storage: any): Promise<Storage> {
    log.info("Migrating accounts.json to v2...")
    if (storage.families.google && storage.families.google.accounts) {
      const googleAccounts = storage.families.google.accounts
      const geminiCliAccounts: Record<string, any> = {}
      const remainingGoogleAccounts: Record<string, any> = {}

      for (const [id, account] of Object.entries(googleAccounts as Record<string, any>)) {
        let moved = false
        // Clue for gemini-cli: rate limits or specific fields
        const isGeminiCli = Object.keys(account.rateLimitResetTimes || {}).some((k) => k.startsWith("gemini-cli"))

        if (isGeminiCli) {
          const newId = id.replace(/^google-/, "gemini-cli-")
          geminiCliAccounts[newId] = { ...account }
          moved = true
        } else {
          remainingGoogleAccounts[id] = account
        }
      }

      if (Object.keys(geminiCliAccounts).length > 0) {
        storage.families["gemini-cli"] = {
          accounts: geminiCliAccounts,
          activeAccount: Object.keys(geminiCliAccounts)[0],
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
    //   - Google OAuth: skip (handled via provider-specific migration paths)
    //   - OpenAI OAuth: skip (comes from openai-codex-accounts.json)
    //   - claude-cli OAuth: migrate (no separate multi-account file)
    const authPath = path.join(Global.Path.data, "auth.json")
    const authFile = Bun.file(authPath)
    if (await authFile.exists()) {
      try {
        const authData = await authFile.json()
        for (const [providerId, auth] of Object.entries(authData)) {
          const provider = parseProviderFromLegacyId(providerId)
          if (!provider || !PROVIDERS.includes(provider as Provider)) continue

          if (!auth || typeof auth !== "object") continue
          const authInfo = auth as Record<string, unknown>
          if (authInfo.type === "api" && typeof authInfo.key === "string") {
            // Migrate all API keys
            if (!storage.families[provider]) {
              storage.families[provider] = { accounts: {} }
            }
            const accountId = generateId(provider, "api", providerId.replace(`${provider}-`, "") || "default")
            storage.families[provider].accounts[accountId] = {
              type: "api",
              name: providerId === provider ? "Default" : providerId.replace(`${provider}-`, ""),
              apiKey: authInfo.key,
              addedAt: Date.now(),
            }
            if (!storage.families[provider].activeAccount) {
              storage.families[provider].activeAccount = accountId
            }
            hasMigrated = true
          } else if (authInfo.type === "oauth" && typeof authInfo.refresh === "string") {
            // Only migrate OAuth for providers without separate multi-account files
            // Google and OpenAI have their own account files
            if (provider === "google" || provider === "google-api" || provider === "openai") {
              continue // Skip - will be migrated from codex account files or dedicated flows
            }

            if (!storage.families[provider]) {
              storage.families[provider] = { accounts: {} }
            }
            const accountId = generateId(
              provider,
              "subscription",
              (typeof authInfo.accountId === "string" ? authInfo.accountId : undefined) ||
                providerId.replace(`${provider}-`, "") ||
                "default",
            )
            storage.families[provider].accounts[accountId] = {
              type: "subscription",
              name: (typeof authInfo.accountId === "string" ? authInfo.accountId : undefined) || providerId,
              email: typeof authInfo.accountId === "string" ? authInfo.accountId : undefined,
              refreshToken: authInfo.refresh,
              accessToken: typeof authInfo.access === "string" ? authInfo.access : undefined,
              expiresAt: typeof authInfo.expires === "number" ? authInfo.expires : undefined,
              accountId: typeof authInfo.accountId === "string" ? authInfo.accountId : undefined,
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

    // 2. Migrate from openai-codex-accounts.json (if exists)
    // @event_2026-02-07_install: align legacy codex storage to XDG config
    const codexPath = path.join(Global.Path.config, "openai-codex-accounts.json")
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
  function parseProviderFromLegacyId(providerId: string): string | undefined {
    if (!providerId) return undefined

    // Prefer canonical known providers using longest-prefix match.
    const sorted = [...PROVIDERS].sort((a, b) => b.length - a.length)
    for (const provider of sorted) {
      if (providerId === provider || providerId.startsWith(`${provider}-`)) {
        return provider
      }
    }

    return undefined
  }

  export type NormalizeIdentitiesReport = {
    changed: boolean
    moves: Array<{ from: string; to: string; accountCount: number }>
    familiesBefore: string[]
    familiesAfter: string[]
  }

  export async function normalizeIdentities(): Promise<NormalizeIdentitiesReport> {
    const storage = await state()
    const familiesBefore = Object.keys(storage.families)
    const normalized = await normalizeProviderKeys(storage)
    if (normalized.changed) {
      await save(storage)
      _storage = storage
      _mtime = await getDiskMtime()
    }

    return {
      changed: normalized.changed,
      moves: normalized.moves,
      familiesBefore,
      familiesAfter: Object.keys(storage.families),
    }
  }

  /**
   * Refresh the state (reload from disk)
   */
  export async function refresh(): Promise<void> {
    _storage = await load()
    _mtime = await getDiskMtime()
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

      for (const [providerId, auth] of Object.entries(authData as Record<string, any>)) {
        const provider = parseProviderFromLegacyId(providerId)
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
   * @param provider Provider ID (e.g., "openai", "anthropic", "gemini-cli")
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
      const infoWithUsage = info as Info & { lastUsed?: number }
      const lastUsed = infoWithUsage.type === "subscription" ? (infoWithUsage.lastUsed ?? 0) : 0
      candidates.push({
        id,
        lastUsed,
        healthScore: healthTracker.getScore(id, provider),
        isRateLimited: rateLimitTracker.isRateLimited(id, provider, model),
        isCoolingDown:
          info.type === "subscription" && info.coolingDownUntil ? Date.now() < info.coolingDownUntil : false,
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
  export async function recordSuccess(accountId: string, provider: string, model?: string): Promise<void> {
    const { getHealthTracker } = await import("./rotation")
    getHealthTracker().recordSuccess(accountId, provider, model)
    log.debug("Recorded success", { accountId, provider, model })
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

    healthTracker.recordRateLimit(accountId, provider, model)
    rateLimitTracker.markRateLimited(accountId, provider, reason as RateLimitReason, backoffMs, model)

    log.info("Recorded rate limit", { accountId, provider, reason, backoffMs, model })
  }

  /**
   * Record a failure for an account.
   * Reduces health score more significantly than rate limits.
   */
  export async function recordFailure(accountId: string, provider: string, model?: string): Promise<void> {
    const { getHealthTracker } = await import("./rotation")
    getHealthTracker().recordFailure(accountId, provider, model)
    log.warn("Recorded failure", { accountId, provider, model })
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
   * Clear cooldown for a specific account under a provider.
   * Resets rate limit tracker state, daily failure counters, and health score.
   */
  export async function clearAccountCooldown(provider: string, accountId: string): Promise<void> {
    const rotation = await import("./rotation")
    const rateLimitTracker = rotation.getRateLimitTracker()
    const healthTracker = rotation.getHealthTracker()

    // Clear all rate limits for this account (both provider-level and model-level)
    rateLimitTracker.clear(accountId, provider)

    // Also clear model-specific entries by reading snapshot
    const snapshot = rateLimitTracker.getSnapshot3D()
    for (const entry of snapshot) {
      if (entry.accountId === accountId && entry.providerId === provider && entry.modelID) {
        rateLimitTracker.clear(accountId, provider, entry.modelID)
      }
    }

    // Reset health score
    healthTracker.recordSuccess(accountId, provider)

    // Clear daily failure counters from unified state
    const { readUnifiedState, writeUnifiedState } = await import("./rotation/state")
    const unified = readUnifiedState()
    const keysToRemove = Object.keys(unified.dailyRateLimitCounts).filter(
      (k) => k.includes(accountId) && k.includes(provider),
    )
    for (const key of keysToRemove) {
      delete unified.dailyRateLimitCounts[key]
    }
    writeUnifiedState(unified)

    log.info("Cleared account cooldown", { provider, accountId })
  }

  /**
   * Get health and rate limit status for all accounts in a provider.
   * Useful for debugging and admin UI.
   */
  export async function getRotationStatus(provider: string): Promise<
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
        healthScore: healthTracker.getScore(id, provider),
        isRateLimited: rateLimitTracker.isRateLimited(id, provider),
        waitTimeMs: rateLimitTracker.getWaitTime(id, provider),
        consecutiveFailures: healthTracker.getConsecutiveFailures(id, provider),
      })
    }

    return result
  }
}
